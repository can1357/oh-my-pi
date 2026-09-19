/**
 * Shared live Groq RLM eval helpers — production ModelRegistry + worker completion path.
 */
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../../../src/config/model-registry";
import { resolveModelFromString } from "../../../src/config/model-resolver";
import { Settings } from "../../../src/config/settings";
import {
	EVIDENCE_PACKET_V2_JSON_SCHEMA,
	formatEvidencePacketForRoot,
	parseEvidencePacketV2,
	type EvidencePacketV2,
	type EvidencePacketStatus,
} from "../../../src/rlm/evidence-packet-v2";
import { validateEvidencePacket, type EvidenceValidationResult } from "../../../src/rlm/evidence-validator";
import { computeCodecMetrics, type CodecMetrics } from "./evidence-codec-rubric";
import { buildEvidenceWorkerRequest } from "../../../src/rlm/evidence-query";
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
import { formatHandle, type RlmStore } from "../../../src/rlm/store";
import { resolveRlmView } from "../../../src/rlm/view";
import {
	validateWorkerMembrane,
	workerContextContainsHandle,
} from "../../../src/rlm/worker-membrane";
import { AuthStorage } from "../../../src/session/auth-storage";

export const P0_CHECKPOINT_SHA = "53769bf12d48233bb262cd4bd61de93e18f400e8";
/** P0.2 semantic codec correctness checkpoint (frozen before invocation-threshold work). */
export const P02_CODEC_SHA = "0db7f4a0e4606a74e020e2a1080b9a80f8b8d6bd";

export type GrantBucket = "small" | "medium" | "large";
export type GrantComplexity = "simple" | "multi_region" | "dense_contradictory";
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
	/** Optional grant-size experiment metadata (codec invocation threshold study). */
	bucket?: GrantBucket;
	complexity?: GrantComplexity;
	grantCapTarget?: number;
	question: string;
	parentSecret: string;
	requiredFacts: string[];
	requiredAtoms?: Array<{ key: string; valuePattern?: RegExp; grantTextPattern?: RegExp }>;
	requiredRelations?: Array<{ id: string; atomKeys: string[]; pattern?: RegExp }>;
	requiredContradiction?: { leftGrantPattern: RegExp; rightGrantPattern: RegExp };
	expectStatus?: EvidencePacketStatus | EvidencePacketStatus[];
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
	if (process.env.GROQ_API_KEY?.trim()) return;
	throw new Error(
		"GROQ_API_KEY is required for live Groq evals. Run via ~/.omp/bin/omp-with-secrets (BWS) or export GROQ_API_KEY.",
	);
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
				getThinkingLevel: () => host.reasoning,
			},
			prompt,
			{
				purpose: options?.purpose ?? "rlm-evidence-packet",
				workerMessages: options?.workerMessages,
				responseSchema: EVIDENCE_PACKET_V2_JSON_SCHEMA,
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
				getThinkingLevel: () => host.reasoning,
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
	context: { messages: readonly { role: string; content: string }[]; grantedBytes: number; viewId?: string },
	fixture: LiveFixture,
	ungrantedHandle: string,
	view?: import("../../../src/rlm/view").RlmView,
): FirewallProof {
	const ctx = context as import("../../../src/rlm/broker").RlmWorkerContext;
	const membrane =
		view !== undefined
			? validateWorkerMembrane(ctx, view, {
					forbiddenNeedles: [fixture.parentSecret, "UNGRANTED_DECOY_HANDLE_CONTENT"],
				})
			: undefined;
	return {
		parentSecretInWorker: workerContextContains(ctx, fixture.parentSecret),
		grantedNeedleInWorker: workerContextContains(ctx, fixture.grantedNeedle),
		ungrantedHandleInWorker:
			membrane !== undefined
				? !membrane.ok && membrane.violations.some(v => v.kind === "ungranted_handle")
				: workerContextContainsHandle(ctx, ungrantedHandle),
		messageRoles: context.messages.map(m => m.role),
		grantedBytes: context.grantedBytes,
	};
}

export function validatePacketStructural(
	store: RlmStore,
	view: import("../../../src/rlm/view").RlmView,
	packet: EvidencePacketV2,
): EvidenceValidationResult {
	return validateEvidencePacket(store, view, packet);
}

export function validateCitations(
	store: RlmStore,
	view: import("../../../src/rlm/view").RlmView,
	packet: EvidencePacketV2,
): { validCount: number; invalidCount: number; wrongCitation: boolean } {
	const validation = validateEvidencePacket(store, view, packet);
	return {
		validCount: validation.validCitationCount,
		invalidCount: validation.totalCitationCount - validation.validCitationCount,
		wrongCitation: validation.totalCitationCount > 0 && validation.validCitationCount === 0,
	};
}

export function semanticRetention(requiredFacts: string[], packet: EvidencePacketV2): number {
	if (requiredFacts.length === 0) return 1;
	const blob = [
		...packet.atoms.map(a => `${a.key}=${a.value}`),
		...packet.claims.map(c => c.fact),
		...packet.contradictions.flatMap(c => [c.left.value, c.right.value]),
	].join("\n").toLowerCase();
	const preserved = requiredFacts.filter(f => blob.includes(f.toLowerCase()));
	return preserved.length / requiredFacts.length;
}

export function labelEvidencePacket(
	fixture: LiveFixture,
	packet: EvidencePacketV2 | undefined,
	metrics: CodecMetrics,
	validation: EvidenceValidationResult | undefined,
): EvidenceLabel {
	if (!packet) return "UNSUPPORTED";
	if (validation && validation.validCitationCount === 0 && validation.totalCitationCount > 0) return "WRONG_CITATION";

	if (fixture.expectContradictions) {
		return metrics.structuralValid && metrics.contradictionValid ? "SUPPORTED" : "UNSUPPORTED";
	}

	if (fixture.expectMissing) {
		const okStatus =
			packet.status === "partial" ||
			packet.status === "abstain" ||
			packet.missingEvidence.length > 0;
		const strongClaims = packet.claims.filter(c => c.confidence >= 0.7);
		return okStatus && strongClaims.length === 0 ? "PARTIAL_OK" : "UNSUPPORTED";
	}

	const atomOk = (fixture.requiredAtoms?.length ?? 0) === 0 || metrics.atomRecall >= 0.99;
	const relationOk = (fixture.requiredRelations?.length ?? 0) === 0 || metrics.relationRecall >= 0.99;

	if (fixture.requiredAtoms?.length || fixture.requiredRelations?.length) {
		if (atomOk && relationOk && metrics.structuralValid) return "SUPPORTED";
		if (metrics.atomRecall < 0.5 || metrics.relationRecall < 0.5) return "MISSED_EVIDENCE";
		return metrics.semanticRetention >= 0.5 ? "PARTIAL_OK" : "MISSED_EVIDENCE";
	}

	const retention = semanticRetention(fixture.requiredFacts, packet);
	if (fixture.requiredFacts.length > 0 && retention < 0.5) return "MISSED_EVIDENCE";
	if (Array.isArray(fixture.expectStatus)) {
		return fixture.expectStatus.includes(packet.status) && retention >= 0.5 ? "SUPPORTED" : "UNSUPPORTED";
	}
	if (fixture.expectStatus && packet.status !== fixture.expectStatus) {
		return retention >= 0.5 ? "PARTIAL_OK" : "UNSUPPORTED";
	}
	return retention >= 0.5 ? "SUPPORTED" : "MISSED_EVIDENCE";
}

/** Label C-arm prose using the same fixture gates as packet labeling. */
export function labelProseAnswer(
	fixture: LiveFixture,
	text: string,
	metrics: CodecMetrics,
): EvidenceLabel {
	if (fixture.expectContradictions) {
		return metrics.contradictionValid && metrics.structuralValid ? "SUPPORTED" : "UNSUPPORTED";
	}
	if (fixture.expectMissing) {
		const lower = text.toLowerCase();
		const claimsRootCause = /migration|version|exact cause|definitely/i.test(text);
		const abstains = /unknown|insufficient|cannot determine|not enough|no evidence/i.test(lower);
		return abstains && !claimsRootCause ? "PARTIAL_OK" : "UNSUPPORTED";
	}
	const atomOk = (fixture.requiredAtoms?.length ?? 0) === 0 || metrics.atomRecall >= 0.99;
	const relationOk = (fixture.requiredRelations?.length ?? 0) === 0 || metrics.relationRecall >= 0.99;
	if (fixture.requiredAtoms?.length || fixture.requiredRelations?.length) {
		if (atomOk && relationOk) return "SUPPORTED";
		if (metrics.atomRecall < 0.5 || metrics.relationRecall < 0.5) return "MISSED_EVIDENCE";
		return metrics.semanticRetention >= 0.5 ? "PARTIAL_OK" : "MISSED_EVIDENCE";
	}
	const retention = semanticRetention(fixture.requiredFacts, {
		status: "sufficient",
		atoms: [],
		claims: [{ fact: text, supports: [], citations: [], confidence: 1 }],
		contradictions: [],
		missingEvidence: [],
	});
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
): ReturnType<typeof buildEvidenceWorkerRequest> {
	const corpus = runtime.store.get(handle)?.text ?? evidenceLine;
	const at = corpus.indexOf(evidenceLine);
	const start = Math.max(0, at - 64);
	const end = Math.min(corpus.length, at + evidenceLine.length + 64);
	const view = resolveRlmView(runtime.store, [{ handle, start, end }]);
	return buildEvidenceWorkerRequest({ task, view });
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
		requiredFacts: [],
		requiredAtoms: [
			{ key: "pool_limit", grantTextPattern: /pool_limit/ },
			{ key: "active_connections", grantTextPattern: /active_connections/ },
		],
		requiredRelations: [
			{
				id: "causal_timeout",
				atomKeys: ["pool_limit", "active_connections"],
				pattern: /timeout|reaches pool_limit|active_connections/i,
			},
		],
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
		requiredContradiction: {
			leftGrantPattern: /max_connections=100/,
			rightGrantPattern: /pool_limit=50/,
		},
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
		requiredFacts: [],
		requiredAtoms: [
			{ key: "pool_limit", grantTextPattern: /pool_limit=100/ },
			{ key: "active_connections", grantTextPattern: /active_connections=100/ },
			{ key: "timeout", grantTextPattern: /timeout/ },
		],
		expectStatus: ["sufficient", "partial"],
		grantedNeedle: "pool_limit=100",
	},
];

export function parsePacketFromResult(structured: unknown, text: string): EvidencePacketV2 | undefined {
	try {
		if (structured !== undefined) return parseEvidencePacketV2(structured);
		return parseEvidencePacketV2(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export function formatPacketSummary(packet: EvidencePacketV2 | undefined): string {
	if (!packet) return "(no packet)";
	return formatEvidencePacketForRoot(packet);
}
