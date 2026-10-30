import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createProjectMemory as createMemory } from "./core";
import { DEFAULT_CONFIG, nearDuplicate, nextEligibleAt, parseResponse, readConfig, selectForInjection, staleCandidates, type MemoryFact } from "./policy";
import { detectSignals } from "./signals";
import { withMemory, type FileLocker, type MemoryDocument, type ReplaceFile } from "./store";

const dirs: string[] = [];
const lock: FileLocker = async (_path, fn) => fn();
const replaceFile: ReplaceFile = async (source, destination) => { await Bun.write(destination, await Bun.file(source).arrayBuffer()); await unlink(source); };
const missingFile = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
const createProjectMemory = (pi: ExtensionAPI, count: (text: string) => number) => createMemory(pi, count, (template, context) => template.replace(/\{\{\{(\w+)\}\}\}/g, (_match, key: string) => context[key] ?? ""), missingFile, lock, replaceFile, async (ctx, _systemPrompt, inputText) => {
	if (!ctx.runEphemeralTurn) throw new Error("test model stub is missing");
	const result = await ctx.runEphemeralTurn({ promptText: inputText, tools: false, dedupeReply: false, replyMaxBytes: Infinity });
	return { text: result.replyText, stopReason: "stop", contentTypes: ["text"] };
});
const withTestMemory = (cwd: string, update: (memory: MemoryDocument) => void) => withMemory(cwd, update, lock, missingFile, replaceFile);
const newProject = () => { const cwd = mkdtempSync(join(tmpdir(), "omp-project-memory-")); dirs.push(cwd); return cwd; };
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		const rel = relative(realpathSync(tmpdir()), realpathSync(dir));
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Temporary directory escaped its parent");
		rmSync(dir, { recursive: true });
	}
});

test("stores project facts, deduplicates compaction capture and preserves explicit replacement history", async () => {
	const cwd = newProject(); const handlers = new Map<string, Function>(); let command: Function = () => {}; const notices: string[] = []; const delays: number[] = [];
	let response = '{"newFacts":[{"content":"Use Python","category":"decision","confidence":0.9,"scope":"project","durability":"durable","authority":"descriptive"}]}';
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: (_fn: unknown, delay: number) => { delays.push(delay); return 1; }, clearTimer: () => {}, runEphemeralTurn: async () => ({ replyText: response }) };
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => Math.ceil(text.length / 4));
	await handlers.get("session_start")!({}, ctx);
	const message = { role: "user", content: "We use Python", timestamp: 1 };
	await handlers.get("agent_end")!({ messages: [message, { role: "user", content: "synthetic", synthetic: true, timestamp: 2 }, { role: "user", content: "agent message", attribution: "agent", timestamp: 3 }, { role: "assistant", content: "We use Python.", timestamp: 4, stopReason: "stop" }] }, ctx);
	await handlers.get("session_before_compact")!({ branchEntries: [{ type: "message", message }] }, ctx);
	expect(delays.at(-1)).toBe(0);
	await command("status", ctx); expect(notices.at(-1)).toContain("待处理消息 1 条");
	await command("sync", ctx);
	await command("show", ctx); let result = JSON.parse(notices.at(-1)!);
	expect(result.facts.map((fact: MemoryFact) => fact.content)).toEqual(["Use Python"]);
	const id = result.facts[0].id;
	response = JSON.stringify({ newFacts: [{ content: "Use Rust", category: "decision", confidence: 0.9, scope: "project", durability: "durable", authority: "descriptive" }], factsToRemove: [{ id, scope: "project", reason: "Explicit project decision", replacementFactIndex: 0 }] });
	await handlers.get("agent_end")!({ messages: [{ role: "user", content: "Use Rust instead", timestamp: 4 }, { role: "assistant", content: "I will use Rust.", timestamp: 5, stopReason: "stop" }] }, ctx); await command("sync", ctx);
	await command("show", ctx); result = JSON.parse(notices.at(-1)!);
	expect(result.facts.map((fact: MemoryFact) => fact.content)).toEqual(["Use Rust"]);
	await command("history", ctx); expect(JSON.parse(notices.at(-1)!).facts[0].superseded_by).toBe(result.facts[0].id);
	await handlers.get("session_shutdown")!({}, ctx);
});

test("reports captured injection text per session without recomputing from changed memory", async () => {
	const cwd = newProject(); const handlers = new Map<string, Function>(); let command: Function = () => {}; const notices: string[] = [];
	let sessionId = "session-a";
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: () => 1, clearTimer: () => {} };
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => text.length);
	await command("add Captured <UI> & theme", ctx);
	const injected = await handlers.get("before_agent_start")!({ reason: "prompt", prompt: "What is the theme?", systemPrompt: ["base"] }, ctx);
	const text = injected.systemPrompt[1] as string;
	expect(text).toContain("Captured &lt;UI&gt; &amp; theme");
	await command("add Added after injection", ctx);
	await command("injected", ctx);
	const captured = notices.at(-1)!;
	expect(captured.split("\n\n").slice(1).join("\n\n")).toBe(text);
	expect(captured).toContain(`约 ${text.length} token`);
	expect(captured).not.toContain("Added after injection");
	sessionId = "session-b";
	await command("injected", ctx);
	expect(notices.at(-1)).not.toContain(text);
	const other = await handlers.get("before_agent_start")!({ reason: "prompt", prompt: "What changed?", systemPrompt: ["base"] }, ctx);
	await command("injected", ctx);
	expect(notices.at(-1)!.split("\n\n").slice(1).join("\n\n")).toBe(other.systemPrompt[1]);
	sessionId = "session-a";
	await command("injected", ctx);
	expect(notices.at(-1)).toBe(captured);
	await withTestMemory(cwd, memory => { memory.facts = []; });
	expect(await handlers.get("before_agent_start")!({ reason: "prompt", prompt: "No facts left", systemPrompt: ["base"] }, ctx)).toBeUndefined();
	await command("injected", ctx);
	expect(notices.at(-1)).not.toContain(text);
	expect(notices.at(-1)).toContain("约 0 token");
	await handlers.get("session_shutdown")!({}, ctx);
});

test("keeps pending project messages when the extraction response is invalid", async () => {
	const cwd = newProject(); const handlers = new Map<string, Function>(); let command: Function = () => {}; const notices: string[] = [];
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: () => 1, clearTimer: () => {}, runEphemeralTurn: async () => ({ replyText: "not json" }) };
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => text.length);
	await handlers.get("session_start")!({}, ctx); await handlers.get("agent_end")!({ messages: [{ role: "user", content: "Remember this", timestamp: 1 }, { role: "assistant", content: "I will remember.", timestamp: 2, stopReason: "stop" }] }, ctx);
	await command("sync", ctx); await command("status", ctx);
	expect(notices.at(-1)).toContain("待处理消息 1 条");
	await handlers.get("session_shutdown")!({}, ctx);
});

test("stores each fact as Markdown and leaves the old exploratory database untouched", async () => {
	const cwd = newProject(); await Bun.write(join(cwd, ".omp/project-memory/memory.sqlite"), "old test database");
	const handlers = new Map<string, Function>(); let command: Function = () => {}; const notices: string[] = [];
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: () => 1, clearTimer: () => {} };
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => text.length);
	await command("add New format", ctx);
	const document = await Bun.file(join(cwd, ".omp/project-memory/memory.json")).json() as { version: string; factStoreVersion: string; facts?: MemoryFact[] };
	expect(document.version).toBe("2.0"); expect(document.factStoreVersion).toBe("markdown-v1"); expect(document.facts).toBeUndefined();
	await command("show", ctx); const fact = JSON.parse(notices.at(-1)!).facts[0] as MemoryFact;
	expect(await Bun.file(join(cwd, `.omp/project-memory/facts/${fact.id}.md`)).text()).toContain("New format");
	expect(await Bun.file(join(cwd, ".omp/project-memory/memory.sqlite")).text()).toBe("old test database");
});

test("does not replace an active fact with a below-threshold proposal", async () => {
	const cwd = newProject(); const handlers = new Map<string, Function>(); let command: Function = () => {}; const notices: string[] = [];
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "new" }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: () => 1, clearTimer: () => {}, runEphemeralTurn: async () => ({ replyText: JSON.stringify({ newFacts: [{ content: "Use Rust", confidence: 0.5, scope: "project", durability: "durable", authority: "descriptive" }], factsToRemove: [{ id: "old", scope: "project", reason: "Maybe changing", replacementFactIndex: 0 }] }) }) };
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => text.length);
	await withTestMemory(cwd, memory => { memory.facts.push({ id: "old", content: "Use Python", category: "decision", confidence: 0.9, source: "old", created_at: "2020-01-01T00:00:00Z", status: "active", superseded_by: null, expected_valid_days: null, confirmed_at: null, reviewed_at: null, review_status: null, review_reason: null, source_error: null }); });
	await handlers.get("session_start")!({}, ctx); await handlers.get("agent_end")!({ messages: [{ role: "user", content: "Maybe Rust", timestamp: 1 }, { role: "assistant", content: "We should use Rust.", timestamp: 2, stopReason: "stop" }] }, ctx); await command("sync", ctx);
	await command("show", ctx); expect(JSON.parse(notices.at(-1)!).facts.map((fact: MemoryFact) => fact.content)).toEqual(["Use Python"]);
	await command("candidates", ctx); expect(JSON.parse(notices.at(-1)!)).toEqual([]);
	await command("show", ctx); expect(JSON.parse(notices.at(-1)!).facts.map((fact: MemoryFact) => fact.content)).toEqual(["Use Python"]);
	await handlers.get("session_shutdown")!({}, ctx);
});

test("token budget reserves corrections and stale review honors recent confirmation", () => {
	const fact = (id: string, content: string, category: string): MemoryFact => ({ id, content, category, confidence: 0.9, source: "s", created_at: "2020-01-01T00:00:00Z", status: "active", superseded_by: null, expected_valid_days: null, confirmed_at: null, reviewed_at: null, review_status: null, review_reason: null, source_error: null });
	const facts = [fact("1", "Important correction", "correction"), fact("2", "A very long fact ".repeat(100), "decision"), fact("3", "Regular fact", "decision")];
	const selected = selectForInjection(facts, { ...DEFAULT_CONFIG, injectionTokens: 100, correctionTokens: 40 }, text => text.length);
	expect(selected.tokens).toBeLessThanOrEqual(100); expect(selected.text).toContain("Important correction"); expect(selected.omitted).toBeGreaterThan(0);
	facts[0]!.category = "decision"; facts[0]!.reviewed_at = "2020-01-01T00:00:00Z"; facts[0]!.confirmed_at = "2026-10-01T00:00:00Z";
	expect(staleCandidates(facts, { ...DEFAULT_CONFIG, staleMinCandidates: 1 }, Date.parse("2026-10-29T00:00:00Z")).map(item => item.id)).not.toContain("1");
	expect(nextEligibleAt(0, 290_000, DEFAULT_CONFIG)).toBe(300_000);
	expect(nearDuplicate("项目使用 Python 和 SQLite", "项目使用 Python 和 SQLite", 0.7)).toBe(true);
	expect(detectSignals([{ text: "assistant: 完全正确" }])).toEqual([]); expect(detectSignals([{ text: "user: 完全正确" }])).toContain("reinforcement");
	expect(readConfig({ injectionTokens: 100 }).correctionTokens).toBe(100); expect(() => readConfig({ injectionTokens: 100, correctionTokens: 500 })).toThrow();
	expect(parseResponse('answer: {"unrelated":true}\n```json\n{"newFacts":[]}\n```').newFacts).toEqual([]);
	const relevanceFacts = [fact("low", "Database runs in SQLite", "decision"), fact("high", "HTTP API design", "architecture")];
	expect(selectForInjection(relevanceFacts, { ...DEFAULT_CONFIG, retrievalRelevanceEnabled: true, retrievalRelevanceWeight: 1 }, text => text.length, [], [], "SQLite").text.indexOf("low")).toBeLessThan(selectForInjection(relevanceFacts, { ...DEFAULT_CONFIG, retrievalRelevanceEnabled: true, retrievalRelevanceWeight: 1 }, text => text.length, [], [], "SQLite").text.indexOf("high"));
});

test("stores summaries and uncertain conflicts, while rejecting cross-project personal facts", async () => {
	const cwd = newProject(); const handlers = new Map<string, Function>(); let command: Function = () => {}; const notices: string[] = [];
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: () => 1, clearTimer: () => {}, runEphemeralTurn: async () => ({ replyText: "" }) };
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => text.length);
	await command("add Project uses Python", ctx); await command("show", ctx); const old = JSON.parse(notices.at(-1)!).facts[0].id;
	ctx.runEphemeralTurn = async () => ({ replyText: JSON.stringify({ summaryUpdates: [{ section: "projectContext", summary: "Project uses Python", shouldUpdate: true, scope: "project", authority: "descriptive" }], newFacts: [{ content: "May move to Rust", category: "decision", confidence: 0.8, scope: "project", durability: "durable", authority: "descriptive", conflicts: [old] }, { content: "User likes coffee", category: "preference", confidence: 1, scope: "user", durability: "durable", authority: "descriptive" }] }) });
	await handlers.get("session_start")!({}, ctx); await handlers.get("agent_end")!({ messages: [{ role: "user", content: "Maybe Rust", timestamp: 1 }, { role: "assistant", content: "We should use Rust.", timestamp: 2, stopReason: "stop" }] }, ctx); await command("sync", ctx); await command("show", ctx);
	const shown = JSON.parse(notices.at(-1)!); expect(shown.facts.map((fact: MemoryFact) => fact.content).sort()).toEqual(["May move to Rust", "Project uses Python"].sort()); expect(shown.conflicts).toHaveLength(1);
	const injected = await handlers.get("before_agent_start")!({ reason: "prompt", systemPrompt: ["base"] }, ctx); expect(injected.systemPrompt[1]).toContain("可能与"); expect(injected.systemPrompt[1]).toContain("项目摘要");
	await handlers.get("session_shutdown")!({}, ctx);
});

test("leaves the predecessor and queue intact when a replacement response is malformed", async () => {
	const cwd = newProject(); const handlers = new Map<string, Function>(); let command: Function = () => {}; const notices: string[] = [];
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: () => 1, clearTimer: () => {}, runEphemeralTurn: async () => ({ replyText: JSON.stringify({ newFacts: [{ content: "Use Rust", confidence: "bad" }], factsToRemove: [{ id: "old", scope: "project", reason: "Maybe changing", replacementFactIndex: 4 }] }) }) };
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => text.length);
	await withTestMemory(cwd, memory => { memory.facts.push({ id: "old", content: "Use Python", category: "decision", confidence: 0.9, source: "manual", created_at: new Date().toISOString(), status: "active", superseded_by: null, expected_valid_days: null, confirmed_at: null, reviewed_at: null, review_status: null, review_reason: null, source_error: null }); });
	await handlers.get("session_start")!({}, ctx); await handlers.get("agent_end")!({ messages: [{ role: "user", content: "Use Rust", timestamp: 1 }, { role: "assistant", content: "I will use Rust.", timestamp: 2, stopReason: "stop" }] }, ctx); await command("sync", ctx); await command("show", ctx);
	expect(JSON.parse(notices.at(-1)!).facts[0].id).toBe("old"); await command("status", ctx); expect(notices.at(-1)).toContain("待处理消息 1 条"); await handlers.get("session_shutdown")!({}, ctx);
});

test("removes stale facts selected by DeerFlow-style review and retains an event record", async () => {
	const cwd = newProject(); const handlers = new Map<string, Function>(); let command: Function = () => {}; const notices: string[] = [];
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: () => 1, clearTimer: () => {}, runEphemeralTurn: async () => ({ replyText: "" }) };
	await Bun.write(join(cwd, ".omp/project-memory/config.json"), JSON.stringify({ staleMinCandidates: 1 }));
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => text.length);
	await handlers.get("session_start")!({}, ctx); await command("add Old agreement", ctx); await command("show", ctx);
	const id = JSON.parse(notices.at(-1)!).facts[0].id;
	await withTestMemory(cwd, memory => { memory.facts[0]!.created_at = "2020-01-01T00:00:00Z"; memory.facts[0]!.confirmed_at = null; });
	ctx.runEphemeralTurn = async () => ({ replyText: JSON.stringify({ newFacts: [], staleFactsToRemove: [{ id, reason: "Project changed" }] }) });
	await handlers.get("agent_end")!({ messages: [{ role: "user", content: "Review project facts", timestamp: 1 }, { role: "assistant", content: "I will review those facts.", timestamp: 2, stopReason: "stop" }] }, ctx); await command("sync", ctx);
	await command("show", ctx); expect(JSON.parse(notices.at(-1)!).facts).toEqual([]);
	await command("events", ctx); expect(JSON.parse(notices.at(-1)!).some((event: { factId: string; event: string }) => event.factId === id && event.event === "stale_remove")).toBe(true);
	await handlers.get("session_shutdown")!({}, ctx);
});

test("redacts credential-shaped strings before queueing", async () => {
	const cwd = newProject(); const handlers = new Map<string, Function>(); const notices: string[] = []; let command: Function = () => {};
	const secret = `ghp_${"A".repeat(32)}`;
	const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" }, ui: { notify: (message: string) => notices.push(message) }, setTimeout: () => 1, clearTimer: () => {}, runEphemeralTurn: async () => ({ replyText: '{"newFacts":[]}' }) };
	createProjectMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as never, text => text.length);
	await handlers.get("session_start")!({}, ctx); await handlers.get("agent_end")!({ messages: [{ role: "user", content: `Credential ${secret}`, timestamp: 1 }, { role: "assistant", content: "I will handle that securely.", timestamp: 2, stopReason: "stop" }] }, ctx); await command("status", ctx);
	const file = join(cwd, ".omp/project-memory/memory.json"); const saved = await Bun.file(file).text(); expect(saved).not.toContain(secret); await handlers.get("session_shutdown")!({}, ctx);
});
