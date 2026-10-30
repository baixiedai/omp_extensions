import { randomUUID } from "node:crypto";
import { redactMemorySecrets } from "@oh-my-pi/pi-coding-agent/memory-backend/redact";
import { nearDuplicate, normalize, staleCandidates, type MemoryConfig, type MemoryFact, type MemorySummary } from "./policy";
import { recordEvent, type MemoryDocument } from "./store";

type Item = Record<string, unknown>;
type Outcome = { summaries: number; added: number; candidates: number; replaced: number; reinforced: number; review: number; conflicts: number; rejected: number; evicted: number; skipped: boolean };

function list(data: Item, key: string): unknown[] {
	const value = data[key];
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`记忆更新字段 ${key} 必须是数组`);
	return value;
}
function object(value: unknown): Item | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Item : null;
}
function nonempty(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
function validConfidence(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function validDays(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function enforceFactCapacity(data: MemoryDocument, config: MemoryConfig, source: string, protectedIds: ReadonlySet<string> = new Set()): number {
	const active = data.facts.filter(fact => fact.status === "active");
	const excess = active.length - config.maxFacts;
	if (excess <= 0) return 0;
	const evictionCandidates = active.filter(fact => !protectedIds.has(fact.id)).sort((a, b) => a.confidence - b.confidence || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
	if (evictionCandidates.length < excess) throw new Error("项目记忆容量已满，无法保留指定的记忆");
	const evicted = new Set(evictionCandidates.slice(0, excess).map(fact => fact.id));
	for (const fact of active) if (evicted.has(fact.id)) recordEvent(data, fact.id, "capacity_evicted", source, `confidence: ${fact.confidence}; maxFacts: ${config.maxFacts}`);
	data.facts = data.facts.filter(fact => !evicted.has(fact.id));
	return excess;
}
function projectFact(value: unknown): Item | null {
	const item = object(value);
	if (!item || !nonempty(item.content)) return null;
	const confidence = typeof item.confidence === "string" && item.confidence.trim() ? Number(item.confidence) : item.confidence;
	if (!validConfidence(confidence) || item.scope !== "project" || item.durability !== "durable" || item.authority !== "descriptive") return null;
	return { ...item, confidence };
}

/** Apply a DeerFlow-shaped update to one JSON document. Throwing leaves the old document and queue intact. */
export function applyUpdate(data: MemoryDocument, update: Item, pendingIds: string[], sessionId: string, config: MemoryConfig, staleIds: Set<string>, previousSummaries: MemorySummary[]): Outcome {
	if (pendingIds.some(id => !data.pending.some(item => item.id === id))) return { summaries: 0, added: 0, candidates: 0, replaced: 0, reinforced: 0, review: 0, conflicts: 0, rejected: 0, evicted: 0, skipped: true };
	const proposed = list(update, "newFacts");
	const removals = list(update, "factsToRemove");
	const reinforcements = list(update, "factsToReinforce");
	const staleRemovals = list(update, "staleFactsToRemove");
	const staleExtensions = list(update, "staleFactsToExtend");
	const consolidations = list(update, "factsToConsolidate");
	const summaries = list(update, "summaryUpdates");
	const result: Outcome = { summaries: 0, added: 0, candidates: 0, replaced: 0, reinforced: 0, review: 0, conflicts: 0, rejected: 0, evicted: 0, skipped: false };
	const now = new Date().toISOString();
	const summarySections = new Set<string>();
	for (const raw of summaries) {
		const item = object(raw); const section = nonempty(item?.section); const summary = nonempty(item?.summary);
		if (!item || item.shouldUpdate !== true) continue;
		if (!section || !summary || !["projectContext", "ongoingFocus", "workingPatterns", "recentHistory", "longTermHistory"].includes(section) || item.scope !== "project" || item.authority !== "descriptive") { result.rejected++; continue; }
		if (summarySections.has(section)) throw new Error("同一摘要出现多个更新，待处理对话已保留");
		summarySections.add(section);
		const current = data.project[section] ?? data.history[section];
		const previous = previousSummaries.find(entry => entry.section === section);
		if ((current?.updatedAt ?? null) !== (previous?.created_at ?? null)) throw new Error("项目摘要已被其他会话修改，待处理对话已保留");
		const content = redactMemorySecrets(summary);
		if (current?.summary && normalize(current.summary) === normalize(content)) continue;
		const target = section.endsWith("History") ? data.history : data.project;
		target[section] = { summary: content, updatedAt: now };
		result.summaries++;
	}
	const inserted: Array<{ id: string } | null> = [];
	const removalTargets = new Set(removals.map(value => nonempty(object(value)?.id)).filter((id): id is string => id !== null));
	for (const raw of proposed) {
		const item = projectFact(raw);
		if (!item) { inserted.push(null); result.rejected++; continue; }
		const content = redactMemorySecrets(nonempty(item.content)!);
		const category = nonempty(item.category) ?? "other"; const confidence = item.confidence as number;
		if (confidence < config.confidenceThreshold) { inserted.push(null); result.rejected++; continue; }
		const facts = data.facts.filter(fact => fact.status === "active");
		const exact = facts.find(fact => normalize(fact.content) === normalize(content));
		const similar = !exact && config.nearDedupEnabled ? facts.find(fact => fact.category === category && !removalTargets.has(fact.id) && nearDuplicate(fact.content, content, config.nearDedupThreshold)) : undefined;
		const existing = exact ?? similar;
		if (existing) {
			if (similar && confidence > existing.confidence) { existing.confidence = confidence; existing.source = sessionId; recordEvent(data, existing.id, "near_duplicate", sessionId); }
			if (Array.isArray(item.conflicts)) for (const other of item.conflicts) {
				if (typeof other !== "string" || other === existing.id || !facts.some(fact => fact.id === other)) continue;
				if (!data.conflicts.some(pair => pair.factId === existing.id && pair.otherId === other)) { data.conflicts.push({ factId: existing.id, otherId: other, reason: "模型标记的待确认冲突", createdAt: now }); recordEvent(data, existing.id, "conflict", sessionId, `other: ${other}`); result.conflicts++; }
			}
			inserted.push({ id: existing.id }); continue;
		}
		const id = randomUUID();
		const sourceError = nonempty(item.sourceError);
		const fact: MemoryFact & { replacementCandidates?: Array<{ oldId: string; reason: string }> } = {
			id, content, category, confidence, source: sessionId, created_at: now, status: "active", superseded_by: null,
			expected_valid_days: validDays(item.expected_valid_days) ? Math.min(item.expected_valid_days, Math.floor(config.staleDays * config.staleMaxLifetimeMultiplier)) : null,
			confirmed_at: null, reviewed_at: null, review_status: null, review_reason: null,
			source_error: sourceError ? redactMemorySecrets(sourceError) : null,
		};
		data.facts.push(fact); inserted.push({ id });
		recordEvent(data, id, "extract", sessionId);
		result.added++;
		if (Array.isArray(item.conflicts)) for (const other of item.conflicts) {
			if (typeof other !== "string" || other === id || !facts.some(existingFact => existingFact.id === other)) continue;
			data.conflicts.push({ factId: id, otherId: other, reason: "模型标记的待确认冲突", createdAt: now }); recordEvent(data, id, "conflict", sessionId, `other: ${other}`); result.conflicts++;
		}
	}
	const replacementIds = new Set<string>();
	for (const raw of removals) {
		const removal = object(raw); const id = nonempty(removal?.id); const reason = nonempty(removal?.reason);
		if (!removal || !id || !reason || removal.scope !== "project") throw new Error("撤销建议缺少项目范围或原因，待处理对话已保留");
		const old = data.facts.find(fact => fact.id === id && fact.status === "active");
		if (!old) throw new Error("待替换记忆已变化，待处理对话已保留");
		if ("replacementFactIndex" in removal) {
			const index = removal.replacementFactIndex;
			if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= inserted.length) throw new Error("替换索引无效，待处理对话已保留");
			const replacement = inserted[index]; if (!replacement || replacement.id === id) continue;
			replacementIds.add(replacement.id);
			old.status = "superseded"; old.superseded_by = replacement.id; recordEvent(data, id, "superseded", sessionId, reason); result.replaced++;
		} else {
			old.status = "archived"; old.review_reason = redactMemorySecrets(reason); recordEvent(data, id, "retracted", sessionId, reason); result.replaced++;
		}
	}
	for (const raw of reinforcements) {
		const item = object(raw); const id = nonempty(item?.id);
		if (!id || item?.scope !== "project" || !nonempty(item.reason)) continue;
		const fact = data.facts.find(candidate => candidate.id === id && candidate.status === "active");
		if (fact) { fact.confirmed_at = now; recordEvent(data, id, "reinforced", sessionId, nonempty(item.reason)!); result.reinforced++; }
	}
	const stillStale = new Set(staleCandidates(data.facts, config, Date.now()).map(fact => fact.id));
	for (const raw of staleRemovals.slice(0, config.staleMaxRemovals)) {
		const item = object(raw); const id = nonempty(item?.id); const reason = nonempty(item?.reason);
		const index = data.facts.findIndex(candidate => candidate.id === id && candidate.status === "active");
		if (index >= 0 && id && reason && !replacementIds.has(id) && staleIds.has(id) && stillStale.has(id)) { data.facts.splice(index, 1); recordEvent(data, id, "stale_remove", sessionId, reason); result.review++; }
	}
	for (const raw of staleExtensions) {
		const item = object(raw); const id = nonempty(item?.id); const reason = nonempty(item?.reason);
		const fact = data.facts.find(candidate => candidate.id === id && candidate.status === "active");
		if (fact && id && reason && staleIds.has(id) && stillStale.has(id) && validDays(item?.extend_by_days)) {
			const reference = Date.parse(fact.confirmed_at ?? fact.created_at);
			const daysSinceReference = Number.isFinite(reference) ? Math.max(0, Math.floor((Date.now() - reference) / 86_400_000)) : 0;
			fact.reviewed_at = now;
			fact.expected_valid_days = Math.min(daysSinceReference + item.extend_by_days, config.staleMaxExtensionDays);
			fact.review_status = null; fact.review_reason = null; recordEvent(data, id, "review_extend", sessionId, reason);
		}
	}
	result.evicted = enforceFactCapacity(data, config, sessionId, replacementIds);
	if (config.consolidationEnabled) for (const raw of consolidations.slice(0, config.consolidationMaxGroups)) {
		const item = object(raw); const merged = projectFact(item?.consolidated); const ids = item?.sourceIds;
		if (!merged || merged.confidence < config.confidenceThreshold || !Array.isArray(ids) || ids.length < 2 || ids.length > config.consolidationMaxSources || !ids.every(id => typeof id === "string")) continue;
		const active = data.facts.filter(fact => fact.status === "active"); const category = nonempty(merged.category) ?? "other";
		if (new Set(ids).size !== ids.length || active.filter(fact => fact.category === category).length < config.consolidationMinFacts || !ids.every(id => active.some(fact => fact.id === id && fact.category === category))) continue;
		const content = redactMemorySecrets(nonempty(merged.content)!);
		if (active.some(fact => normalize(fact.content) === normalize(content))) continue;
		const id = randomUUID();
		data.facts.push({ id, content, category, confidence: merged.confidence, source: sessionId, created_at: now, status: "active", superseded_by: null, expected_valid_days: null, confirmed_at: null, reviewed_at: null, review_status: null, review_reason: null, source_error: null });
		recordEvent(data, id, "consolidate", sessionId);
		for (const oldId of ids) { const old = data.facts.find(fact => fact.id === oldId && fact.status === "active")!; old.status = "superseded"; old.superseded_by = id; recordEvent(data, oldId, "consolidated", sessionId, `replacement: ${id}`); }
		result.added++; result.replaced += ids.length;
	}
	return result;
}
