#!/usr/bin/env bun
/** Crossover report for evals/rlm/results/codec-invocation.jsonl */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(import.meta.dir, "results", "codec-invocation.jsonl");

type Row = Record<string, unknown>;

function load(): Row[] {
	if (!fs.existsSync(OUT)) {
		console.error(`missing ${OUT} — run codec-invocation-orchestrate.ts first`);
		process.exit(2);
	}
	return fs
		.readFileSync(OUT, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Row);
}

function pct(n: number): string {
	return `${(n * 100).toFixed(0)}%`;
}

function num(row: Row, key: string): number {
	const v = row[key];
	return typeof v === "number" ? v : 0;
}

function cost(row: Row): number {
	const u = row.usage as { costUsd?: number } | null | undefined;
	return u?.costUsd ?? 0;
}

function verified(row: Row): boolean {
	const label = String(row.evidenceLabel ?? "");
	return label === "SUPPORTED" || label === "PARTIAL_OK";
}

/** Composite quality: label gate + atom/relation recall. */
function qualityScore(row: Row): number {
	const label = String(row.evidenceLabel ?? "");
	const labelScore =
		label === "SUPPORTED" ? 1 : label === "PARTIAL_OK" ? 0.75 : label === "MISSED_EVIDENCE" ? 0.35 : 0;
	const recall = (num(row, "atomRecall") + num(row, "relationRecall")) / 2;
	return labelScore * 0.55 + recall * 0.45;
}

function rootTokens(row: Row): number {
	return num(row, "rootTokensEst");
}

/** D earns invocation when verified quality is not worse and root load drops materially. */
function dWorthInvoking(c: Row, d: Row, minRootSavings = 0.12): boolean {
	const qDelta = qualityScore(d) - qualityScore(c);
	if (qualityScore(d) < 0.5) return false;
	if (qDelta < -0.08) return false;
	const cRoot = rootTokens(c);
	const dRoot = rootTokens(d);
	if (cRoot <= 0) return false;
	const rootSavings = (cRoot - dRoot) / cRoot;
	return rootSavings >= minRootSavings && verified(d);
}

/** C dominates when same-or-better quality with lower latency or cost and no root penalty. */
function cDominates(c: Row, d: Row): boolean {
	const qDelta = qualityScore(c) - qualityScore(d);
	if (qDelta < -0.05) return false;
	const cRoot = rootTokens(c);
	const dRoot = rootTokens(d);
	const rootOk = cRoot <= dRoot * 1.05;
	const faster = num(c, "e2eLatencyMs") < num(d, "e2eLatencyMs") * 0.85;
	const cheaper = cost(c) < cost(d) * 0.85 || (cost(d) === 0 && cost(c) === 0 && faster);
	return rootOk && (faster || cheaper) && verified(c);
}

function main(): void {
	const rows = load();
	const meta = rows.find(r => r.phase === "meta");
	const cRows = rows.filter(r => r.phase === "c_vs_d" && r.arm === "C-prose");
	const dRows = rows.filter(r => r.phase === "c_vs_d" && r.arm === "D-packet");
	const tok = rows.find(r => r.phase === "tokenomics");

	console.log("=== Codec Invocation Threshold Report (post P0.2) ===\n");
	console.log(`P0.2 SHA: ${meta?.p02_sha ?? "unknown"}`);
	console.log(`Model:    ${meta?.model ?? "unknown"}  reasoning=${meta?.reasoning ?? "?"}`);
	console.log(`Fixtures: ${meta?.fixtureCount ?? cRows.length}\n`);

	type Pair = { fixture: string; bucket: string; grantedBytes: number; c: Row; d: Row };
	const pairs: Pair[] = [];
	for (const c of cRows) {
		const d = dRows.find(r => r.fixture === c.fixture);
		if (!d) continue;
		pairs.push({
			fixture: String(c.fixture),
			bucket: String(c.bucket ?? "unknown"),
			grantedBytes: num(c, "grantedBytes"),
			c,
			d,
		});
	}
	pairs.sort((a, b) => a.grantedBytes - b.grantedBytes);

	console.log("--- Per-fixture C vs D (sorted by granted bytes) ---");
	console.log(
		"fixture                      bucket   grantB  C_Q  D_Q  C_root D_root save  C_ms   D_ms   C_$    D_$    verdict",
	);
	console.log("-".repeat(120));
	for (const p of pairs) {
		const cRoot = rootTokens(p.c);
		const dRoot = rootTokens(p.d);
		const save = cRoot > 0 ? (cRoot - dRoot) / cRoot : 0;
		const verdict = dWorthInvoking(p.c, p.d)
			? "D_invoke"
			: cDominates(p.c, p.d)
				? "C_default"
				: "mixed";
		console.log(
			`${p.fixture.padEnd(28)} ${p.bucket.padEnd(8)} ${String(p.grantedBytes).padStart(6)} ` +
				`${pct(qualityScore(p.c)).padStart(4)} ${pct(qualityScore(p.d)).padStart(4)} ` +
				`${String(cRoot).padStart(6)} ${String(dRoot).padStart(6)} ${pct(save).padStart(5)} ` +
				`${String(Math.round(num(p.c, "e2eLatencyMs"))).padStart(6)} ` +
				`${String(Math.round(num(p.d, "e2eLatencyMs"))).padStart(6)} ` +
				`${cost(p.c).toFixed(5).padStart(6)} ${cost(p.d).toFixed(5).padStart(6)}  ${verdict}`,
		);
	}

	const byBucket = new Map<string, Pair[]>();
	for (const p of pairs) {
		const list = byBucket.get(p.bucket) ?? [];
		list.push(p);
		byBucket.set(p.bucket, list);
	}

	console.log("\n--- Bucket summary ---");
	for (const bucket of ["small", "medium", "large", "unknown"]) {
		const list = byBucket.get(bucket);
		if (!list?.length) continue;
		const dWins = list.filter(p => dWorthInvoking(p.c, p.d)).length;
		const cWins = list.filter(p => cDominates(p.c, p.d)).length;
		const avgSave =
			list.reduce((acc, p) => {
				const cR = rootTokens(p.c);
				return acc + (cR > 0 ? (cR - rootTokens(p.d)) / cR : 0);
			}, 0) / list.length;
		console.log(
			`${bucket.padEnd(8)} n=${list.length}  C_default=${cWins}  D_invoke=${dWins}  avg_root_save=${pct(avgSave)}`,
		);
	}

	const crossover = pairs.filter(p => dWorthInvoking(p.c, p.d)).sort((a, b) => a.grantedBytes - b.grantedBytes)[0];

	console.log("\n--- Crossover hypothesis ---");
	if (crossover) {
		console.log(
			`First D_invoke at grantedBytes=${crossover.grantedBytes} (${crossover.fixture}, bucket=${crossover.bucket})`,
		);
		console.log(
			`  C: ${crossover.c.evidenceLabel} q=${pct(qualityScore(crossover.c))} root=${rootTokens(crossover.c)} ` +
				`${Math.round(num(crossover.c, "e2eLatencyMs"))}ms`,
		);
		console.log(
			`  D: ${crossover.d.evidenceLabel} q=${pct(qualityScore(crossover.d))} root=${rootTokens(crossover.d)} ` +
				`compress=${num(crossover.d, "compressionRatio").toFixed(1)}x ` +
				`${Math.round(num(crossover.d, "e2eLatencyMs"))}ms`,
		);
	} else {
		console.log("No fixture met D_invoke threshold (verified quality + ≥12% root savings). C remains default.");
	}

	const smallPairs = pairs.filter(p => p.bucket === "small");
	const largePairs = pairs.filter(p => p.bucket === "large");
	if (smallPairs.length && largePairs.length) {
		const smallCDefault = smallPairs.filter(p => cDominates(p.c, p.d)).length / smallPairs.length;
		const largeDInvoke = largePairs.filter(p => dWorthInvoking(p.c, p.d)).length / largePairs.length;
		console.log(
			`\nHypothesis check: small bucket C_default rate=${pct(smallCDefault)} | large bucket D_invoke rate=${pct(largeDInvoke)}`,
		);
	}

	const flake = pairs.filter(p => {
		const d = p.d;
		return d.validationFailed === true || (d.usage === null && String(d.evidenceLabel) !== "PARTIAL_OK");
	});
	if (flake.length) {
		console.log(`\nTool-call / validation flake rows: ${flake.length}/${pairs.length} (track, do not reopen P0.2 unless verified outcomes shift)`);
	}

	console.log("\n--- Tokenomics (session) ---");
	console.log(JSON.stringify(tok?.summary ?? {}, null, 2));

	console.log("\nPolicy draft (pre-Kerdoios): invoke codec when grantedBytes ≥ crossover AND task needs structured retention; else C.");
}

main();
