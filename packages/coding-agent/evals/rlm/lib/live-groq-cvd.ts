/**
 * Shared C vs D pair runner — identical frozen grants, comparable quality rubric on both arms.
 */
import { rlmEvidenceQuery, rlmQuery } from "../../../src/rlm";
import { evidencePacketByteSize } from "../../../src/rlm/evidence-packet-v2";
import { resolveRlmView } from "../../../src/rlm/view";
import { computeCodecMetrics, computeProseMetrics } from "./evidence-codec-rubric";
import {
	createEvidenceCompleter,
	createLiveGroqHost,
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
} from "./live-groq-common";

export type CvDRow = Record<string, unknown>;

function baseRow(fixture: LiveFixture, arm: "C-prose" | "D-packet", grantedBytes: number): CvDRow {
	return {
		phase: "c_vs_d",
		arm,
		fixture: fixture.id,
		bucket: fixture.bucket ?? "unknown",
		complexity: fixture.complexity ?? "unknown",
		grantCapTarget: fixture.grantCapTarget ?? null,
		grantsFrozen: true,
		grantedBytes,
		grantedTokensEst: estimateTokens(grantedBytes),
	};
}

export async function runCvDPair(host: LiveGroqHost, fixture: LiveFixture): Promise<{ c: CvDRow; d: CvDRow }> {
	const runtime = buildRuntime();
	const { handle } = spillFixture(runtime, fixture);
	const selection = selectGrantsForFixture(runtime.store, handle, fixture);
	if (selection.empty) {
		const err = { error: "no grants selected", ts: Date.now() };
		return {
			c: { ...baseRow(fixture, "C-prose", 0), ...err },
			d: { ...baseRow(fixture, "D-packet", 0), ...err },
		};
	}
	const grants = selection.grants;
	const grantedBytes = selection.grantedBytes;
	const prose = createProseCompleter(host);
	const evidence = createEvidenceCompleter(host);
	let cUsage: ReturnType<typeof workerUsageFromResult> | null = null;
	let dUsage: ReturnType<typeof workerUsageFromResult> | null = null;
	const proseTrack: typeof prose = async (prompt, options) => {
		const raw = await prose(prompt, options);
		if (typeof raw !== "string") cUsage = workerUsageFromResult(raw as never);
		return raw;
	};
	const evidenceTrack: typeof evidence = async (prompt, options) => {
		const raw = await evidence(prompt, options);
		if (typeof raw !== "string") dUsage = workerUsageFromResult(raw as never);
		return raw;
	};

	const tC0 = performance.now();
	const cResult = await rlmQuery(runtime, {
		handle,
		question: fixture.question,
		grants,
		complete: proseTrack,
	});
	const cMs = performance.now() - tC0;

	const tD0 = performance.now();
	const dResult = await rlmEvidenceQuery(runtime, {
		handle,
		question: fixture.question,
		grants,
		complete: evidenceTrack,
	});
	const dMs = performance.now() - tD0;

	const view = resolveRlmView(runtime.store, grants);
	const packet = dResult.packet ?? parsePacketFromResult(undefined, dResult.text);
	const validation = packet
		? dResult.packetValidation ?? validatePacketStructural(runtime.store, view, packet)
		: undefined;
	const citations = packet
		? validateCitations(runtime.store, view, packet)
		: { validCount: 0, invalidCount: 0, wrongCitation: true };

	const cMetrics = computeProseMetrics(cResult.text, fixture, grantedBytes);
	const dMetrics = computeCodecMetrics(packet, fixture, runtime.store, view, validation, grantedBytes);
	const dPacketBytes = packet ? evidencePacketByteSize(packet) : Buffer.byteLength(dResult.text, "utf8");
	const cAnswerBytes = Buffer.byteLength(cResult.text, "utf8");
	const cLabel = labelProseAnswer(fixture, cResult.text, cMetrics);
	const dLabel = labelEvidencePacket(fixture, packet, dMetrics, validation);

	const cRow: CvDRow = {
		...baseRow(fixture, "C-prose", grantedBytes),
		answerBytes: cAnswerBytes,
		rootTokensEst: estimateTokens(cAnswerBytes),
		usage: cUsage,
		e2eLatencyMs: cMs,
		evidenceLabel: cLabel,
		semanticRetention: cMetrics.semanticRetention,
		atomRecall: cMetrics.atomRecall,
		relationRecall: cMetrics.relationRecall,
		structuralValid: cMetrics.structuralValid,
		compressionRatio: cMetrics.compressionRatio,
		validationFailed: false,
		ts: Date.now(),
	};

	const dRow: CvDRow = {
		...baseRow(fixture, "D-packet", grantedBytes),
		packetBytes: dPacketBytes,
		rootTokensEst: estimateTokens(dPacketBytes),
		compressionRatio: dMetrics.compressionRatio,
		semanticRetention: dMetrics.semanticRetention,
		atomRecall: dMetrics.atomRecall,
		relationRecall: dMetrics.relationRecall,
		structuralValid: dMetrics.structuralValid,
		citationValidity: dMetrics.citationValidity,
		validationFailed: dResult.validationFailed ?? false,
		evidenceLabel: dLabel,
		citationValidCount: citations.validCount,
		citationInvalidCount: citations.invalidCount,
		packetStatus: packet?.status,
		usage: dUsage,
		e2eLatencyMs: dMs,
		ts: Date.now(),
	};

	return { c: cRow, d: dRow };
}

export type LiveGroqHostType = LiveGroqHost;
