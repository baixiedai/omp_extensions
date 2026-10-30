import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { redactMemorySecrets } from "@oh-my-pi/pi-coding-agent/memory-backend/redact";
import type { MemoryFact, MemorySummary } from "./policy";

export type ProjectPending = { id: string; sessionId: string; text: string; queuedAt: number; urgent: boolean };
export type MemoryEvent = { id: string; factId: string; event: string; source: string; reason?: string; createdAt: string };
export type MemoryConflict = { factId: string; otherId: string; reason: string; createdAt: string };
export type MemoryDocument = {
	version: "2.0";
	factStoreVersion?: "markdown-v1";
	factIds?: string[];
	revision: number;
	lastUpdated: string;
	project: Record<string, { summary: string; updatedAt: string }>;
	history: Record<string, { summary: string; updatedAt: string }>;
	watermarks: Record<string, { timestamp: number; lastSeen: number }>;
	facts: Array<MemoryFact & { replacementCandidates?: Array<{ oldId: string; reason: string }> }>;
	pending: ProjectPending[];
	conflicts: MemoryConflict[];
	events: MemoryEvent[];
};
export type FileLocker = <T>(path: string, operation: () => Promise<T>) => Promise<T>;
export type ReplaceFile = (source: string, destination: string) => Promise<void>;

export async function projectRoot(cwd: string, isEnoent: (error: unknown) => boolean): Promise<string> {
	let dir = resolve(cwd);
	while (true) {
		try { await stat(join(dir, ".git")); return dir; } catch (error) { if (!isEnoent(error)) throw error; }
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

export async function memoryFile(cwd: string, isEnoent: (error: unknown) => boolean): Promise<string> {
	return join(await projectRoot(cwd, isEnoent), ".omp", "project-memory", "memory.json");
}

export function emptyMemory(): MemoryDocument {
	return { version: "2.0", revision: 0, lastUpdated: "", project: {}, history: {}, watermarks: {}, facts: [], pending: [], conflicts: [], events: [] };
}

function factsDirectory(path: string): string { return join(dirname(path), "facts"); }

function factPath(path: string, id: string): string {
	if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error(`项目记忆事实 ID 无效: ${id}`);
	return join(factsDirectory(path), `${id}.md`);
}

function serializeFact(fact: MemoryDocument["facts"][number]): string {
	const { content, ...metadata } = fact;
	return `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n${content}\n`;
}

function parseFactMarkdown(source: string, filePath: string): MemoryDocument["facts"][number] {
	if (!source.startsWith("---\n")) throw new Error(`项目记忆事实文件缺少 front matter: ${filePath}`);
	const divider = source.indexOf("\n---\n\n", 4);
	if (divider < 0) throw new Error(`项目记忆事实文件 front matter 不完整: ${filePath}`);
	const metadata: unknown = JSON.parse(source.slice(4, divider));
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || typeof (metadata as Record<string, unknown>).id !== "string") throw new Error(`项目记忆事实 front matter 无效: ${filePath}`);
	let content = source.slice(divider + 6);
	if (content.endsWith("\n")) content = content.slice(0, -1);
	if (!content.trim()) throw new Error(`项目记忆事实内容为空: ${filePath}`);
	return { ...(metadata as Omit<MemoryDocument["facts"][number], "content">), content };
}

async function readMarkdownFacts(path: string, isEnoent: (error: unknown) => boolean): Promise<MemoryDocument["facts"]> {
	const directory = factsDirectory(path);
	let entries: fs.Dirent[];
	try { entries = await readdir(directory, { withFileTypes: true }); }
	catch (error) { if (isEnoent(error)) return []; throw error; }
	const facts: MemoryDocument["facts"] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = join(directory, entry.name);
		const fact = parseFactMarkdown(await Bun.file(filePath).text(), filePath);
		if (fact.id !== entry.name.slice(0, -3)) throw new Error(`项目记忆事实 ID 与文件名不匹配: ${filePath}`);
		facts.push(fact);
	}
	return facts;
}

async function readMemory(path: string, isEnoent: (error: unknown) => boolean): Promise<MemoryDocument> {
	try {
		const raw: unknown = await Bun.file(path).json();
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("项目记忆文件不是 JSON 对象");
		const data = raw as Partial<MemoryDocument>;
		if (data.version !== "2.0" || (data.factStoreVersion !== "markdown-v1" && !Array.isArray(data.facts)) || !Array.isArray(data.pending) || !Array.isArray(data.events) || !Array.isArray(data.conflicts) || !data.watermarks || typeof data.watermarks !== "object") throw new Error("不支持的项目记忆结构；未更改原文件");
		const facts = data.factStoreVersion === "markdown-v1" ? await readMarkdownFacts(path, isEnoent) : data.facts!;
		let factIds = data.factIds;
		if (data.factStoreVersion === "markdown-v1") {
			if (factIds === undefined) factIds = facts.map(fact => fact.id).sort();
			if (!Array.isArray(factIds) || factIds.some(id => typeof id !== "string")) throw new Error("项目记忆事实清单无效；未更改原文件");
			const expected = new Set(factIds);
			if (expected.size !== factIds.length || facts.length !== expected.size || facts.some(fact => !expected.has(fact.id))) throw new Error("项目记忆 Markdown 事实与清单不匹配；未更改原文件");
		}
		return { ...emptyMemory(), ...data, facts, ...(factIds ? { factIds } : {}) } as MemoryDocument;
	} catch (error) {
		if (isEnoent(error)) return emptyMemory();
		throw error;
	}
}

type MemoryTransaction = { manifest: string | null; facts: Array<{ id: string; content: string | null }> };

async function readOptionalText(path: string, isEnoent: (error: unknown) => boolean): Promise<string | null> {
	try { return await Bun.file(path).text(); }
	catch (error) { if (isEnoent(error)) return null; throw error; }
}

async function atomicReplace(path: string, content: string, replaceFile: ReplaceFile): Promise<void> {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try { await Bun.write(temp, content); await replaceFile(temp, path); }
	catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

async function markdownFiles(path: string, isEnoent: (error: unknown) => boolean): Promise<Map<string, string>> {
	const directory = factsDirectory(path);
	let entries: fs.Dirent[];
	try { entries = await readdir(directory, { withFileTypes: true }); }
	catch (error) { if (isEnoent(error)) return new Map(); throw error; }
	const files = new Map<string, string>();
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const id = entry.name.slice(0, -3);
		if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error(`项目记忆事实文件名无效: ${entry.name}`);
		files.set(id, await Bun.file(join(directory, entry.name)).text());
	}
	return files;
}

async function recoverTransaction(path: string, replaceFile: ReplaceFile, isEnoent: (error: unknown) => boolean): Promise<void> {
	const journalPath = `${path}.transaction.json`;
	const journalText = await readOptionalText(journalPath, isEnoent);
	if (journalText === null) return;
	const journal = JSON.parse(journalText) as MemoryTransaction;
	for (const fact of journal.facts) {
		const target = factPath(path, fact.id);
		if (fact.content === null) await unlink(target).catch(error => { if (!isEnoent(error)) throw error; });
		else await atomicReplace(target, fact.content, replaceFile);
	}
	if (journal.manifest === null) await unlink(path).catch(error => { if (!isEnoent(error)) throw error; });
	else await atomicReplace(path, journal.manifest, replaceFile);
	await unlink(journalPath);
}

export async function withMemory<T>(cwd: string, update: (data: MemoryDocument) => Promise<T> | T, lock: FileLocker, isEnoent: (error: unknown) => boolean, replaceFile: ReplaceFile): Promise<T> {
	const path = await memoryFile(cwd, isEnoent);
	await mkdir(dirname(path), { recursive: true });
	return lock(path, async () => {
		await recoverTransaction(path, replaceFile, isEnoent);
		const oldManifest = await readOptionalText(path, isEnoent);
		const data = await readMemory(path, isEnoent);
		const previousFiles = await markdownFiles(path, isEnoent);
		const result = await update(data);
		const directory = factsDirectory(path);
		await mkdir(directory, { recursive: true });
		if (data.factStoreVersion !== "markdown-v1" && oldManifest !== null) {
			const backupPath = `${path}.pre-markdown.bak`;
			try { await copyFile(path, backupPath, fs.constants.COPYFILE_EXCL); }
			catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
				if (await Bun.file(backupPath).text() !== oldManifest) throw new Error("现有 Markdown 迁移备份与原文件不符；已停止迁移以保留原始记忆");
			}
		}
		const nextFiles = new Map(data.facts.map(fact => [fact.id, serializeFact(fact)]));
		const changedIds = new Set([...previousFiles.keys(), ...nextFiles.keys()]);
		const journal: MemoryTransaction = { manifest: oldManifest, facts: [] };
		for (const id of changedIds) if (previousFiles.get(id) !== nextFiles.get(id)) journal.facts.push({ id, content: previousFiles.get(id) ?? null });
		const journalPath = `${path}.transaction.json`;
		await atomicReplace(journalPath, JSON.stringify(journal), replaceFile);
		try {
			for (const fact of journal.facts) {
				const next = nextFiles.get(fact.id);
				if (next === undefined) await unlink(factPath(path, fact.id));
				else await atomicReplace(factPath(path, fact.id), next, replaceFile);
			}
			data.revision++;
			data.lastUpdated = new Date().toISOString();
			data.factStoreVersion = "markdown-v1";
			data.factIds = data.facts.map(fact => fact.id).sort();
			const manifest: Partial<MemoryDocument> = { ...data };
			delete manifest.facts;
			await atomicReplace(path, `${JSON.stringify(manifest, null, 2)}\n`, replaceFile);
			await unlink(journalPath);
		} catch (error) {
			await recoverTransaction(path, replaceFile, isEnoent);
			throw error;
		}
		return result;
	});
}

export async function inspectMemory<T>(cwd: string, inspect: (data: MemoryDocument) => T, lock: FileLocker, isEnoent: (error: unknown) => boolean, replaceFile: ReplaceFile): Promise<T> {
	const path = await memoryFile(cwd, isEnoent);
	await mkdir(dirname(path), { recursive: true });
	return lock(path, async () => {
		await recoverTransaction(path, replaceFile, isEnoent);
		return inspect(await readMemory(path, isEnoent));
	});
}

export function recordEvent(data: MemoryDocument, factId: string, event: string, source: string, reason?: string): void {
	data.events.push({ id: randomUUID(), factId, event, source, ...(reason ? { reason: redactMemorySecrets(reason) } : {}), createdAt: new Date().toISOString() });
}

export function addPending(data: MemoryDocument, sessionId: string, id: string, role: string, text: string, urgent: boolean): void {
	const existing = data.pending.find(item => item.id === id);
	if (existing) { existing.urgent ||= urgent; return; }
	data.pending.push({ id, sessionId, text: `${role}: ${redactMemorySecrets(text)}`, queuedAt: Date.now(), urgent });
}

export function activeFacts(data: MemoryDocument): MemoryFact[] {
	return data.facts.filter(fact => fact.status === "active");
}

export function activeSummaries(data: MemoryDocument): MemorySummary[] {
	const sections = [...Object.entries(data.project), ...Object.entries(data.history)];
	return sections.map(([section, value]) => ({ id: section, section, content: value.summary, source: "project", created_at: value.updatedAt, status: "active" }));
}
