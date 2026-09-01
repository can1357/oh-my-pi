import { getAgentDir } from "@oh-my-pi/pi-utils";
import { classifyTask, createStrategyProfile, deriveModelCapabilities, getRepositoryIntelligence, getVerification, Agent, type AgentMessage, type AgentState } from "@oh-my-pi/pi-agent-core";
import { ProjectMemoryStore, projectFingerprint, projectMemoryFilePath, renderProjectMemory, type MemoryCategory, type MemoryCandidate, type MemoryScope, type MemoryTelemetry } from "./project-memory";

const kPatched = Symbol.for("oh-my-pi-ultra.project-memory.patched");
interface MemoryState extends AgentState { projectMemory?: MemoryTelemetry; }
interface ProjectMemoryRuntime { store: ProjectMemoryStore; telemetry: MemoryTelemetry; removeHook: () => void; }
const CATEGORY_BY_FAILURE: MemoryCategory = "KNOWN_FAILURE";

function enabled(): boolean { return process.env.PI_PROJECT_MEMORY !== "0"; }
function positive(name: string, fallback: number): number { const n = Number.parseInt(process.env[name] ?? "", 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function promptText(input: unknown): string | undefined {
	if (typeof input === "string") return input.trim() || undefined;
	if (!Array.isArray(input)) return undefined;
	const text = input.filter(x => x && typeof x === "object" && (x as { role?: string }).role === "user").map(x => {
		const content = (x as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content.map(block => block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : "").join(" ");
	}).join(" ").trim();
	return text || undefined;
}
function scopeForTask(task: string): MemoryScope { return /\b(?:packages|apps|services|src)\/[A-Za-z0-9_.-]+/i.test(task) ? "SUBSYSTEM" : "PROJECT"; }
function userInstructionCandidate(task: string, fingerprint: string): MemoryCandidate | undefined {
	const match = task.match(/\b(never|do not|don't)\s+(?:edit|modify|change)\s+([^.!?]+)|\buse\s+([A-Za-z0-9_.@/-]+)\s+(?:not|instead of)\s+([A-Za-z0-9_.@/-]+)/i);
	if (!match) return undefined;
	const content = match[1] ? `${match[1].toLowerCase()} edit ${match[2].trim()}` : `Use ${match[3]} instead of ${match[4]}`;
	return { type: "CONVENTION", content, source: "explicit user instruction", scope: scopeForTask(task), confidence: 0.98, trust: "CONFIRMED", relevance: 1, repositoryFingerprint: fingerprint, confirmed: true };
}
function workflowCandidate(agent: Agent, task: string, fingerprint: string): MemoryCandidate | undefined {
	const verification = getVerification(agent) as unknown as { plan?: { checks?: Array<{ name?: string }> }; finalState?: string } | undefined;
	if (verification?.finalState !== "VERIFIED_SUCCESS") return undefined;
	const checks = verification.plan?.checks?.map(x => x.name).filter((x): x is string => Boolean(x));
	if (!checks || checks.length < 2) return undefined;
	return { type: "WORKFLOW", content: `For ${task.slice(0, 120)}, verified workflow is ${checks.join(" -> ")}.`, source: "verification workflow", scope: scopeForTask(task), confidence: 0.82, trust: "OBSERVED", relevance: 0.8, repositoryFingerprint: fingerprint };
}
function toolingCandidate(agent: Agent, fingerprint: string): MemoryCandidate | undefined {
	const profile = getRepositoryIntelligence(agent)?.profile as unknown as Record<string, unknown> | undefined;
	const pkg = typeof profile?.packageManager === "string" ? profile.packageManager : undefined;
	const test = typeof profile?.testFramework === "string" ? profile.testFramework : undefined;
	if (!pkg && !test) return undefined;
	const parts = [pkg ? `Project uses ${pkg} as its package manager.` : "", test ? `Tests use ${test}.` : ""].filter(Boolean);
	return { type: "TOOLING", content: parts.join(" "), source: "repository intelligence", scope: "PROJECT", confidence: 0.92, trust: "VERIFIED", relevance: 0.95, repositoryFingerprint: fingerprint, verified: true };
}
function failureCandidate(agent: Agent, task: string, fingerprint: string): MemoryCandidate | undefined {
	const verification = getVerification(agent) as unknown as { lastFailure?: { check?: string; category?: string; summary?: string } } | undefined;
	const failure = verification?.lastFailure;
	if (!failure?.check || !failure.summary) return undefined;
	return { type: CATEGORY_BY_FAILURE, content: `For ${task.slice(0, 80)}, ${failure.check} can fail with ${failure.category ?? "an execution error"}: ${failure.summary}`, source: "verified recovery evidence", scope: scopeForTask(task), confidence: 0.84, trust: "OBSERVED", relevance: 0.9, repositoryFingerprint: fingerprint };
}
function publish(agent: Agent, runtime: ProjectMemoryRuntime): void { (agent.state as MemoryState).projectMemory = { ...runtime.telemetry, rejectionReasons: { ...runtime.telemetry.rejectionReasons } }; }
async function loadMemoryContext(agent: Agent, task: string, store: ProjectMemoryStore, fingerprint: string): Promise<{ message?: AgentMessage; retrieved: number; notRetrieved: number; tokens: number; latencyMs: number }> {
	const classification = classifyTask(task);
	if (classification.complexity === "SIMPLE" && process.env.PI_PROJECT_MEMORY_ALWAYS !== "1") return { retrieved: 0, notRetrieved: 0, tokens: 0, latencyMs: 0 };
	const strategy = createStrategyProfile(classification, deriveModelCapabilities(agent.state.model));
	const requestedBudget = positive("PI_PROJECT_MEMORY_BUDGET_TOKENS", 1200);
	const budget = strategy.contextBudget ? Math.min(requestedBudget, Math.max(256, Math.floor(strategy.contextBudget * 0.14))) : requestedBudget;
	const started = performance.now();
	const result = await store.query(task, fingerprint, { limit: positive("PI_PROJECT_MEMORY_RETRIEVAL_LIMIT", classification.complexity === "VERY_COMPLEX" ? 8 : 5), budgetTokens: budget });
	const text = renderProjectMemory(result.items);
	return { message: text ? ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage) : undefined, retrieved: result.items.length, notRetrieved: result.telemetry.notRetrieved, tokens: result.telemetry.memoryContextTokens, latencyMs: result.telemetry.lookupLatencyMs || performance.now() - started };
}
async function capture(agent: Agent, task: string, store: ProjectMemoryStore, fingerprint: string, runtime: ProjectMemoryRuntime): Promise<void> {
	const candidates = [userInstructionCandidate(task, fingerprint), toolingCandidate(agent, fingerprint), workflowCandidate(agent, task, fingerprint), failureCandidate(agent, task, fingerprint)].filter((x): x is MemoryCandidate => Boolean(x));
	for (const candidate of candidates) {
		runtime.telemetry.candidates += 1;
		const result = await store.addCandidate(candidate);
		runtime.telemetry.storageLatencyMs += result.storageLatencyMs;
		if (!result.accepted) { runtime.telemetry.rejected += 1; const reason = result.reason ?? "unknown"; runtime.telemetry.rejectionReasons[reason] = (runtime.telemetry.rejectionReasons[reason] ?? 0) + 1; continue; }
		runtime.telemetry.accepted += 1;
		if (result.action === "deduplicated") runtime.telemetry.deduplicated += 1;
		if (result.action === "updated") runtime.telemetry.updated += 1;
		if (result.action === "invalidated") runtime.telemetry.invalidated += 1;
	}
	const profile = getRepositoryIntelligence(agent)?.profile as unknown as Record<string, unknown> | undefined;
	if (!profile) return;
	const authority: MemoryCandidate[] = [];
	if (typeof profile.packageManager === "string") authority.push({ type: "TOOLING", content: `Project uses ${profile.packageManager} as its package manager.`, source: "repository intelligence", scope: "PROJECT", confidence: 0.99, trust: "VERIFIED", relevance: 1, repositoryFingerprint: fingerprint, verified: true });
	if (typeof profile.testFramework === "string") authority.push({ type: "TOOLING", content: `Tests use ${profile.testFramework}.`, source: "repository intelligence", scope: "PROJECT", confidence: 0.99, trust: "VERIFIED", relevance: 1, repositoryFingerprint: fingerprint, verified: true });
	if (!authority.length) return;
	runtime.telemetry.validationEvents += authority.length;
	try { runtime.telemetry.invalidated += await store.reconcileRepositoryFacts(authority); } catch { runtime.telemetry.degraded = true; }
}
function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown }; if (target[kPatched]) return; target[kPatched] = true;
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function projectMemoryPrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = promptText(args[0]); if (!task) return original.apply(this, args);
		const cwd = process.cwd(); const fingerprint = await projectFingerprint(cwd); const store = new ProjectMemoryStore(projectMemoryFilePath(getAgentDir(), cwd), cwd, { maxItems: positive("PI_PROJECT_MEMORY_MAX_ITEMS", 128), maxItemsPerCategory: positive("PI_PROJECT_MEMORY_MAX_CATEGORY_ITEMS", 32), maxContentChars: positive("PI_PROJECT_MEMORY_MAX_CONTENT_CHARS", 1600) });
		const runtime: ProjectMemoryRuntime = { store, telemetry: { candidates: 0, accepted: 0, rejected: 0, deduplicated: 0, updated: 0, invalidated: 0, retrieved: 0, notRetrieved: 0, validationEvents: 0, memoryContextTokens: 0, lookupLatencyMs: 0, storageLatencyMs: 0, degraded: false, rejectionReasons: {} }, removeHook: () => {} };
		try {
			const loaded = await loadMemoryContext(this, task, store, fingerprint); runtime.telemetry.retrieved = loaded.retrieved; runtime.telemetry.notRetrieved = loaded.notRetrieved; runtime.telemetry.memoryContextTokens = loaded.tokens; runtime.telemetry.lookupLatencyMs = loaded.latencyMs;
			if (loaded.message) runtime.removeHook = this.addBeforeModelCall(async context => {
				const present = context.messages.some(item => { const content = (item as unknown as { content?: unknown }).content; return Array.isArray(content) && content.some(block => block && typeof block === "object" && "text" in block && String((block as { text: unknown }).text).startsWith("[Project Memory]")); });
				if (!present) context.messages = [loaded.message as AgentMessage, ...context.messages];
			});
			publish(this, runtime); return await original.apply(this, args);
		} catch { runtime.telemetry.degraded = true; publish(this, runtime); return await original.apply(this, args); }
		finally { try { runtime.removeHook(); } catch {} try { await capture(this, task, store, fingerprint, runtime); } catch { runtime.telemetry.degraded = true; } publish(this, runtime); }
	};
}
patch();
export function getProjectMemoryTelemetry(agent: Agent): MemoryTelemetry | undefined { return (agent.state as MemoryState).projectMemory; }
export { getProjectMemoryTelemetry as getMemoryTelemetry };
