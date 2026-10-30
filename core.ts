import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { redactMemorySecrets } from "@oh-my-pi/pi-coding-agent/memory-backend/redact";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { DEFAULT_CONFIG, nextEligibleAt, normalize, parseResponse, rankFactsForQuery, readConfig, searchFactsWithFts5, selectForInjection, staleCandidates, type MemoryConfig, type MemoryFact } from "./policy";
import { applyUpdate, enforceFactCapacity } from "./updates";
import { detectSignals, isTrivialAcknowledgement } from "./signals";
import { addPending, activeFacts, activeSummaries, inspectMemory, memoryFile, recordEvent, withMemory, type FileLocker, type MemoryDocument, type ProjectPending, type ReplaceFile } from "./store";
import extractionPrompt from "./memory-update.md" with { type: "text" };
import extractionInput from "./memory-update-input.md" with { type: "text" };

async function projectConfig(cwd: string, isEnoent: (error: unknown) => boolean): Promise<MemoryConfig> {
	try { const path = await memoryFile(cwd, isEnoent); return readConfig(await Bun.file(join(dirname(path), "config.json")).json()); }
	catch (error) { if (isEnoent(error)) return { ...DEFAULT_CONFIG }; throw error; }
}

function messageText(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(block => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string").map(block => (block as { text: string }).text).join("\n");
}

function isHumanClarificationResponse(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const response = value as Record<string, unknown>;
	const nonempty = (field: unknown) => typeof field === "string" && field.trim().length > 0;
	if (response.version !== 1 || response.kind !== "human_input_response" || !nonempty(response.source) || !nonempty(response.request_id) || !nonempty(response.value)) return false;
	return response.response_kind === "text" || (response.response_kind === "option" && nonempty(response.option_id));
}

function promptBatchItems(items: ProjectPending[]): ProjectPending[] {
	return items.map(item => {
		const match = /^(user|assistant):\s*/u.exec(item.text);
		if (!match) return item;
		const content = item.text.slice(match[0].length);
		const shortened = content.length > 1000 ? `${content.slice(0, 500)}\n...[truncated]...\n${content.slice(-500)}` : content;
		return { ...item, text: `${match[1]}: ${shortened}` };
	});
}

function enqueue(memory: MemoryDocument, sessionId: string, messages: Array<{ role?: string; content?: unknown; timestamp?: unknown; stopReason?: string; synthetic?: boolean; attribution?: string; hide_from_ui?: boolean; hideFromUi?: boolean; additional_kwargs?: Record<string, unknown> }>, config: MemoryConfig, urgent = false): number {
	const timestamps = messages.map(message => typeof message.timestamp === "number" ? message.timestamp : 0).filter(value => value > 0);
	const newest = Math.max(...timestamps, 0);
	const watermark = memory.watermarks[sessionId] ?? { timestamp: 0, lastSeen: 0 };
	const signals = detectSignals(messages.filter(message => message.role === "user" && typeof message.timestamp === "number" && message.timestamp > watermark.timestamp).map(message => ({ text: `user: ${messageText(message)}` })), config.signalPatterns);
	const allowOverflow = urgent || signals.length > 0;
	const hasPendingContext = memory.pending.some(item => item.sessionId === sessionId);
	const queueFull = config.queueMaxDepth > 0 && !hasPendingContext && new Set(memory.pending.map(item => item.sessionId)).size >= config.queueMaxDepth && !allowOverflow;
	let advancedTimestamp = watermark.timestamp;
	let dropped = 0;
	let blockedByBackpressure = false;
	let skipAssistantAfterTrivialUser = false;
	for (const message of messages) {
		if (typeof message.timestamp !== "number") continue;
		if (blockedByBackpressure) continue;
		if (message.role !== "user" && (message.role !== "assistant" || message.stopReason !== "stop")) continue;
		if (message.role === "user" && (message.synthetic || message.attribution === "agent")) continue;
		if (message.role === "user" && (message.hide_from_ui || message.hideFromUi || message.additional_kwargs?.hide_from_ui) && !isHumanClarificationResponse(message.additional_kwargs?.human_input_response)) continue;
		if (message.role === "assistant" && Array.isArray(message.content) && message.content.some(block => block && typeof block === "object" && "type" in block && block.type === "toolCall")) continue;
		let text = messageText(message).trim();
		if (message.role === "user" && /<current_uploads>/iu.test(text)) text = text.replace(/<current_uploads>[\s\S]*?<\/current_uploads>\n*/giu, "").trim();
		if (!text) {
			if (message.role === "user") skipAssistantAfterTrivialUser = true;
			advancedTimestamp = Math.max(advancedTimestamp, message.timestamp);
			continue;
		}
		if (message.role === "user") {
			skipAssistantAfterTrivialUser = isTrivialAcknowledgement(text, config.signalPatterns);
			if (skipAssistantAfterTrivialUser) { advancedTimestamp = Math.max(advancedTimestamp, message.timestamp); continue; }
		} else if (skipAssistantAfterTrivialUser) {
			skipAssistantAfterTrivialUser = false;
			advancedTimestamp = Math.max(advancedTimestamp, message.timestamp);
			continue;
		}
		const id = createHash("sha256").update(JSON.stringify([sessionId, message.role, message.timestamp, text])).digest("hex");
		if (message.timestamp <= watermark.timestamp) {
			if (urgent) addPending(memory, sessionId, id, message.role!, text, true);
			continue;
		}
		if (queueFull && !memory.pending.some(item => item.id === id)) { dropped++; blockedByBackpressure = true; continue; }
		addPending(memory, sessionId, id, message.role!, text, urgent);
		advancedTimestamp = Math.max(advancedTimestamp, message.timestamp);
	}
	watermark.timestamp = Math.max(advancedTimestamp, dropped ? watermark.timestamp : newest);
	watermark.lastSeen = Date.now();
	memory.watermarks[sessionId] = watermark;
	const entries = Object.entries(memory.watermarks).sort((left, right) => left[1].lastSeen - right[1].lastSeen);
	while (entries.length > 4096) { const oldest = entries.shift(); if (oldest) delete memory.watermarks[oldest[0]]; }
	return dropped;
}

function pendingGroups(memory: MemoryDocument, config: MemoryConfig): Array<{ id: string; items: ProjectPending[]; allItems: ProjectPending[]; ready: boolean; deadline: number }> {
	const grouped = new Map<string, ProjectPending[]>();
	for (const item of memory.pending) { const group = grouped.get(item.sessionId) ?? []; group.push(item); grouped.set(item.sessionId, group); }
	return [...grouped].map(([id, allItems]) => {
		const items: ProjectPending[] = [];
		let awaitingAssistant = false;
		for (const item of allItems) {
			const text = item.text.replace(/^(?:user|assistant):\s*/u, "");
			if (isTrivialAcknowledgement(text, config.signalPatterns)) continue;
			if (item.text.startsWith("user: ")) { items.push(item); awaitingAssistant = true; }
			else if (item.text.startsWith("assistant: ") && awaitingAssistant) { items.push(item); awaitingAssistant = false; }
		}
		const first = Math.min(...allItems.map(item => item.queuedAt)); const last = Math.max(...allItems.map(item => item.queuedAt));
		const hasUser = items.some(item => item.text.startsWith("user: ")); const hasAssistant = items.some(item => item.text.startsWith("assistant: "));
		return { id, items, allItems, ready: hasUser && hasAssistant, deadline: allItems.some(item => item.urgent) ? 0 : nextEligibleAt(first, last, config) };
	}).sort((a, b) => a.deadline - b.deadline);
}

export type MemoryCompletionResult = { text: string; stopReason: string; contentTypes: string[]; errorMessage?: string; errorClassificationMessage?: string; errorStatus?: number };
export type MemoryCompletion = (ctx: ExtensionContext, systemPrompt: string, inputText: string) => Promise<MemoryCompletionResult>;

export function createProjectMemory(pi: ExtensionAPI, countTokens: (text: string) => number, renderPrompt: (template: string, context: Record<string, string>) => string, isEnoent: (error: unknown) => boolean, lock: FileLocker, replaceFile: ReplaceFile, completeMemory: MemoryCompletion): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let rerunContext: ExtensionContext | undefined;
	const injectionSnapshots = new Map<string, { text: string; tokens: number; selected: number; omitted: number; summariesSelected: number; capturedAt: string }>();
	const read = (ctx: ExtensionContext) => inspectMemory(ctx.cwd, memory => memory, lock, isEnoent, replaceFile);
	const update = <T,>(ctx: ExtensionContext, operation: (memory: MemoryDocument) => T | Promise<T>): Promise<T> => withMemory(ctx.cwd, operation, lock, isEnoent, replaceFile);

	async function flush(ctx: ExtensionContext, force = false): Promise<void> {
		if (running) { rerunContext = ctx; if (force) ctx.ui.notify("项目记忆正在处理，结束后会继续检查队列", "info"); return; }
		if (!ctx.model) { ctx.ui.notify("当前 OMP 会话没有活动模型，待处理消息已保留。", "warning"); return; }
		const config = await projectConfig(ctx.cwd, isEnoent);
		const snapshot = await read(ctx);
		const group = pendingGroups(snapshot, config).find(item => item.ready && (force || item.deadline <= Date.now()));
		if (!group) { if (force) ctx.ui.notify("没有到期的项目记忆批次", "info"); return; }
		running = true;
		let succeeded = false;
		try {
			const facts = activeFacts(snapshot);
			const summaries = activeSummaries(snapshot);
			const stale = staleCandidates(facts, config, Date.now());
			const promptItems = promptBatchItems(group.items);
			const hints = detectSignals(promptItems, config.signalPatterns);
			const systemPrompt = renderPrompt(extractionPrompt, { confidenceThreshold: String(config.confidenceThreshold) });
			const inputText = renderPrompt(extractionInput, {
				facts: escapeXmlText(JSON.stringify(facts)), summaries: escapeXmlText(JSON.stringify(summaries)), pending: escapeXmlText(JSON.stringify(promptItems)),
				stale: escapeXmlText(JSON.stringify(stale)), hints: escapeXmlText(JSON.stringify(hints)), consolidationEnabled: String(config.consolidationEnabled),
			});
			const completion = await completeMemory(ctx, systemPrompt, inputText);
			if (completion.stopReason === "error" || completion.errorMessage) {
				const detail = completion.errorClassificationMessage ?? completion.errorMessage ?? "provider returned an error";
				const status = completion.errorStatus === undefined ? "" : ` HTTP ${completion.errorStatus}`;
				throw new Error(`模型请求失败${status}: ${redactMemorySecrets(detail)}`);
			}
			if (!completion.text.trim()) throw new Error(`模型未返回文本 (stop=${completion.stopReason}, blocks=${completion.contentTypes.join(",") || "none"})`);
			let response: Record<string, unknown>;
			try { response = parseResponse(completion.text); }
			catch (error) { throw new Error(`${String(error)} (stop=${completion.stopReason}, text=${completion.text.length} chars, blocks=${completion.contentTypes.join(",") || "none"})`); }
			const result = await update(ctx, memory => {
				const outcome = applyUpdate(memory, response, group.items.map(item => item.id), group.id, config, new Set(stale.map(fact => fact.id)), summaries);
				if (outcome.skipped) return outcome;
				const done = new Set(group.allItems.map(item => item.id));
				memory.pending = memory.pending.filter(item => !done.has(item.id));
				return outcome;
			});
			succeeded = true;
			if (result.skipped) ctx.ui.notify("其他会话已处理该批消息，本次跳过", "info");
			else ctx.ui.notify(`项目记忆：摘要 ${result.summaries}、新增 ${result.added}、候选 ${result.candidates}、替换/撤销 ${result.replaced}、确认 ${result.reinforced}、待复核 ${result.review}、冲突 ${result.conflicts}、未采纳 ${result.rejected}、按置信度归档 ${result.evicted}`, "info");
		} catch (error) {
			ctx.ui.notify(`项目记忆更新失败，待下次重试：${String(error)}`, "warning");
		} finally {
			running = false;
			if (succeeded) await schedule(rerunContext ?? ctx);
			rerunContext = undefined;
		}
	}

	async function schedule(ctx: ExtensionContext): Promise<void> {
		if (timer) ctx.clearTimer(timer);
		const config = await projectConfig(ctx.cwd, isEnoent);
		const memory = await read(ctx);
		const group = pendingGroups(memory, config).find(item => item.ready);
		if (!group) return;
		timer = ctx.setTimeout(() => { void flush(ctx).catch(error => ctx.ui.notify(`项目记忆队列失败：${String(error)}`, "warning")); }, Math.max(0, group.deadline - Date.now()));
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const config = await projectConfig(ctx.cwd, isEnoent);
		const memory = await read(ctx);
		if (activeFacts(memory).length > config.maxFacts) await update(ctx, data => enforceFactCapacity(data, config, ctx.sessionManager.getSessionId()));
		await schedule(ctx);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind !== "main" || event.reason === "revive") return;
		const config = await projectConfig(ctx.cwd, isEnoent); const memory = await read(ctx);
		const facts = activeFacts(memory); const summaries = activeSummaries(memory);
		const conflicts = memory.conflicts.filter(pair => facts.some(fact => fact.id === pair.factId) && facts.some(fact => fact.id === pair.otherId)).map(pair => ({ fact_id: pair.factId, other_id: pair.otherId }));
		const selected = selectForInjection(facts, config, countTokens, conflicts, summaries, event.prompt);
		injectionSnapshots.set(ctx.sessionManager.getSessionId(), { ...selected, capturedAt: new Date().toISOString() });
		if (!selected.text) return;
		return { systemPrompt: [...event.systemPrompt, selected.text] };
	});
	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const config = await projectConfig(ctx.cwd, isEnoent);
		const dropped = await update(ctx, memory => enqueue(memory, ctx.sessionManager.getSessionId(), event.messages, config));
		if (dropped) ctx.ui.notify(`项目记忆队列已满，暂缓 ${dropped} 条非信号消息`, "warning");
		await schedule(ctx);
	});
	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const config = await projectConfig(ctx.cwd, isEnoent);
		await update(ctx, memory => enqueue(memory, ctx.sessionManager.getSessionId(), event.branchEntries.filter(entry => entry.type === "message").map(entry => entry.message), config, true));
		await schedule(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => { if (timer) ctx.clearTimer(timer); });
	pi.registerCommand("project-memory", {
		description: "项目记忆：status、show、injected、history、events、search、candidates、review、sync、add、update、approve、keep、forget",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/); const sessionId = ctx.sessionManager.getSessionId();
			if (action === "injected") {
				const snapshot = injectionSnapshots.get(sessionId);
				if (!snapshot) { ctx.ui.notify("当前会话尚无项目记忆注入快照；请先正常发送一条消息。快照仅在当前 OMP 进程内保存。", "info"); return; }
				ctx.ui.notify(`项目记忆注入快照（本扩展最近一次提交给 OMP）\n时间：${snapshot.capturedAt}\n摘要 ${snapshot.summariesSelected} 条；事实 ${snapshot.selected} 条；未注入事实 ${snapshot.omitted} 条；约 ${snapshot.tokens} token\n\n${snapshot.text || "本轮没有注入项目记忆。"}`, "info");
				return;
			}
			if (action === "sync") { await flush(ctx, true); return; }
			if (action === "add" && rest.length) {
				const config = await projectConfig(ctx.cwd, isEnoent);
				const content = redactMemorySecrets(rest.join(" "));
				const result = await update(ctx, memory => {
					if (activeFacts(memory).some(fact => normalize(fact.content) === normalize(content))) return { added: false, evicted: 0 };
					const now = new Date().toISOString();
					const fact: MemoryFact = { id: randomUUID(), content, category: "manual", confidence: 1, source: sessionId, created_at: now, status: "active", superseded_by: null, expected_valid_days: null, confirmed_at: now, reviewed_at: null, review_status: null, review_reason: null, source_error: null };
					memory.facts.push(fact); recordEvent(memory, fact.id, "manual_add", sessionId);
					return { added: true, evicted: enforceFactCapacity(memory, config, sessionId) };
				});
				ctx.ui.notify(result.added ? `项目记忆已保存${result.evicted ? `；按置信度归档 ${result.evicted} 条` : ""}` : "已有相同的有效记忆", "info"); return;
			}
			if (action === "update" && rest.length > 1) {
				const config = await projectConfig(ctx.cwd, isEnoent);
				const result = await update(ctx, memory => {
					const old = activeFacts(memory).find(fact => fact.id === rest[0]); if (!old) return { updated: false, evicted: 0 };
					const content = redactMemorySecrets(rest.slice(1).join(" ")); const existing = activeFacts(memory).find(fact => normalize(fact.content) === normalize(content));
					if (existing?.id === old.id) return { updated: false, evicted: 0 };
					const id = existing?.id ?? randomUUID(); const now = new Date().toISOString();
					if (!existing) memory.facts.push({ id, content, category: old.category, confidence: 1, source: sessionId, created_at: now, status: "active", superseded_by: null, expected_valid_days: old.expected_valid_days, confirmed_at: now, reviewed_at: null, review_status: null, review_reason: null, source_error: null });
					old.status = "superseded"; old.superseded_by = id; recordEvent(memory, old.id, "manual_replace", sessionId, `replacement: ${id}`);
					return { updated: true, evicted: enforceFactCapacity(memory, config, sessionId) };
				});
				ctx.ui.notify(result.updated ? `项目记忆已更新，旧记录已保留${result.evicted ? `；按置信度归档 ${result.evicted} 条` : ""}` : "未找到可更新的事实或内容没有变化", "info"); return;
			}
			if (action === "approve" && rest[0]) {
				const config = await projectConfig(ctx.cwd, isEnoent);
				const evicted = await update(ctx, memory => {
					const candidate = memory.facts.find(fact => fact.id === rest[0] && fact.status === "candidate"); if (!candidate) throw new Error("未找到候选记忆");
					if (activeFacts(memory).some(fact => normalize(fact.content) === normalize(candidate.content))) throw new Error("已有相同的有效记忆，请手动处理候选");
					const links = candidate.replacementCandidates ?? []; if (links.some(link => !activeFacts(memory).some(fact => fact.id === link.oldId))) throw new Error("候选依赖的旧记忆已变化，请重新检查");
					candidate.status = "active"; recordEvent(memory, candidate.id, "approve", sessionId);
					for (const link of links) { const old = memory.facts.find(fact => fact.id === link.oldId)!; old.status = "superseded"; old.superseded_by = candidate.id; recordEvent(memory, old.id, "candidate_replace", sessionId, link.reason); }
					return enforceFactCapacity(memory, config, sessionId, new Set([candidate.id]));
				});
				ctx.ui.notify(`候选记忆已确认${evicted ? `；按置信度归档 ${evicted} 条` : ""}`, "info"); return;
			}
			if (action === "keep" && rest[0]) {
				const kept = await update(ctx, memory => { const fact = activeFacts(memory).find(item => item.id === rest[0]); if (!fact) return false; fact.review_status = null; fact.review_reason = null; fact.reviewed_at = new Date().toISOString(); fact.confirmed_at = fact.reviewed_at; recordEvent(memory, fact.id, "manual_keep", sessionId); return true; });
				ctx.ui.notify(kept ? "已保留并重置复核时间" : "未找到活动记忆", "info"); return;
			}
			if (action === "forget" && rest[0]) {
				const forgotten = await update(ctx, memory => { const fact = memory.facts.find(item => item.id === rest[0] && ["active", "candidate"].includes(item.status)); if (!fact) return false; fact.status = "archived"; recordEvent(memory, fact.id, "manual_archive", sessionId); return true; });
				ctx.ui.notify(forgotten ? "已归档匹配的项目记忆" : "未找到活动或候选记忆", "info"); return;
			}
			const config = await projectConfig(ctx.cwd, isEnoent); const memory = await read(ctx); const facts = activeFacts(memory); const summaries = activeSummaries(memory);
			if (action === "show") { ctx.ui.notify(JSON.stringify({ project: memory.project, history: memory.history, facts, conflicts: memory.conflicts }, null, 2), "info"); return; }
			if (action === "history") { ctx.ui.notify(JSON.stringify({ facts: memory.facts.filter(fact => ["superseded", "archived"].includes(fact.status)), summaries: [...Object.entries(memory.project), ...Object.entries(memory.history)] }, null, 2), "info"); return; }
			if (action === "events") { ctx.ui.notify(JSON.stringify(memory.events, null, 2), "info"); return; }
			if (action === "search" && rest.length) {
				const query = rest.join(" ");
				const ranked = config.retrievalRelevanceEnabled
					? rankFactsForQuery(facts, query, config.retrievalRelevanceWeight, config.retrievalDiversityWeight).slice(0, 5)
					: await searchFactsWithFts5(facts, query, 5, join(dirname(await memoryFile(ctx.cwd, isEnoent)), "retrieval", "facts.sqlite"), lock);
				ctx.ui.notify(JSON.stringify(ranked, null, 2), "info"); return;
			}
			if (action === "candidates") { ctx.ui.notify(JSON.stringify(facts.filter(fact => fact.status === "candidate").concat(memory.facts.filter(fact => fact.status === "candidate")), null, 2), "info"); return; }
			if (action === "review") { ctx.ui.notify(JSON.stringify(facts.filter(fact => fact.review_status === "pending"), null, 2), "info"); return; }
			const conflicts = memory.conflicts.filter(pair => facts.some(fact => fact.id === pair.factId) && facts.some(fact => fact.id === pair.otherId)).map(pair => ({ fact_id: pair.factId, other_id: pair.otherId }));
			const selected = selectForInjection(facts, config, countTokens, conflicts, summaries);
			ctx.ui.notify(`项目记忆 ${facts.length}/${config.maxFacts} 条；摘要 ${summaries.length} 条；候选 ${memory.facts.filter(fact => fact.status === "candidate").length} 条；待处理消息 ${memory.pending.length} 条；注入 ${selected.summariesSelected} 条摘要、${selected.selected} 条事实，约 ${selected.tokens}/${config.injectionTokens} token，未注入 ${selected.omitted} 条事实`, "info");
		},
	});
}
