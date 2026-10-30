/** Project-scoped adaptation of DeerMem's fact selection and update contract. */
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { openSqliteDatabase } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SignalPatternOverrides } from "./signals";
import injectionHeader from "./memory-inject.md" with { type: "text" };
export type MemoryFact = {
	id: string; content: string; category: string; confidence: number; source: string;
	created_at: string; status: string; superseded_by: string | null;
	expected_valid_days: number | null; confirmed_at: string | null;
	reviewed_at: string | null; review_status: string | null; review_reason: string | null; source_error: string | null;
};
export type MemorySummary = { id: string; section: string; content: string; source: string; created_at: string; status: string };

export type MemoryConfig = {
	confidenceThreshold: number; injectionTokens: number; correctionTokens: number;
	maxFacts: number; staleDays: number; staleMinCandidates: number;
	staleReviewEnabled: boolean; staleMaxRemovals: number; staleProtectedCategories: string[];
	staleMaxLifetimeMultiplier: number; staleMaxExtensionDays: number;
	debounceSeconds: number; maxWaitSeconds: number; queueMaxDepth: number;
	signalPatterns: SignalPatternOverrides;
	nearDedupEnabled: boolean; nearDedupThreshold: number; consolidationEnabled: boolean;
	consolidationMinFacts: number; consolidationMaxGroups: number; consolidationMaxSources: number;
	retrievalRelevanceEnabled: boolean; retrievalRelevanceWeight: number; retrievalDiversityWeight: number;
};

export const DEFAULT_CONFIG: MemoryConfig = {
	confidenceThreshold: 0.7, injectionTokens: 2000, correctionTokens: 500,
	maxFacts: 100, staleDays: 90, staleMinCandidates: 3,
	staleReviewEnabled: true, staleMaxRemovals: 10, staleProtectedCategories: ["correction"],
	staleMaxLifetimeMultiplier: 20, staleMaxExtensionDays: 3650,
	debounceSeconds: 30, maxWaitSeconds: 300, queueMaxDepth: 1000,
	signalPatterns: {},
	nearDedupEnabled: false, nearDedupThreshold: 0.7, consolidationEnabled: false,
	consolidationMinFacts: 8, consolidationMaxGroups: 3, consolidationMaxSources: 8,
	retrievalRelevanceEnabled: false, retrievalRelevanceWeight: 0.5, retrievalDiversityWeight: 0,
};

export function readConfig(raw: unknown): MemoryConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("项目记忆配置必须是 JSON 对象");
	const values = { ...(raw as Record<string, unknown>) };
	if (values.maxFacts === undefined && values.maxFactsAdvisory !== undefined) values.maxFacts = values.maxFactsAdvisory;
	delete values.maxFactsAdvisory;
	const config = { ...DEFAULT_CONFIG, staleProtectedCategories: [...DEFAULT_CONFIG.staleProtectedCategories] };
	for (const key of Object.keys(values)) {
		if (!(key in DEFAULT_CONFIG)) throw new Error(`未知的项目记忆配置: ${key}`);
		const expected = DEFAULT_CONFIG[key as keyof MemoryConfig];
		const value = values[key];
		if (key === "signalPatterns") {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("项目记忆信号配置必须是 JSON 对象");
			for (const [name, patterns] of Object.entries(value)) {
				if (!["correction", "reinforcement", "decision", "goal", "preference", "identity", "trivial"].includes(name) || !Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== "string")) throw new Error(`无效的项目记忆信号配置: ${name}`);
				for (const pattern of patterns) { try { new RegExp(pattern as string, "iu"); } catch { throw new Error(`无效的项目记忆信号正则: ${name}`); } }
			}
			Object.assign(config, { [key]: value });
			continue;
		}
		if (Array.isArray(expected) ? !Array.isArray(value) || value.some(item => typeof item !== "string") : typeof value !== typeof expected || (typeof value === "number" && (!Number.isFinite(value) || value < 0))) throw new Error(`无效的项目记忆配置: ${key}`);
		Object.assign(config, { [key]: value });
	}
	if (values.injectionTokens !== undefined && values.correctionTokens === undefined) config.correctionTokens = Math.min(config.correctionTokens, config.injectionTokens);
	for (const key of ["injectionTokens", "correctionTokens", "maxFacts", "staleDays", "staleMinCandidates", "staleMaxRemovals", "staleMaxExtensionDays", "debounceSeconds", "maxWaitSeconds", "queueMaxDepth", "consolidationMinFacts", "consolidationMaxGroups", "consolidationMaxSources"] as const) if (!Number.isSafeInteger(config[key])) throw new Error(`项目记忆配置必须是整数: ${key}`);
	if (config.confidenceThreshold > 1 || config.nearDedupThreshold > 1 || config.retrievalRelevanceWeight > 1 || config.retrievalDiversityWeight > 1 || config.injectionTokens < 1 || config.maxFacts < 1 || config.maxFacts > 500 || config.correctionTokens > config.injectionTokens || config.debounceSeconds < 1 || config.maxWaitSeconds < config.debounceSeconds || config.queueMaxDepth < 0 || config.staleDays < 1 || config.staleMinCandidates < 1 || config.staleMaxRemovals < 1 || config.staleMaxLifetimeMultiplier < 1 || config.staleMaxExtensionDays < 1 || config.consolidationMinFacts < 2 || config.consolidationMaxGroups < 1 || config.consolidationMaxSources < 2) throw new Error("项目记忆配置超出有效范围");
	return config;
}

export const normalize = (text: string): string => text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();

export function nextEligibleAt(first: number, last: number, config: MemoryConfig): number {
	return Math.min(first + config.maxWaitSeconds * 1000, last + config.debounceSeconds * 1000);
}

/** Near-dedup is opt-in; Intl.Segmenter avoids splitting Chinese text into one token. */
export function nearDuplicate(a: string, b: string, threshold: number): boolean {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
	const words = (input: string) => {
		const result = new Set<string>(); let seen = 0;
		for (const part of segmenter.segment(normalize(input))) {
			if (!part.isWordLike) continue;
			result.add(part.segment);
			if (++seen >= 256) break;
		}
		return result;
	};
	const left = words(a); const right = words(b);
	if (!left.size || !right.size) return false;
	const intersection = [...left].filter(word => right.has(word)).length;
	return intersection / (left.size + right.size - intersection) >= threshold;
}

const MAX_TEXT_CHARS = 4096;
const MAX_RELEVANCE_TOKENS = 128;
function relevanceTokens(text: string): string[] {
	const source = text.slice(0, MAX_TEXT_CHARS).normalize("NFKC").toLocaleLowerCase();
	const tokens: string[] = [];
	for (const match of source.matchAll(/[a-zA-Z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff]+/gu)) {
		const word = match[0];
		if (/^[\u3400-\u9fff]+$/u.test(word) && word.length > 1) for (let index = 0; index < word.length - 1; index++) tokens.push(word.slice(index, index + 2));
		else tokens.push(word);
		if (tokens.length >= MAX_RELEVANCE_TOKENS) break;
	}
	return tokens.slice(0, MAX_RELEVANCE_TOKENS);
}

function lexicalRelevance(query: string, content: string, idf: Map<string, number>): number {
	const queryText = query.slice(0, MAX_TEXT_CHARS).normalize("NFKC").toLocaleLowerCase().trim();
	const contentText = content.slice(0, MAX_TEXT_CHARS).normalize("NFKC").toLocaleLowerCase().trim();
	const queryTokens = [...new Set(relevanceTokens(queryText))]; const contentTokens = new Set(relevanceTokens(contentText));
	const containment = queryText && contentText && (queryText.includes(contentText) || contentText.includes(queryText));
	let matched = containment ? 1 : 0; let total = 1;
	for (const token of queryTokens) {
		const weight = idf.get(token) ?? 1; total += weight * weight;
		const prefixMatch = token.length >= 4 && [...contentTokens].some(candidate => candidate.length >= 4 && candidate.slice(0, 4) === token.slice(0, 4) && (candidate.startsWith(token) || token.startsWith(candidate)));
		if (contentTokens.has(token) || prefixMatch) matched += weight * weight;
	}
	return total ? Math.sqrt(matched / total) : 0;
}

export function rankFactsForQuery(facts: MemoryFact[], query: string, relevanceWeight: number, diversityWeight = 0): MemoryFact[] {
	const docs = facts.map(fact => relevanceTokens(fact.content)); const df = new Map<string, number>();
	for (const tokens of docs) for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
	const idf = new Map([...df].map(([token, count]) => [token, Math.log((facts.length + 1) / (count + 1)) + 1]));
	const scores = facts.map(fact => ({ fact, score: relevanceWeight * lexicalRelevance(query, fact.content, idf) + (1 - relevanceWeight) * Math.max(0, Math.min(1, fact.confidence)) }));
	scores.sort((a, b) => b.score - a.score);
	if (diversityWeight <= 0) return scores.map(item => item.fact);
	const remaining = [...scores]; const chosen: MemoryFact[] = [];
	while (remaining.length) {
		let bestIndex = 0; let bestScore = -Infinity;
		for (let index = 0; index < remaining.length; index++) {
			const tokens = new Set(relevanceTokens(remaining[index]!.fact.content));
			const similarity = chosen.reduce((maximum, previous) => { const other = new Set(relevanceTokens(previous.content)); const union = new Set([...tokens, ...other]).size; return Math.max(maximum, union ? [...tokens].filter(token => other.has(token)).length / union : 0); }, 0);
			const adjusted = remaining[index]!.score - diversityWeight * similarity;
			if (adjusted > bestScore) { bestIndex = index; bestScore = adjusted; }
		}
		chosen.push(remaining.splice(bestIndex, 1)[0]!.fact);
	}
	return chosen;
}

type RetrievalLock = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

/** Keep a rebuildable per-project FTS5 index and fall back when SQLite is unavailable. */
export async function searchFactsWithFts5(facts: MemoryFact[], query: string, limit: number, indexPath: string, lock: RetrievalLock): Promise<MemoryFact[]> {
	const normalizedQuery = query.normalize("NFKC").trim();
	if (!normalizedQuery || limit <= 0) return [];
	const fallback = () => facts.filter(fact => fact.content.toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase())).sort((a, b) => b.confidence - a.confidence).slice(0, limit);
	try {
		await fs.mkdir(path.dirname(indexPath), { recursive: true });
		return await lock(indexPath, async () => {
			const database = await openSqliteDatabase(indexPath, db => {
				db.run("PRAGMA journal_mode = WAL");
				db.run("CREATE VIRTUAL TABLE IF NOT EXISTS project_facts USING fts5(id UNINDEXED, content, tokenize='unicode61')");
				return db;
			}, { recoverCorruption: true });
			try {
				const indexed = database.query<{ id: string; content: string }, []>("SELECT id, content FROM project_facts ORDER BY id").all();
				const current = [...facts].sort((a, b) => a.id.localeCompare(b.id));
				if (indexed.length !== current.length || indexed.some((row, index) => row.id !== current[index]!.id || row.content !== current[index]!.content.slice(0, MAX_TEXT_CHARS))) {
					database.run("BEGIN IMMEDIATE");
					try {
						database.run("DELETE FROM project_facts");
						const insert = database.query("INSERT INTO project_facts (id, content) VALUES (?, ?)");
						for (const fact of current) insert.run(fact.id, fact.content.slice(0, MAX_TEXT_CHARS));
						database.run("COMMIT");
					} catch (error) { database.run("ROLLBACK"); throw error; }
				}
				const terms = [...new Set(normalizedQuery.match(/[a-zA-Z0-9_]+/gu) ?? [])].slice(0, MAX_RELEVANCE_TOKENS);
				const matchQuery = [
					...(terms.length ? [terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ")] : []),
					...(/[\u3400-\u9fff]/u.test(normalizedQuery) ? [`"${normalizedQuery.replaceAll('"', '""')}"`] : []),
				].join(" OR ");
				if (!matchQuery) return fallback();
				const rows = database.query<{ id: string }, [string, number]>("SELECT id FROM project_facts WHERE content MATCH ? ORDER BY bm25(project_facts) LIMIT ?").all(matchQuery, limit);
				const byId = new Map(facts.map(fact => [fact.id, fact]));
				const matched = rows.map(row => byId.get(row.id)).filter((fact): fact is MemoryFact => fact !== undefined);
				return matched.length ? matched : fallback();
			} finally { database.close(); }
		});
	} catch {
		return fallback();
	}
}

/** Count the entire block, including punctuation and labels, not just fact text. */
export function selectForInjection(facts: MemoryFact[], config: MemoryConfig, count: (text: string) => number, conflicts: Array<{ fact_id: string; other_id: string }> = [], summaries: MemorySummary[] = [], query = ""): { text: string; selected: number; omitted: number; summariesSelected: number; tokens: number } {
	const active = facts.filter(fact => fact.status === "active");
	const ranked = config.retrievalRelevanceEnabled && query.trim() ? rankFactsForQuery(active, query, config.retrievalRelevanceWeight, config.retrievalDiversityWeight) : [...active].sort((a, b) => b.confidence - a.confidence || b.created_at.localeCompare(a.created_at));
	const selected: MemoryFact[] = [];
	const selectedSummaries: MemorySummary[] = [];
	const header = `${injectionHeader.trimEnd()}\n`;
	const render = (items: MemoryFact[], sections: MemorySummary[] = selectedSummaries) => items.length || sections.length ? header + [...sections.map(section => `[项目摘要 ${escapeXmlText(section.section)}] ${escapeXmlText(section.content)}`), ...items.map(item => {
		const related = conflicts.filter(pair => pair.fact_id === item.id || pair.other_id === item.id).map(pair => pair.fact_id === item.id ? pair.other_id : pair.fact_id);
		return `[${escapeXmlText(item.category)} | ${item.id}] ${escapeXmlText(item.content)}${item.review_status === "pending" ? " (待复核)" : ""}${related.length ? ` (可能与 ${related.join(", ")} 冲突)` : ""}`;
	})].join("\n") : "";
	let correctionUsed = 0;
	for (const fact of ranked.filter(fact => fact.category === "correction")) {
		const cost = Math.max(0, count(render([fact])) - count(header));
		if (correctionUsed + cost <= config.correctionTokens && count(render([...selected, fact])) <= config.injectionTokens) { selected.push(fact); correctionUsed += cost; }
	}
	for (const section of summaries.filter(summary => summary.status === "active")) {
		if (count(render(selected, [...selectedSummaries, section])) <= config.injectionTokens) selectedSummaries.push(section);
	}
	for (const fact of ranked) {
		if (selected.includes(fact)) continue;
		if (count(render([...selected, fact])) <= config.injectionTokens) selected.push(fact);
	}
	const text = render(selected);
	return { text, selected: selected.length, omitted: active.length - selected.length, summariesSelected: selectedSummaries.length, tokens: text ? count(text) : 0 };
}

/** Find a complete object even when a provider wraps JSON with commentary or fences. */
export function parseResponse(input: string): Record<string, unknown> {
	const text = input.replace(/<think>[\s\S]*?<\/think>/giu, "");
	const updateFields = ["summaryUpdates", "newFacts", "factsToReinforce", "factsToRemove", "staleFactsToRemove", "staleFactsToExtend", "factsToConsolidate"];
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		let depth = 0; let quoted = false; let escaped = false;
		for (let index = start; index < text.length; index++) {
			const char = text[index];
			if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
			if (char === '"') { quoted = true; continue; }
			if (char === "{") depth++;
			if (char === "}" && --depth === 0) {
				try {
					const value: unknown = JSON.parse(text.slice(start, index + 1));
					if (value && typeof value === "object" && !Array.isArray(value)) {
						const update = value as Record<string, unknown>;
						if (updateFields.some(field => field in update)) {
							if (update.newFacts === undefined) update.newFacts = [];
							return update;
						}
					}
				} catch { /* Keep looking for the update object. */ }
				break;
			}
		}
	}
	throw new Error("模型回复中没有有效的记忆更新 JSON 字段");
}

export function staleCandidates(facts: MemoryFact[], config: MemoryConfig, now: number): MemoryFact[] {
	if (!config.staleReviewEnabled) return [];
	const aged = facts.filter(fact => {
		if (fact.status !== "active" || config.staleProtectedCategories.includes(fact.category) || fact.review_status === "pending") return false;
		const base = Date.parse(fact.confirmed_at ?? fact.created_at);
		const storedDays = fact.expected_valid_days;
		const days = typeof storedDays === "number" && Number.isFinite(storedDays) && storedDays > 0 ? storedDays : config.staleDays;
		return Number.isFinite(base) && now - base >= days * 86_400_000;
	});
	return aged.length >= config.staleMinCandidates ? aged : [];
}
