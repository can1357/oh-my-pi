/**
 * Shared live Groq RLM eval helpers — production ModelRegistry + worker completion path.
 */
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../../../src/config/model-registry";
import { resolveModelFromString } from "../../../src/config/model-resolver";
import { Settings } from "../../../src/config/settings";
import {
	EVIDENCE_PACKET_V1_JSON_SCHEMA,
	formatEvidencePacketForRoot,
	parseEvidencePacketV1,
	type EvidencePacketV1,
} from "../../../src/rlm/evidence-packet";
import { buildEvidenceWorkerContext } from "../../../src/rlm/evidence-query";
import type { RlmCompleter } from "../../../src/rlm/query";
import {
	createTokenomicsBridge,
	type ContextPolicy,
	type OmpTokenomicsBridge,
} from "../../../src/rlm/tokenomics-bridge";
import { runRlmWorkerCompletion } from "../../../src/rlm/worker-completion";
import { workerContextContains } from "../../../src/rlm/broker";
import { selectGrantsFromSearch, type RlmGrantSelectPolicy, type RlmGrantSelectResult } from "../../../src/rlm/select-grants";
import { RlmRuntime, resetRlmStoresForTest } from "../../../src/rlm";
import type { RlmStore } from "../../../src/rlm/store";
import { resolveRlmView } from "../../../src/rlm/view";
import { AuthStorage } from "../../../src/session/auth-storage";

export const P0_CHECKPOINT_SHA = "53769bf12d48233bb262cd4bd61de93e18f400e8";
export const DEFAULT_GROQ_MODEL = "groq/openai/gpt-oss-20b";
export const RESULTS_DIR = path.join(import.meta.dir, "..", "results");

export type EvidenceLabel =
	| "SUPPORTED"
	| "WRONG_CITATION"
	| "UNSUPPORTED"
	| "MISSED_EVIDENCE"
	| "PARTIAL_OK";

export interface LiveFixture {
	id: string;
	buildCorpus: () => string;
	patterns: string[];
	selectPolicy?: RlmGrantSelectPolicy;
	question: string;
	parentSecret: string;
	requiredFacts: string[];
	expectStatus?: EvidencePacketV1["status"] | EvidencePacketV1["status"][];
	expectContradictions?: boolean;
	expectMissing?: boolean;
	grantedNeedle: string;
}

export interface FirewallProof {
	parentSecretInWorker: boolean;
	grantedNeedleInWorker: boolean;
	ungrantedHandleInWorker: boolean;
	messageRoles: string[];
	grantedBytes: number;
}

export interface WorkerUsageRow {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
	latencyMs: number;
	provider?: string;
	model?: string;
}

export interface LiveGroqHost {
	settings: Settings;
	auth: AuthStorage;
	modelRegistry: ModelRegistry;
	model: NonNullable<ReturnType<typeof resolveModelFromString>>;
	tokenomics: OmpTokenomicsBridge;
	reasoning: string;
	close: () => void;
}

export function requireGroqApiKey(): void {
	if (!process.env.GROQ_API_KEY?.trim()) {
		throw new Error(
			"GROQ_API_KEY is required for live Groq evals. Export it and re-run live-groq-orchestrate.ts",
		);
	}
}

export async function createLiveGroqHost(options?: {
	reasoning?: string;
	contextPolicy?: ContextPolicy;
	sessionSuffix?: string;
}): Promise<LiveGroqHost> {
	requireGroqApiKey();
	const reasoning = options?.reasoning ?? process.env.RLM_GROQ_REASONING ?? "low";
	const settings = Settings.isolated({
		"rlm.enabled": true,
		"rlm.subModel": process.env.RLM_GROQ_SUBMODEL ?? DEFAULT_GROQ_MODEL,
		"rlm.workerMode": "evidence-packet",
		"context.engine": "rlm",
		thinkingLevel: reasoning,
	});
	const auth = await AuthStorage.create();
	const modelRegistry = new ModelRegistry(auth, undefined, { settings });
	await modelRegistry.refresh("online-if-uncached");
	const model =
		resolveModelFromString(process.env.RLM_GROQ_SUBMODEL ?? DEFAULT_GROQ_MODEL, modelRegistry.getAvailable(), {
			settings,
		}) ?? undefined;
	if (!model) throw new Error(`could not resolve model ${DEFAULT_GROQ_MODEL}`);
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) throw new Error(`no API key for ${model.provider}/${model.id}`);

	const tokenomics = createTokenomicsBridge({
		sessionId: `live-groq-${options?.sessionSuffix ?? Date.now()}`,
		dir: RESULTS_DIR,
		memoryOnly: process.env.RLM_GROQ_MEMORY_TOKENOMICS === "1",
		contextPolicy: options?.contextPolicy ?? "rlm-search-grants-groq",
	});

	return {
		settings,
		auth,
		modelRegistry,
		model,
		tokenomics,
		reasoning,
		close: () => auth.close(),
	};
}

function usageFromWorker(result: {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	tokens?: number;
	cost?: number;
}): Usage | undefined {
	if (result.inputTokens === undefined) return undefined;
	return {
		input: result.inputTokens,
		output: result.outputTokens ?? 0,
		cacheRead: result.cacheReadTokens ?? 0,
		cacheWrite: 0,
		totalTokens: result.tokens ?? result.inputTokens + (result.outputTokens ?? 0),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: result.cost ?? 0,
		},
	};
}

export function createEvidenceCompleter(host: LiveGroqHost): RlmCompleter {
	return async (prompt, options) => {
		const t0 = performance.now();
		const workerResult = await runRlmWorkerCompletion(
			{
				settings: host.settings,
				modelRegistry: host.modelRegistry,
				getSessionId: () => host.tokenomics.traceId,
			},
			prompt,
			{
				purpose: options?.purpose ?? "rlm-evidence-packet",
				workerMessages: options?.workerMessages,
				responseSchema: EVIDENCE_PACKET_V1_JSON_SCHEMA,
				signal: options?.signal,
			},
		);
		const latencyMs = performance.now() - t0;
		const usage = usageFromWorker(workerResult);
		let packetStatus: string | undefined;
		if (workerResult.structured && typeof workerResult.structured === "object") {
			const status = (workerResult.structured as { status?: unknown }).status;
			if (typeof status === "string") packetStatus = status;
		}
		await host.tokenomics.emitModelCall({
			role: "rlm_worker",
			name: "omp.rlm-evidence-packet",
			provider: workerResult.provider,
			model: workerResult.model,
			usage,
			costUsd: workerResult.cost,
			durationMs: latencyMs,
			attributes: {
				"omp.rlm.worker.provider": workerResult.provider ?? "unknown",
				"omp.rlm.packet.status": packetStatus ?? "unknown",
				"omp.rlm.packet.bytes": Buffer.byteLength(workerResult.text, "utf8"),
			},
		});
		return { ...workerResult, latencyMs } as never;
	};
}

export function createProseCompleter(host: LiveGroqHost): RlmCompleter {
	return async (prompt, options) => {
		const t0 = performance.now();
		const workerResult = await runRlmWorkerCompletion(
			{
				settings: host.settings,
				modelRegistry: host.modelRegistry,
				getSessionId: () => host.tokenomics.traceId,
			},
			prompt,
			{
				purpose: options?.purpose ?? "rlm-query",
				workerMessages: options?.workerMessages,
				signal: options?.signal,
			},
		);
		const latencyMs = performance.now() - t0;
		await host.tokenomics.emitModelCall({
			role: "rlm_worker",
			name: "omp.rlm-query-prose",
			provider: workerResult.provider,
			model: workerResult.model,
			usage: usageFromWorker(workerResult),
			costUsd: workerResult.cost,
			durationMs: latencyMs,
		});
		return { ...workerResult, latencyMs } as never;
	};
}

export function estimateTokens(bytes: number): number {
	return Math.max(1, Math.ceil(bytes / 4));
}

export function selectGrantsForFixture(
	store: RlmStore,
	handle: string,
	fixture: LiveFixture,
): RlmGrantSelectResult {
	return selectGrantsFromSearch(store, handle, fixture.patterns, {
		maxMatches: 4,
		contextChars: 512,
		maxTotalBytes: 8192,
		mode: "literal",
		...fixture.selectPolicy,
	});
}

export function firewallProof(
	context: { messages: readonly { role: string; content: string }[]; grantedBytes: number },
	fixture: LiveFixture,
	ungrantedHandle: string,
): FirewallProof {
	return {
		parentSecretInWorker: workerContextContains(context as never, fixture.parentSecret),
		grantedNeedleInWorker: workerContextContains(context as never, fixture.grantedNeedle),
		ungrantedHandleInWorker: workerContextContains(context as never, ungrantedHandle),
		messageRoles: context.messages.map(m => m.role),
		grantedBytes: context.grantedBytes,
	};
}

export function validateCitations(
	store: RlmStore,
	handle: string,
	packet: EvidencePacketV1,
): { validCount: number; invalidCount: number; wrongCitation: boolean } {
	let validCount = 0;
	let invalidCount = 0;
	for (const claim of packet.claims) {
		for (const cite of claim.citations) {
			const rec = store.get(cite.handle.includes("rlm://") ? cite.handle : handle);
			if (!rec) {
				invalidCount += 1;
				continue;
			}
			if (cite.start < 0 || cite.end > rec.text.length || cite.start >= cite.end) {
				invalidCount += 1;
				continue;
			}
			validCount += 1;
		}
	}
	return { validCount, invalidCount, wrongCitation: invalidCount > 0 && validCount === 0 };
}

export function semanticRetention(requiredFacts: string[], packet: EvidencePacketV1): number {
	if (requiredFacts.length === 0) return 1;
	const blob = [
		...packet.claims.map(c => c.fact),
		...packet.contradictions.flatMap(c => [c.left, c.right]),
	].join("\n").toLowerCase();
	const preserved = requiredFacts.filter(f => blob.includes(f.toLowerCase()));
	return preserved.length / requiredFacts.length;
}

export function labelEvidencePacket(
	fixture: LiveFixture,
	packet: EvidencePacketV1 | undefined,
	citationCheck: ReturnType<typeof validateCitations>,
): EvidenceLabel {
	if (!packet) return "UNSUPPORTED";
	if (citationCheck.wrongCitation && citationCheck.validCount === 0) return "WRONG_CITATION";
	const retention = semanticRetention(fixture.requiredFacts, packet);
	if (fixture.requiredFacts.length > 0 && retention < 0.5) return "MISSED_EVIDENCE";
	if (fixture.expectContradictions) {
		return packet.contradictions.length > 0 ? "SUPPORTED" : "UNSUPPORTED";
	}
	if (fixture.expectMissing) {
		const okStatus =
			packet.status === "partial" ||
			packet.status === "abstain" ||
			packet.missingEvidence.length > 0;
		return okStatus ? "PARTIAL_OK" : "UNSUPPORTED";
	}
	if (Array.isArray(fixture.expectStatus)) {
		return fixture.expectStatus.includes(packet.status) && retention >= 0.5 ? "SUPPORTED" : "UNSUPPORTED";
	}
	if (fixture.expectStatus && packet.status !== fixture.expectStatus) {
		return retention >= 0.5 ? "PARTIAL_OK" : "UNSUPPORTED";
	}
	return retention >= 0.5 ? "SUPPORTED" : "MISSED_EVIDENCE";
}

export function compressionRatio(grantedBytes: number, packetBytes: number): number {
	if (packetBytes <= 0) return grantedBytes;
	return grantedBytes / packetBytes;
}

export function workerUsageFromResult(result: {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	tokens?: number;
	cost?: number;
	latencyMs?: number;
	provider?: string;
	model?: string;
}): WorkerUsageRow {
	const inputTokens = result.inputTokens ?? 0;
	const outputTokens = result.outputTokens ?? 0;
	const cacheReadTokens = result.cacheReadTokens ?? 0;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		reasoningTokens: 0,
		totalTokens: result.tokens ?? inputTokens + outputTokens,
		costUsd: result.cost ?? 0,
		latencyMs: result.latencyMs ?? 0,
		provider: result.provider,
		model: result.model,
	};
}

export function buildRuntime(): RlmRuntime {
	resetRlmStoresForTest();
	return new RlmRuntime({ maxCalls: 16, maxTotalTokens: 500_000, maxCost: 5, wallClockMs: 0 });
}

export function spillFixture(runtime: RlmRuntime, fixture: LiveFixture): { handle: string; corpusBytes: number } {
	const corpus = `${fixture.buildCorpus()}\n${fixture.parentSecret}`;
	const rec = runtime.store.put(corpus, fixture.id);
	return { handle: rec.id, corpusBytes: rec.bytes };
}

export function d2StructuredOutputAvailable(): { available: false; reason: string } {
	return {
		available: false,
		reason:
			"worker-completion routes structured output via forced evidence_packet tool only; StreamOptions/completeSimple expose no responseFormat on the production OMP worker path (auth-gateway passthrough exists but is not wired)",
	};
}

export function buildCacheProbeMessages(
	runtime: RlmRuntime,
	handle: string,
	task: string,
	evidenceLine: string,
): ReturnType<typeof buildEvidenceWorkerContext> {
	const corpus = runtime.store.get(handle)?.text ?? evidenceLine;
	const at = corpus.indexOf(evidenceLine);
	const start = Math.max(0, at - 64);
	const end = Math.min(corpus.length, at + evidenceLine.length + 64);
	const view = resolveRlmView(runtime.store, [{ handle, start, end }]);
	return buildEvidenceWorkerContext(view, task);
}

export const LIVE_FIXTURES: LiveFixture[] = [
	{
		id: "S1_sufficient_causal",
		parentSecret: "PARENT_SECRET_S1_DO_NOT_LEAK",
		buildCorpus: () => {
			const prefix = `${"x".repeat(12_000)}\n`;
			const mid =
				"line 500: requests begin timing out only after active_connections reaches pool_limit\n";
			const midPad = `${"y".repeat(10_000)}\n`;
			const late = "line 910: downstream DB errors appear after timeout cascade\n";
			const suffix = `${"z".repeat(12_000)}`;
			return prefix + mid + midPad + late + suffix;
		},
		patterns: ["active_connections", "pool_limit", "timeout cascade"],
		question: "What is the likely first causal condition before downstream errors?",
		requiredFacts: ["pool_limit", "active_connections"],
		expectStatus: "sufficient",
		grantedNeedle: "active_connections reaches pool_limit",
	},
	{
		id: "S2_contradictory",
		parentSecret: "PARENT_SECRET_S2_DO_NOT_LEAK",
		buildCorpus: () => {
			const a = `${"a".repeat(8_000)}\nconfig: max_connections=100 for checkout pool\n`;
			const b = `${"b".repeat(8_000)}\n`;
			const c = "runtime: observed pool_limit=50 while active_connections=95 under load\n";
			const d = `${"d".repeat(8_000)}`;
			return a + b + c + d;
		},
		patterns: ["max_connections", "pool_limit"],
		question: "What is the effective connection pool limit under load?",
		requiredFacts: [],
		expectContradictions: true,
		grantedNeedle: "pool_limit=50",
	},
	{
		id: "S3_insufficient",
		parentSecret: "PARENT_SECRET_S3_DO_NOT_LEAK",
		buildCorpus: () => {
			const pad = `${"p".repeat(10_000)}\n`;
			const related = "database performance degraded after index rebuild on orders table\n";
			const tail = `${"q".repeat(10_000)}`;
			return pad + related + tail;
		},
		patterns: ["database", "performance", "index rebuild"],
		question: "What exact migration version caused the outage?",
		requiredFacts: [],
		expectMissing: true,
		expectStatus: ["partial", "abstain"],
		grantedNeedle: "index rebuild",
	},
	{
		id: "coding_log_diagnosis",
		parentSecret: "PARENT_SECRET_CODING_DO_NOT_LEAK",
		buildCorpus: () => {
			const head = `${"log ".repeat(6_000)}\n`;
			const body = `[2026-09-18 14:02:11] WARN connection pool 80% utilized checkout-service
[2026-09-18 14:05:33] ERROR query timeout after 30000ms sql=SELECT * FROM carts
[2026-09-18 14:05:34] INFO active_connections=100 pool_limit=100
[2026-09-18 14:06:01] ERROR checkout timeouts cascading to payment-api
[2026-09-18 14:06:02] NOTE misconfigured JDBC read-replica URL (not visible in ERROR lines alone)
`;
			const tail = `${"end ".repeat(6_000)}`;
			return head + body + tail;
		},
		patterns: ["ERROR", "pool_limit", "active_connections"],
		question: "What infrastructure condition most likely triggered the checkout timeouts?",
		requiredFacts: ["pool", "connection", "timeout"],
		expectStatus: ["sufficient", "partial"],
		grantedNeedle: "pool_limit=100",
	},
];

export function parsePacketFromResult(structured: unknown, text: string): EvidencePacketV1 | undefined {
	try {
		if (structured !== undefined) return parseEvidencePacketV1(structured);
		return parseEvidencePacketV1(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export function formatPacketSummary(packet: EvidencePacketV1 | undefined): string {
	if (!packet) return "(no packet)";
	return formatEvidencePacketForRoot(packet);
}
