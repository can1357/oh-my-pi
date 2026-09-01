import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getMemoryRoot } from "./index";

export const MEMORY_CATEGORIES = ["ARCHITECTURE", "CONVENTION", "DECISION", "ENVIRONMENT", "KNOWN_FAILURE", "WORKFLOW", "TOOLING"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryScope = "PROJECT" | "WORKSPACE" | "SUBSYSTEM" | "SESSION";
export type MemoryTrust = "UNVERIFIED" | "OBSERVED" | "VERIFIED" | "CONFIRMED";
export type MemoryFreshness = "stable" | "recently_validated" | "aging" | "stale" | "invalid";
export type MemoryCandidateRejection = "temporary" | "obvious" | "speculative" | "duplicate" | "stale" | "session_scope" | "sensitive" | "insufficient_trust" | "empty";

export interface MemoryItem {
	id: string;
	type: MemoryCategory;
	content: string;
	source: string;
	scope: Exclude<MemoryScope, "SESSION">;
	confidence: number;
	createdAt: number;
	updatedAt: number;
	lastValidatedAt: number;
	repositoryFingerprint: string;
	relevance: number;
	trust: MemoryTrust;
	canonicalKey: string;
	contradictionKey: string;
	evidenceCount: number;
	validatedCount: number;
	invalidatedAt?: number;
}
export interface MemoryCandidate {
	type: MemoryCategory;
	content: string;
	source: string;
	scope: MemoryScope;
	confidence: number;
	trust: MemoryTrust;
	relevance: number;
	repositoryFingerprint: string;
	verified?: boolean;
	confirmed?: boolean;
}
export interface MemoryStoreLimits { maxItems?: number; maxItemsPerCategory?: number; maxContentChars?: number; }
export interface MemoryRetrievalOptions { limit?: number; budgetTokens?: number; includeObserved?: boolean; }
export interface MemoryTelemetry {
	candidates: number;
	accepted: number;
	rejected: number;
	deduplicated: number;
	updated: number;
	invalidated: number;
	retrieved: number;
	notRetrieved: number;
	validationEvents: number;
	memoryContextTokens: number;
	lookupLatencyMs: number;
	storageLatencyMs: number;
	degraded: boolean;
	rejectionReasons: Record<string, number>;
}
export interface MemoryQueryResult { items: MemoryItem[]; telemetry: Pick<MemoryTelemetry, "retrieved" | "notRetrieved" | "memoryContextTokens" | "lookupLatencyMs">; }
interface MemoryDocument { version: 1; projectRoot: string; updatedAt: number; items: MemoryItem[]; }

const DEFAULTS = { maxItems: 128, maxItemsPerCategory: 32, maxContentChars: 1600 } as const;
const TRUST_RANK: Record<MemoryTrust, number> = { UNVERIFIED: 0, OBSERVED: 1, VERIFIED: 2, CONFIRMED: 3 };
const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY|password\s*[:=]|api[_ -]?key\s*[:=]|authorization\s*:\s*bearer)/i;
const TEMP_RE = /\b(?:this session|this task|for now|temporarily|temporary|currently editing|current scratch|one-off|just for this|today only)\b/i;
const SPEC_RE = /\b(?:maybe|might|possibly|probably|i think|i suspect|seems like|could be|likely)\b/i;
const OBVIOUS_RE = /^(?:the project|the repo|this project)\s+(?:has|uses)\s+(?:source code|files|a repository)$/i;
const NON_DURABLE_RE = /\b(?:TODO|FIXME|WIP|debug print|console\.log\(|temporary hack)\b/i;

function normalize(text: string): string { return text.toLowerCase().replace(/[`*_>#:[\]{}(),.;!?]/g, " ").replace(/\s+/g, " ").trim(); }
function tokens(text: string): string[] { return normalize(text).split(" ").filter(x => x.length >= 3 && !new Set(["the", "and", "for", "with", "from", "that", "this", "uses", "use", "project", "repo"]).has(x)); }
function canonicalFact(content: string, type: MemoryCategory): { canonicalKey: string; contradictionKey: string } {
	const value = normalize(content);
	let m = value.match(/\btests?\s+(?:use|run with)\s+([a-z0-9_.@/-]+)/i); if (m) return { canonicalKey: `testing-framework:${m[1]}`, contradictionKey: "testing-framework" };
	m = value.match(/\b(?:project|repo|repository)\s+uses\s+([a-z0-9_.@/-]+)/i); if (m) return { canonicalKey: `tooling:${m[1]}`, contradictionKey: "project-tooling" };
	m = value.match(/\b(?:use|prefer)\s+([a-z0-9_.@/-]+)\s+(?:not|instead of)\s+([a-z0-9_.@/-]+)/i); if (m) return { canonicalKey: `preference:${m[1]}`, contradictionKey: `preference:${m[1]}` };
	m = value.match(/\bnever\s+(?:edit|modify|change)\s+(.+)/i); if (m) { const target = normalize(m[1]); return { canonicalKey: `instruction:never-edit:${target}`, contradictionKey: "instruction:never-edit" }; }
	m = value.match(/\b(?:database|db)\s*(?:is|=)\s*([a-z0-9_.@/-]+)/i); if (m) return { canonicalKey: `database:${m[1]}`, contradictionKey: "database" };
	const compact = tokens(value).join(" "); return { canonicalKey: `${type.toLowerCase()}:${compact}`, contradictionKey: `${type.toLowerCase()}:${compact}` };
}
function safeContent(text: string, maxChars: number): string { return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars); }
function freshness(item: MemoryItem, currentFingerprint: string, now: number): MemoryFreshness {
	if (item.invalidatedAt) return "invalid";
	if (item.repositoryFingerprint === currentFingerprint) {
		const ageDays = (now - item.lastValidatedAt) / 86_400_000;
		return ageDays <= 7 ? "recently_validated" : "stable";
	}
	if (item.type === "ENVIRONMENT" || item.type === "TOOLING" || item.type === "WORKFLOW") return "stale";
	return (now - item.lastValidatedAt) / 86_400_000 <= 45 ? "aging" : "stale";
}
function trustRank(t: MemoryTrust): number { return TRUST_RANK[t]; }
function evictionRank(a: MemoryItem, b: MemoryItem): number { return (trustRank(b.trust) - trustRank(a.trust)) || (b.evidenceCount - a.evidenceCount) || (b.relevance - a.relevance) || (b.lastValidatedAt - a.lastValidatedAt) || (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id); }
function bounded(items: MemoryItem[], limits: Required<MemoryStoreLimits>): MemoryItem[] {
	const categories = new Map<MemoryCategory, MemoryItem[]>();
	for (const item of items) (categories.get(item.type) ?? (categories.set(item.type, []), categories.get(item.type)!)).push(item);
	const perCategory = [...categories.values()].flatMap(list => list.sort(evictionRank).slice(0, limits.maxItemsPerCategory));
	return perCategory.sort(evictionRank).slice(0, limits.maxItems);
}
export function validateMemoryCandidate(candidate: MemoryCandidate, maxContentChars = DEFAULTS.maxContentChars): { accepted: true; content: string } | { accepted: false; reason: MemoryCandidateRejection } {
	const content = safeContent(candidate.content, maxContentChars);
	if (!content) return { accepted: false, reason: "empty" };
	if (candidate.scope === "SESSION") return { accepted: false, reason: "session_scope" };
	if (SECRET_RE.test(content) || SECRET_RE.test(candidate.source)) return { accepted: false, reason: "sensitive" };
	if (TEMP_RE.test(content) || NON_DURABLE_RE.test(content)) return { accepted: false, reason: "temporary" };
	if (SPEC_RE.test(content)) return { accepted: false, reason: "speculative" };
	if (OBVIOUS_RE.test(content)) return { accepted: false, reason: "obvious" };
	if (candidate.trust === "UNVERIFIED" && !candidate.verified && !candidate.confirmed) return { accepted: false, reason: "insufficient_trust" };
	return { accepted: true, content };
}

export class ProjectMemoryStore {
	private readonly limits: Required<MemoryStoreLimits>;
	private readonly filePath: string;
	private readonly projectRoot: string;
	private document?: MemoryDocument;
	constructor(filePath: string, projectRoot: string, limits: MemoryStoreLimits = {}) { this.filePath = filePath; this.projectRoot = projectRoot; this.limits = { ...DEFAULTS, ...limits }; }
	private async load(): Promise<MemoryDocument> {
		if (this.document) return this.document;
		try {
			const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<MemoryDocument>;
			if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error("invalid project memory document");
			this.document = { version: 1, projectRoot: this.projectRoot, updatedAt: Number(parsed.updatedAt ?? Date.now()), items: parsed.items as MemoryItem[] };
		} catch { this.document = { version: 1, projectRoot: this.projectRoot, updatedAt: Date.now(), items: [] }; }
		return this.document;
	}
	private async persist(): Promise<number> {
		const started = performance.now(); const document = await this.load(); document.updatedAt = Date.now(); document.items = bounded(document.items, this.limits);
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`; await fs.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8"); await fs.rename(temp, this.filePath);
		return performance.now() - started;
	}
	async list(): Promise<MemoryItem[]> { return [...(await this.load()).items]; }
	async addCandidate(candidate: MemoryCandidate): Promise<{ accepted: boolean; action: "stored" | "updated" | "deduplicated" | "invalidated" | "rejected"; reason?: MemoryCandidateRejection; item?: MemoryItem; storageLatencyMs: number }> {
		const checked = validateMemoryCandidate(candidate, this.limits.maxContentChars); if (!checked.accepted) return { accepted: false, action: "rejected", reason: checked.reason, storageLatencyMs: 0 };
		const document = await this.load(); const now = Date.now(); const content = checked.content; const keys = canonicalFact(content, candidate.type);
		const existing = document.items.filter(item => !item.invalidatedAt && item.contradictionKey === keys.contradictionKey);
		const exact = existing.find(item => item.canonicalKey === keys.canonicalKey && normalize(item.content) === normalize(content));
		if (exact) {
			exact.evidenceCount += 1; exact.updatedAt = now; exact.confidence = Math.max(exact.confidence, candidate.confidence); exact.relevance = Math.max(exact.relevance, candidate.relevance);
			if (trustRank(candidate.trust) >= TRUST_RANK.VERIFIED) { exact.validatedCount += 1; exact.lastValidatedAt = now; }
			if (trustRank(candidate.trust) > trustRank(exact.trust)) exact.trust = candidate.trust; else if (exact.evidenceCount >= 2 && exact.trust === "OBSERVED") { exact.trust = "VERIFIED"; exact.validatedCount += 1; exact.lastValidatedAt = now; }
			return { accepted: true, action: "deduplicated", item: exact, storageLatencyMs: await this.persist() };
		}
		let invalidated = false;
		if (trustRank(candidate.trust) >= TRUST_RANK.VERIFIED) for (const item of existing) { item.invalidatedAt = now; invalidated = true; }
		const item: MemoryItem = { id: createHash("sha256").update(`${candidate.type}|${keys.canonicalKey}|${content}`).digest("hex").slice(0, 16), type: candidate.type, content, source: safeContent(candidate.source, 300), scope: candidate.scope as Exclude<MemoryScope, "SESSION">, confidence: Math.min(1, Math.max(0, candidate.confidence)), createdAt: now, updatedAt: now, lastValidatedAt: trustRank(candidate.trust) >= TRUST_RANK.VERIFIED ? now : 0, repositoryFingerprint: candidate.repositoryFingerprint, relevance: Math.min(1, Math.max(0, candidate.relevance)), trust: candidate.trust, canonicalKey: keys.canonicalKey, contradictionKey: keys.contradictionKey, evidenceCount: 1, validatedCount: trustRank(candidate.trust) >= TRUST_RANK.VERIFIED ? 1 : 0 };
		document.items.push(item); return { accepted: true, action: invalidated ? "invalidated" : "stored", item, storageLatencyMs: await this.persist() };
	}
	async invalidateByCanonical(canonicalKey: string): Promise<number> { const document = await this.load(); const now = Date.now(); let count = 0; for (const item of document.items) if (!item.invalidatedAt && item.canonicalKey === canonicalKey) { item.invalidatedAt = now; count += 1; } if (count) await this.persist(); return count; }
	async reconcileRepositoryFacts(facts: MemoryCandidate[]): Promise<number> {
		let invalidated = 0;
		const current = await this.load(); const now = Date.now();
		for (const fact of facts) {
			const checked = validateMemoryCandidate(fact, this.limits.maxContentChars); if (!checked.accepted) continue;
			const keys = canonicalFact(checked.content, fact.type);
			for (const item of current.items) if (!item.invalidatedAt && item.contradictionKey === keys.contradictionKey) { item.invalidatedAt = now; invalidated += 1; }
		}
		for (const fact of facts) await this.addCandidate({ ...fact, trust: "VERIFIED", verified: true });
		return invalidated;
	}
	async query(task: string, currentFingerprint: string, options: MemoryRetrievalOptions = {}): Promise<MemoryQueryResult> {
		const started = performance.now(); const items = await this.load(); const limit = Math.max(0, options.limit ?? 6); const budget = Math.max(256, options.budgetTokens ?? 1200); const q = tokens(task); const now = Date.now();
		const ranked = items.items.filter(item => !item.invalidatedAt && (options.includeObserved ? trustRank(item.trust) >= TRUST_RANK.OBSERVED : trustRank(item.trust) >= TRUST_RANK.VERIFIED)).filter(item => freshness(item, currentFingerprint, now) !== "invalid").map(item => {
			const text = `${item.content} ${item.type} ${item.scope}`.toLowerCase(); const hits = q.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0); const lexical = q.length ? Math.min(1, hits / Math.min(8, q.length)) : 0; const fresh = freshness(item, currentFingerprint, now); const freshnessScore = fresh === "recently_validated" ? 1 : fresh === "stable" ? 0.9 : fresh === "aging" ? 0.6 : 0.2; const score = lexical * 5 + trustRank(item.trust) / 3 * 2.5 + freshnessScore * 1.8 + item.relevance * 1.3 + (item.scope === "SUBSYSTEM" ? 0.25 : item.scope === "WORKSPACE" ? 0.15 : 0.08); return { item, score };
		}).filter(row => row.score > 0.4 || q.length === 0).sort((a, b) => b.score - a.score || b.item.lastValidatedAt - a.item.lastValidatedAt || a.item.id.localeCompare(b.item.id));
		const selected: MemoryItem[] = []; let chars = 0; for (const row of ranked) { if (selected.length >= limit) break; const next = chars + row.item.content.length + 80; if (Math.ceil(next / 4) > budget) continue; selected.push(row.item); chars = next; }
		return { items: selected, telemetry: { retrieved: selected.length, notRetrieved: Math.max(0, ranked.length - selected.length), memoryContextTokens: Math.ceil(chars / 4), lookupLatencyMs: performance.now() - started } };
	}
	async inspect(currentFingerprint: string): Promise<Array<MemoryItem & { freshness: MemoryFreshness }>> { const now = Date.now(); return (await this.list()).map(item => ({ ...item, freshness: freshness(item, currentFingerprint, now) })); }
}
export function projectMemoryFilePath(agentDir: string, cwd: string): string { return path.join(getMemoryRoot(agentDir, cwd), "project-memory.json"); }
export async function projectFingerprint(cwd: string): Promise<string> { let head = "nogit"; try { const proc = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--verify", "HEAD"]); if (proc.exitCode === 0) head = new TextDecoder().decode(proc.stdout).trim() || head; } catch {} return createHash("sha256").update(`${path.resolve(cwd)}\0${head}`).digest("hex").slice(0, 24); }
export function renderProjectMemory(items: readonly MemoryItem[]): string {
	if (!items.length) return "";
	const labels: Record<MemoryTrust, string> = { UNVERIFIED: "unverified", OBSERVED: "observed", VERIFIED: "verified", CONFIRMED: "confirmed" }; const groups = new Map<MemoryCategory, MemoryItem[]>();
	for (const item of items) (groups.get(item.type) ?? (groups.set(item.type, []), groups.get(item.type)!)).push(item);
	const lines = ["[Project Memory]"]; for (const category of MEMORY_CATEGORIES) { const group = groups.get(category); if (!group?.length) continue; lines.push(`${category}:`); for (const item of group) lines.push(`- ${item.content} [${labels[item.trust]}]`); } return lines.join("\n");
}
