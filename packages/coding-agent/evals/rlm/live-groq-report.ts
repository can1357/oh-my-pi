#!/usr/bin/env bun
/** Report for evals/rlm/results/live-groq.jsonl */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(import.meta.dir, "results", "live-groq.jsonl");

type Row = Record<string, unknown>;

function load(): Row[] {
	if (!fs.existsSync(OUT)) {
		console.error(`missing ${OUT} — run: export GROQ_API_KEY=... && bun evals/rlm/live-groq-orchestrate.ts`);
		process.exit(2);
	}
	return fs
		.readFileSync(OUT, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Row);
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function main(): void {
	const rows = load();
	const meta = rows.find(r => r.phase === "meta");
	const smoke = rows.filter(r => r.phase === "smoke");
	const cache = rows.filter(r => r.phase === "cache");
	const cRows = rows.filter(r => r.phase === "c_vs_d" && r.arm === "C-prose");
	const dRows = rows.filter(r => r.phase === "c_vs_d" && r.arm === "D-packet");
	const tok = rows.find(r => r.phase === "tokenomics");

	console.log("=== Live Groq RLM P0 Report ===\n");
	console.log(`P0 SHA: ${meta?.p0_sha ?? "unknown"}`);
	console.log(`Model:  ${meta?.model ?? "unknown"}  reasoning=${meta?.reasoning ?? "?"}`);
	console.log(`D1:     ${meta?.d1 ?? "?"}`);
	console.log(`D2:     ${JSON.stringify(meta?.d2 ?? {})}\n`);

	console.log("--- Smoke (S1/S2/S3) ---");
	for (const r of smoke) {
		const fw = r.firewall as Record<string, unknown> | undefined;
		console.log(
			`${String(r.fixture).padEnd(22)} label=${String(r.evidenceLabel).padEnd(16)} status=${String(r.packetStatus ?? "-").padEnd(10)} citations=${r.citationValidCount}/${Number(r.citationValidCount) + Number(r.citationInvalidCount)} firewall_ok=${fw && !fw.parentSecretInWorker && fw.grantedNeedleInWorker && !fw.ungrantedHandleInWorker}`,
		);
	}

	console.log("\n--- Prompt cache (provider-reported cached_input_tokens) ---");
	for (const r of cache) {
		const u = r.usage as { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number } | undefined;
		console.log(
			`call ${r.call}: input=${u?.inputTokens ?? 0} cached=${u?.cacheReadTokens ?? 0} output=${u?.outputTokens ?? 0} ms=${Number(r.latencyMs).toFixed(0)}`,
		);
	}
	if (cache.length >= 2) {
		const c1 = (cache[0]?.usage as { cacheReadTokens?: number })?.cacheReadTokens ?? 0;
		const c2 = (cache[1]?.usage as { cacheReadTokens?: number })?.cacheReadTokens ?? 0;
		console.log(`cache trend call2-call1: ${c2 - c1} (positive suggests prefix cache hit)`);
	}

	console.log("\n--- C vs D (identical grants per fixture) ---");
	console.log("fixture               C_label          D_label          grantB  C_ansB  D_pktB  compress  C_retain  D_retain  C_ms    D_ms");
	console.log("-".repeat(110));
	for (const c of cRows) {
		const d = dRows.find(x => x.fixture === c.fixture);
		if (!d) continue;
		console.log(
			`${String(c.fixture).padEnd(21)} ${String(c.evidenceLabel).padEnd(16)} ${String(d.evidenceLabel).padEnd(16)} ${String(c.grantedBytes).padStart(6)} ${String(c.answerBytes).padStart(6)} ${String(d.packetBytes).padStart(6)} ${Number(d.compressionRatio).toFixed(1).padStart(8)} ${pct(Number(c.semanticRetention ?? 0)).padStart(8)} ${pct(Number(d.semanticRetention ?? 0)).padStart(8)} ${Number(c.e2eLatencyMs).toFixed(0).padStart(6)} ${Number(d.e2eLatencyMs).toFixed(0).padStart(6)}`,
		);
	}

	const coding = dRows.find(r => r.fixture === "coding_log_diagnosis");
	const codingC = cRows.find(r => r.fixture === "coding_log_diagnosis");
	if (coding && codingC) {
		console.log("\n--- Primary C vs D verdict (coding_log_diagnosis) ---");
		const dWin =
			coding.evidenceLabel !== "MISSED_EVIDENCE" &&
			Number(coding.semanticRetention) >= Number(codingC.semanticRetention ?? 0) &&
			Number(coding.rootTokensEst) <= Number(codingC.rootTokensEst);
		console.log(`D packet root tokens est: ${coding.rootTokensEst} vs C answer: ${codingC.rootTokensEst}`);
		console.log(`D semantic retention: ${pct(Number(coding.semanticRetention))}`);
		console.log(`D compression ratio: ${Number(coding.compressionRatio).toFixed(1)}x`);
		console.log(`P2 gate (D earns continuation): ${dWin ? "LIKELY YES — review smoke/cache" : "NOT YET — D did not beat C on retention/root-load"}`);
	}

	console.log("\n--- P0.2 codec metrics (smoke) ---");
	console.log("fixture               label            atomR  relR   struct  citeV  retain compress");
	console.log("-".repeat(95));
	for (const r of smoke) {
		console.log(
			`${String(r.fixture).padEnd(21)} ${String(r.evidenceLabel).padEnd(16)} ${Number(r.atomRecall ?? 0).toFixed(2).padStart(5)} ${Number(r.relationRecall ?? 0).toFixed(2).padStart(6)} ${String(r.structuralValid ?? false).padEnd(6)} ${Number(r.citationValidity ?? 0).toFixed(2).padStart(5)} ${Number(r.semanticRetention ?? 0).toFixed(2).padStart(6)} ${Number(r.compressionRatio ?? 0).toFixed(1).padStart(7)}`,
		);
	}


	console.log("\n--- Tokenomics ---");
	console.log(JSON.stringify(tok?.summary ?? {}, null, 2));
	console.log(`reconciliation_delta: ${tok?.reconciliationDelta ?? "n/a"}`);

	const smokePass = smoke.every(r => {
		const fw = r.firewall as Record<string, unknown> | undefined;
		return (
			!fw?.parentSecretInWorker &&
			fw?.grantedNeedleInWorker &&
			!fw?.ungrantedHandleInWorker &&
			r.schemaValid === true
		);
	});
	console.log(`\nRegression: run 'bun test test/rlm-*.test.ts' locally; smoke firewall+schema gate: ${smokePass ? "PASS" : "FAIL"}`);
}

main();
