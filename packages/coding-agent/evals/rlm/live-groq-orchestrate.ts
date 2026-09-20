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
import { rlmEvidenceQuery } from "../../src/rlm";
import { resolveRlmView } from "../../src/rlm/view";
import { evidencePacketByteSize } from "../../src/rlm/evidence-packet-v2";
import { runCvDPair } from "./lib/live-groq-cvd";
import {
	buildCacheProbeMessages,
	buildRuntime,
	createEvidenceCompleter,
	createLiveGroqHost,
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
	spillFixture,
	validateCitations,
	workerUsageFromResult,
	validatePacketStructural,
	type LiveFixture,
} from "./lib/live-groq-common";
import { computeCodecMetrics } from "./lib/evidence-codec-rubric";

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
	const view = resolveRlmView(runtime.store, selection.grants);

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
	const validation = packet
		? result.packetValidation ?? validatePacketStructural(runtime.store, view, packet)
		: undefined;
	const citations = packet
		? validateCitations(runtime.store, view, packet)
		: { validCount: 0, invalidCount: 0, wrongCitation: true };
	const metrics = computeCodecMetrics(
		packet,
		fixture,
		runtime.store,
		view,
		validation,
		result.grantedBytes ?? selection.grantedBytes,
	);
	const label = labelEvidencePacket(fixture, packet, metrics, validation);
	const fw = result.context
		? firewallProof(result.context, fixture, decoy.id, view)
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
		semanticRetention: metrics.semanticRetention,
		atomRecall: metrics.atomRecall,
		relationRecall: metrics.relationRecall,
		structuralValid: metrics.structuralValid,
		citationValidity: metrics.citationValidity,
		validationFailed: result.validationFailed ?? false,
		compressionRatio: metrics.compressionRatio,
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
		let raw: Awaited<ReturnType<typeof evidence>>;
		try {
			raw = await evidence(ctx.prompt, {
				purpose: "rlm-evidence-packet",
				workerMessages: ctx.messages,
			});
		} catch (error) {
			rows.push({
				phase: "cache",
				call: i + 1,
				error: error instanceof Error ? error.message : String(error),
				latencyMs: performance.now() - t0,
				ts: Date.now(),
			});
			continue;
		}
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
	return runCvDPair(host, fixture);
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
			packetSchema: "EvidencePacketV2",
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
