/**
 * Shared C vs D pair runner — identical frozen grants, comparable quality rubric on both arms.
 */
import type { RlmRuntime } from "../../../src/rlm";
import { rlmEvidenceQuery, rlmQuery } from "../../../src/rlm";
import { evidencePacketByteSize } from "../../../src/rlm/evidence-packet-v2";
import { resolveRlmView } from "../../../src/rlm/view";
import { computeCodecMetrics, computeProseMetrics } from "./evidence-codec-rubric";
import {
	createEvidenceCompleter,
	createProseCompleter,
	estimateTokens,
	labelEvidencePacket,
	labelProseAnswer,
	parsePacketFromResult,
	selectGrantsForFixture,
	spillFixture,
	buildRuntime,
	validateCitations,
	validatePacketStructural,
	workerUsageFromResult,
	type LiveFixture,
	type LiveGroqHost,
	type WorkerUsageRow,
} from "./live-groq-common";

export type CvDRow = Record<string, unknown>;

export interface CvDPairOptions {
	seed?: number;
	armOrderFirst?: "C" | "D";
}

function baseRow(
	fixture: LiveFixture,
	arm: "C-prose" | "D-packet",
	grantedBytes: number,
	meta: { seed: number; armOrder: string; runId: string },
): CvDRow {
	return {
		phase: "c_vs_d",
		arm,
		fixture: fixture.id,
		seed: meta.seed,
		runId: meta.runId,
		armOrder: meta.armOrder,
		bucket: fixture.bucket ?? "unknown",
		complexity: fixture.complexity ?? "unknown",
		replicationTier: (fixture as { replicationTier?: string }).replicationTier ?? "unknown",
		grantCapTarget: fixture.grantCapTarget ?? null,
		grantsFrozen: true,
		grantedBytes,
		grantedTokensEst: estimateTokens(grantedBytes),
	};
}

function armOrderForSeed(seed: number, fixtureId: string, prefer?: "C" | "D"): ["C", "D"] | ["D", "C"] {
	if (prefer === "C") return ["C", "D"];
	if (prefer === "D") return ["D", "C"];
	let h = seed + 1;
	for (const ch of fixtureId) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
	return h % 2 === 0 ? ["C", "D"] : ["D", "C"];
}

interface UsageCapture {
	usage: WorkerUsageRow | null;
	usageKnown: boolean;
	usageSource: "completer" | "query_result" | "broker" | "worker_skipped" | "unknown";
	completerCalled: boolean;
}

function captureUsage(
	completerCalled: boolean,
	completerRaw: unknown,
	queryResult: {
		tokens?: number;
		cost?: number;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		provider?: string;
		model?: string;
		workerUsageKnown?: boolean;
		workerSkipped?: boolean;
	},
	latencyMs: number,
): UsageCapture {
	if (queryResult.workerSkipped) {
		return { usage: null, usageKnown: true, usageSource: "worker_skipped", completerCalled: false };
	}
	if (queryResult.workerUsageKnown === true) {
		const row = workerUsageFromResult({ ...queryResult, latencyMs } as never);
		return { usage: row, usageKnown: true, usageSource: "broker", completerCalled };
	}
	if (completerCalled && typeof completerRaw !== "string") {
		const row = workerUsageFromResult({ ...(completerRaw as object), latencyMs } as never);
		if (row.inputTokens > 0 || row.outputTokens > 0 || row.costUsd > 0 || row.totalTokens > 0) {
			return { usage: row, usageKnown: true, usageSource: "completer", completerCalled: true };
		}
	}
	if (queryResult.tokens !== undefined || queryResult.cost !== undefined) {
		return {
			usage: workerUsageFromResult({
				inputTokens: queryResult.inputTokens,
				outputTokens: queryResult.outputTokens ?? queryResult.tokens,
				cacheReadTokens: queryResult.cacheReadTokens,
				tokens: queryResult.tokens,
				cost: queryResult.cost,
				latencyMs,
				provider: queryResult.provider,
				model: queryResult.model,
			}),
			usageKnown: false,
			usageSource: "query_result",
			completerCalled,
		};
	}
	return {
		usage: completerCalled && typeof completerRaw !== "string"
			? workerUsageFromResult({ ...(completerRaw as object), latencyMs } as never)
			: null,
		usageKnown: false,
		usageSource: "unknown",
		completerCalled,
	};
}

async function runProseArm(
	host: LiveGroqHost,
	runtime: RlmRuntime,
	fixture: LiveFixture,
	handle: string,
	grants: ReturnType<typeof selectGrantsForFixture>["grants"],
	grantedBytes: number,
	meta: { seed: number; armOrder: string; runId: string },
): Promise<CvDRow> {
	const prose = createProseCompleter(host);
	let completerRaw: unknown;
	let completerCalled = false;
	const proseTrack: typeof prose = async (prompt, options) => {
		completerCalled = true;
		completerRaw = await prose(prompt, options);
		return completerRaw as never;
	};

	const t0 = performance.now();
	const result = await rlmQuery(runtime, {
		handle,
		question: fixture.question,
		grants,
		complete: proseTrack,
	});
	const e2eMs = performance.now() - t0;
	const usageCapture = captureUsage(completerCalled, completerRaw, result, e2eMs);
	const cMetrics = computeProseMetrics(result.text, fixture, grantedBytes);
	const cAnswerBytes = Buffer.byteLength(result.text, "utf8");

	return {
		...baseRow(fixture, "C-prose", grantedBytes, meta),
		answerBytes: cAnswerBytes,
		rootTokensEst: estimateTokens(cAnswerBytes),
		usage: usageCapture.usageKnown ? usageCapture.usage : null,
		usageKnown: usageCapture.usageKnown,
		usageSource: usageCapture.usageSource,
		completerCalled: usageCapture.completerCalled,
		workerSkipped: false,
		e2eLatencyMs: e2eMs,
		evidenceLabel: labelProseAnswer(fixture, result.text, cMetrics),
		semanticRetention: cMetrics.semanticRetention,
		atomRecall: cMetrics.atomRecall,
		relationRecall: cMetrics.relationRecall,
		structuralValid: cMetrics.structuralValid,
		compressionRatio: cMetrics.compressionRatio,
		validationFailed: false,
		ts: Date.now(),
	};
}

async function runPacketArm(
	host: LiveGroqHost,
	runtime: RlmRuntime,
	fixture: LiveFixture,
	handle: string,
	grants: ReturnType<typeof selectGrantsForFixture>["grants"],
	grantedBytes: number,
	meta: { seed: number; armOrder: string; runId: string },
): Promise<CvDRow> {
	const evidence = createEvidenceCompleter(host);
	let completerRaw: unknown;
	let completerCalled = false;
	const evidenceTrack: typeof evidence = async (prompt, options) => {
		completerCalled = true;
		completerRaw = await evidence(prompt, options);
		return completerRaw as never;
	};

	const t0 = performance.now();
	const dResult = await rlmEvidenceQuery(runtime, {
		handle,
		question: fixture.question,
		grants,
		complete: evidenceTrack,
	});
	const e2eMs = performance.now() - t0;
	const usageCapture = captureUsage(
		completerCalled,
		completerRaw,
		{ tokens: dResult.tokens, cost: dResult.cost, inputTokens: dResult.inputTokens, outputTokens: dResult.outputTokens, cacheReadTokens: dResult.cacheReadTokens, provider: dResult.provider, model: dResult.model, workerUsageKnown: dResult.workerUsageKnown, workerSkipped: dResult.workerSkipped },
		e2eMs,
	);

	const view = resolveRlmView(runtime.store, grants);
	const packet = dResult.packet ?? parsePacketFromResult(undefined, dResult.text);
	const validation = packet
		? dResult.packetValidation ?? validatePacketStructural(runtime.store, view, packet)
		: undefined;
	const citations = packet
		? validateCitations(runtime.store, view, packet)
		: { validCount: 0, invalidCount: 0, wrongCitation: true };
	const dMetrics = computeCodecMetrics(packet, fixture, runtime.store, view, validation, grantedBytes);
	const dPacketBytes = packet ? evidencePacketByteSize(packet) : Buffer.byteLength(dResult.text, "utf8");

	return {
		...baseRow(fixture, "D-packet", grantedBytes, meta),
		packetBytes: dPacketBytes,
		rootTokensEst: estimateTokens(dPacketBytes),
		compressionRatio: dMetrics.compressionRatio,
		semanticRetention: dMetrics.semanticRetention,
		atomRecall: dMetrics.atomRecall,
		relationRecall: dMetrics.relationRecall,
		structuralValid: dMetrics.structuralValid,
		citationValidity: dMetrics.citationValidity,
		validationFailed: dResult.validationFailed ?? false,
		evidenceLabel: labelEvidencePacket(fixture, packet, dMetrics, validation),
		citationValidCount: citations.validCount,
		citationInvalidCount: citations.invalidCount,
		packetStatus: packet?.status,
		usage: usageCapture.usageKnown ? usageCapture.usage : null,
		usageKnown: usageCapture.usageKnown,
		usageSource: usageCapture.usageSource,
		completerCalled: usageCapture.completerCalled,
		workerSkipped: dResult.workerSkipped ?? false,
		e2eLatencyMs: e2eMs,
		ts: Date.now(),
	};
}

export async function runCvDPair(
	host: LiveGroqHost,
	fixture: LiveFixture,
	options?: CvDPairOptions,
): Promise<{ c: CvDRow; d: CvDRow }> {
	const seed = options?.seed ?? 0;
	const runtime = buildRuntime();
	const { handle } = spillFixture(runtime, fixture);
	const selection = selectGrantsForFixture(runtime.store, handle, fixture);
	if (selection.empty) {
		const err = { error: "no grants selected", ts: Date.now() };
		const meta = {
			seed,
			armOrder: "n/a",
			runId: `${fixture.id}#s${seed}`,
		};
		return {
			c: { ...baseRow(fixture, "C-prose", 0, meta), ...err },
			d: { ...baseRow(fixture, "D-packet", 0, meta), ...err },
		};
	}

	const grants = selection.grants;
	const grantedBytes = selection.grantedBytes;
	const order = armOrderForSeed(seed, fixture.id, options?.armOrderFirst);
	const meta = { seed, armOrder: order.join("→"), runId: `${fixture.id}#s${seed}` };

	let c: CvDRow;
	let d: CvDRow;
	if (order[0] === "D") {
		d = await runPacketArm(host, runtime, fixture, handle, grants, grantedBytes, meta);
		c = await runProseArm(host, runtime, fixture, handle, grants, grantedBytes, meta);
	} else {
		c = await runProseArm(host, runtime, fixture, handle, grants, grantedBytes, meta);
		d = await runPacketArm(host, runtime, fixture, handle, grants, grantedBytes, meta);
	}

	return { c, d };
}

export type LiveGroqHostType = LiveGroqHost;
