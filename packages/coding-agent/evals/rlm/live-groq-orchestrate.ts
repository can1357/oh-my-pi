#!/usr/bin/env bun
/**
 * Live Groq RLM P0 validation — production path smoke, cache probe, C vs D.
 *
 *   ~/.omp/bin/omp-with-secrets bun evals/rlm/live-groq-orchestrate.ts
 *   # or: export GROQ_API_KEY=... && bun evals/rlm/live-groq-orchestrate.ts
 *   bun evals/rlm/live-groq-report.ts
 *
 * Optional:
 *   RLM_GROQ_SUBMODEL=groq/openai/gpt-oss-20b
 *   RLM_GROQ_REASONING=low
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { rlmEvidenceQuery, rlmQuery } from "../../src/rlm";
import { evidencePacketByteSize } from "../../src/rlm/evidence-packet";
import {
	buildCacheProbeMessages,
	buildRuntime,
	compressionRatio,
	createEvidenceCompleter,
	createLiveGroqHost,
	createProseCompleter,
	d2StructuredOutputAvailable,
	estimateTokens,
	firewallProof,
	formatPacketSummary,
	labelEvidencePacket,
	LIVE_FIXTURES,
	P0_CHECKPOINT_SHA,
	parsePacketFromResult,
	RESULTS_DIR,
	selectGrantsForFixture,
	semanticRetention,
	spillFixture,
	validateCitations,
	workerUsageFromResult,
	type LiveFixture,
} from "./lib/live-groq-common";

const OUT = path.join(RESULTS_DIR, "live-groq.jsonl");
const SMOKE_FIXTURES = LIVE_FIXTURES.filter(f => f.id.startsWith("S"));
const CVS_FIXTURES = LIVE_FIXTURES;

type Row = Record<string, unknown>;

function mkdirp(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
}

function append(row: Row): void {
	fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

async function runSmoke(host: Awaited<ReturnType<typeof createLiveGroqHost>>, fixture: LiveFixture): Promise<Row> {
	const runtime = buildRuntime();
	const { handle } = spillFixture(runtime, fixture);
	const decoy = runtime.store.put("UNGRANTED_DECOY_HANDLE_CONTENT", "decoy");
	const selection = selectGrantsForFixture(runtime.store, handle, fixture);
	if (selection.empty) {
		return {
			phase: "smoke",
			fixture: fixture.id,
			error: "no grants selected",
			ts: Date.now(),
		};
	}

	let lastWorkerUsage: ReturnType<typeof workerUsageFromResult> | null = null;
	const evidence = createEvidenceCompleter(host);
	const trackingEvidence: typeof evidence = async (prompt, options) => {
		const raw = await evidence(prompt, options);
		if (typeof raw !== "string") lastWorkerUsage = workerUsageFromResult(raw as never);
		return raw;
	};

	const t0 = performance.now();
	const result = await rlmEvidenceQuery(runtime, {
		handle,
		question: fixture.question,
		grants: selection.grants,
		complete: trackingEvidence,
	});
	const e2eMs = performance.now() - t0;

	const packet = result.packet ?? parsePacketFromResult(undefined, result.text);
	const citations = packet ? validateCitations(runtime.store, handle, packet) : { validCount: 0, invalidCount: 0, wrongCitation: true };
	const label = labelEvidencePacket(fixture, packet, citations);
	const fw = result.context
		? firewallProof(result.context, fixture, decoy.id)
		: {
				parentSecretInWorker: true,
				grantedNeedleInWorker: false,
				ungrantedHandleInWorker: true,
				messageRoles: [],
				grantedBytes: result.grantedBytes ?? 0,
			};

	const workerSkipped = "workerSkipped" in result && result.workerSkipped === true;

	return {
		phase: "smoke",
		p0_sha: P0_CHECKPOINT_SHA,
		fixture: fixture.id,
		model: `${host.model.provider}/${host.model.id}`,
		reasoning: host.reasoning,
		workerSkipped,
		grantedBytes: result.grantedBytes ?? selection.grantedBytes,
		grantedTokensEst: estimateTokens(result.grantedBytes ?? selection.grantedBytes),
		packetBytes: packet ? evidencePacketByteSize(packet) : 0,
		packetStatus: packet?.status,
		evidenceLabel: label,
		schemaValid: packet !== undefined,
		citationValidCount: citations.validCount,
		citationInvalidCount: citations.invalidCount,
		semanticRetention: packet ? semanticRetention(fixture.requiredFacts, packet) : 0,
		contradictions: packet?.contradictions.length ?? 0,
		missingEvidence: packet?.missingEvidence.length ?? 0,
		firewall: fw,
		usage: workerSkipped ? null : lastWorkerUsage,
		e2eLatencyMs: e2eMs,
		packetPreview: packet ? formatPacketSummary(packet).slice(0, 500) : result.text.slice(0, 300),
		ts: Date.now(),
	};
}

async function runCacheProbe(host: Awaited<ReturnType<typeof createLiveGroqHost>>): Promise<Row[]> {
	const runtime = buildRuntime();
	const fixture = LIVE_FIXTURES[0]!;
	const { handle } = spillFixture(runtime, fixture);
	const evidence = createEvidenceCompleter(host);
	const lines = [
		"line 500: requests begin timing out only after active_connections reaches pool_limit",
		"line 910: downstream DB errors appear after timeout cascade",
		"line 1200: cache probe variant C with pool_limit saturation",
	];
	const rows: Row[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const ctx = buildCacheProbeMessages(runtime, handle, `Cache probe ${i + 1}: first causal condition?`, line);
		const t0 = performance.now();
		const raw = await evidence(ctx.prompt, {
			purpose: "rlm-evidence-packet",
			workerMessages: ctx.messages,
		});
		const latencyMs = performance.now() - t0;
		const usage = typeof raw === "string" ? null : workerUsageFromResult(raw as never);
		rows.push({
			phase: "cache",
			call: i + 1,
			evidenceLine: line.slice(0, 60),
			usage,
			latencyMs,
			ts: Date.now(),
		});
	}
	return rows;
}

async function runCvD(
	host: Awaited<ReturnType<typeof createLiveGroqHost>>,
	fixture: LiveFixture,
): Promise<{ c: Row; d: Row }> {
	const runtime = buildRuntime();
	const { handle } = spillFixture(runtime, fixture);
	const selection = selectGrantsForFixture(runtime.store, handle, fixture);
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

	const packet = dResult.packet ?? parsePacketFromResult(undefined, dResult.text);
	const citations = packet
		? validateCitations(runtime.store, handle, packet)
		: { validCount: 0, invalidCount: 0, wrongCitation: true };
	const dPacketBytes = packet ? evidencePacketByteSize(packet) : Buffer.byteLength(dResult.text, "utf8");
	const cAnswerBytes = Buffer.byteLength(cResult.text, "utf8");

	const cRow: Row = {
		phase: "c_vs_d",
		arm: "C-prose",
		fixture: fixture.id,
		grantsFrozen: true,
		grantedBytes,
		grantedTokensEst: estimateTokens(grantedBytes),
		answerBytes: cAnswerBytes,
		rootTokensEst: estimateTokens(cAnswerBytes),
		usage: cUsage,
		e2eLatencyMs: cMs,
		evidenceLabel: fixture.requiredFacts.some(f => cResult.text.toLowerCase().includes(f.toLowerCase()))
			? "SUPPORTED"
			: "MISSED_EVIDENCE",
		semanticRetention: fixture.requiredFacts.length
			? fixture.requiredFacts.filter(f => cResult.text.toLowerCase().includes(f.toLowerCase())).length /
				fixture.requiredFacts.length
			: 1,
		ts: Date.now(),
	};

	const dRow: Row = {
		phase: "c_vs_d",
		arm: "D-packet",
		fixture: fixture.id,
		grantsFrozen: true,
		grantedBytes,
		grantedTokensEst: estimateTokens(grantedBytes),
		packetBytes: dPacketBytes,
		rootTokensEst: estimateTokens(dPacketBytes),
		compressionRatio: compressionRatio(grantedBytes, dPacketBytes),
		semanticRetention: packet ? semanticRetention(fixture.requiredFacts, packet) : 0,
		evidenceLabel: labelEvidencePacket(fixture, packet, citations),
		citationValidCount: citations.validCount,
		citationInvalidCount: citations.invalidCount,
		packetStatus: packet?.status,
		usage: dUsage,
		e2eLatencyMs: dMs,
		ts: Date.now(),
	};

	return { c: cRow, d: dRow };
}

async function main(): Promise<void> {
	mkdirp(OUT);
	if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

	const host = await createLiveGroqHost({ sessionSuffix: "orchestrate" });
	try {
		append({
			phase: "meta",
			p0_sha: P0_CHECKPOINT_SHA,
			model: `${host.model.provider}/${host.model.id}`,
			reasoning: host.reasoning,
			d1: "forced evidence_packet tool via runRlmWorkerCompletion",
			d2: d2StructuredOutputAvailable(),
			ts: Date.now(),
		});

		for (const fixture of SMOKE_FIXTURES) {
			console.log(`smoke ${fixture.id}...`);
			const row = await runSmoke(host, fixture);
			append(row);
			console.log(`  label=${row.evidenceLabel} workerSkipped=${row.workerSkipped}`);
		}

		console.log("cache probe (3 calls, stable prefix)...");
		for (const row of await runCacheProbe(host)) {
			append(row);
			const u = row.usage as { cacheReadTokens?: number; inputTokens?: number } | null;
			console.log(`  call ${row.call}: cacheRead=${u?.cacheReadTokens ?? 0} input=${u?.inputTokens ?? 0}`);
		}

		for (const fixture of CVS_FIXTURES) {
			console.log(`C vs D ${fixture.id}...`);
			const { c, d } = await runCvD(host, fixture);
			append(c);
			append(d);
			console.log(`  C=${c.evidenceLabel} D=${d.evidenceLabel} compression=${d.compressionRatio}`);
		}

		const summary = host.tokenomics.summary();
		append({
			phase: "tokenomics",
			traceId: host.tokenomics.traceId,
			summary,
			reconciliationDelta: summary?.reconciliation_delta ?? null,
			ts: Date.now(),
		});
	} finally {
		host.close();
	}

	console.log(`wrote ${OUT}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
