#!/usr/bin/env bun
/** Replicated crossover report for evals/rlm/results/codec-invocation.jsonl */
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

function verified(row: Row): boolean {
	const label = String(row.evidenceLabel ?? "");
	return label === "SUPPORTED" || label === "PARTIAL_OK";
}

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

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[idx] ?? 0;
}

function knownCost(row: Row): number | null {
	if (row.usageKnown === false) return null;
	const u = row.usage as { costUsd?: number } | null;
	if (!u) return row.usageSource === "worker_skipped" ? 0 : null;
	return u.costUsd ?? 0;
}

function complexityPolicyVerdict(complexity: string, cVerifiedRate: number, dVerifiedRate: number): string {
	switch (complexity) {
		case "simple":
			return cVerifiedRate >= dVerifiedRate ? "C_default" : "mixed";
		case "multi_region":
			return dVerifiedRate >= 0.66 ? "D_invoke" : "mixed";
		case "dense_contradictory":
			if (String(complexity).includes("contradict") || dVerifiedRate > cVerifiedRate) return dVerifiedRate >= 0.66 ? "D_quality" : "mixed";
			return dVerifiedRate >= cVerifiedRate ? "D_invoke" : "mixed";
		default:
			return "mixed";
	}
}

function main(): void {
	const rows = load();
	const meta = rows.find(r => r.phase === "meta");
	const cRows = rows.filter(r => r.phase === "c_vs_d" && r.arm === "C-prose");
	const dRows = rows.filter(r => r.phase === "c_vs_d" && r.arm === "D-packet");
	const tok = rows.find(r => r.phase === "tokenomics");

	console.log("=== Codec Invocation Report (replicated, post P0.2) ===\n");
	console.log(`P0.2 SHA: ${meta?.p02_sha ?? "unknown"}`);
	console.log(`Model:    ${meta?.model ?? "unknown"}  reasoning=${meta?.reasoning ?? "?"}`);
	console.log(`Runs:     ${meta?.totalRuns ?? cRows.length} pair-seeds across ${meta?.fixtureCount ?? "?"} fixtures\n`);

	type Pair = { fixture: string; seed: number; tier: string; complexity: string; grantedBytes: number; c: Row; d: Row };
	const pairs: Pair[] = [];
	for (const c of cRows) {
		const seed = num(c, "seed");
		const d = dRows.find(r => r.fixture === c.fixture && num(r, "seed") === seed);
		if (!d) continue;
		pairs.push({
			fixture: String(c.fixture),
			seed,
			tier: String(c.replicationTier ?? "unknown"),
			complexity: String(c.complexity ?? "unknown"),
			grantedBytes: num(c, "grantedBytes"),
			c,
			d,
		});
	}

	// --- Economics: known vs unknown ---
	let cKnown = 0;
	let cUnknown = 0;
	let dKnown = 0;
	let dUnknown = 0;
	let knownCostSumC = 0;
	let knownCostSumD = 0;
	for (const p of pairs) {
		const cc = knownCost(p.c);
		const dc = knownCost(p.d);
		if (cc === null) cUnknown += 1;
		else {
			cKnown += 1;
			knownCostSumC += cc;
		}
		if (dc === null) dUnknown += 1;
		else {
			dKnown += 1;
			knownCostSumD += dc;
		}
	}
	console.log("--- Economics (missing D usage = unknown, NOT zero) ---");
	console.log(`C cost: known=${cKnown} unknown=${cUnknown} sum=$${knownCostSumC.toFixed(5)}`);
	console.log(`D cost: known=${dKnown} unknown=${dUnknown} sum=$${knownCostSumD.toFixed(5)}`);
	if (dUnknown > 0) console.log(`  ⚠ D unknown bucket: ${dUnknown}/${pairs.length} rows — do not treat as $0\n`);
	else console.log("");

	// --- Aggregate by fixture ---
	const byFixture = new Map<string, Pair[]>();
	for (const p of pairs) {
		const list = byFixture.get(p.fixture) ?? [];
		list.push(p);
		byFixture.set(p.fixture, list);
	}

	console.log("--- Per-fixture replication summary ---");
	console.log(
		"fixture                      tier       seeds grantB  C_verified D_verified C_atom D_atom C_root D_root save   C_p50  D_p50  policy",
	);
	console.log("-".repeat(130));

	const tierStats = new Map<string, { cWins: number; dWins: number; n: number }>();

	for (const [fixture, list] of [...byFixture.entries()].sort((a, b) => a[1][0]!.grantedBytes - b[1][0]!.grantedBytes)) {
		const grantedBytes = list[0]!.grantedBytes;
		const tier = list[0]!.tier;
		const complexity = list[0]!.complexity;
		const cVerifiedRate = list.filter(p => verified(p.c)).length / list.length;
		const dVerifiedRate = list.filter(p => verified(p.d)).length / list.length;
		const cAtom = list.reduce((a, p) => a + num(p.c, "atomRecall"), 0) / list.length;
		const dAtom = list.reduce((a, p) => a + num(p.d, "atomRecall"), 0) / list.length;
		const cRoot = list.reduce((a, p) => a + rootTokens(p.c), 0) / list.length;
		const dRoot = list.reduce((a, p) => a + rootTokens(p.d), 0) / list.length;
		const save = cRoot > 0 ? (cRoot - dRoot) / cRoot : 0;
		const cLat = list.map(p => num(p.c, "e2eLatencyMs"));
		const dLat = list.map(p => num(p.d, "e2eLatencyMs"));
		const policy =
			complexity === "simple"
				? cVerifiedRate >= dVerifiedRate && dRoot > cRoot
					? "C_default"
					: cVerifiedRate >= dVerifiedRate
						? "C_default"
						: "mixed"
				: complexity === "multi_region"
					? dVerifiedRate >= 0.66 && dAtom >= cAtom
						? "D_invoke"
						: "mixed"
					: complexity === "dense_contradictory"
						? dVerifiedRate > cVerifiedRate
							? "D_quality"
							: "mixed"
						: "mixed";

		const stats = tierStats.get(tier) ?? { cWins: 0, dWins: 0, n: 0 };
		stats.n += 1;
		if (policy === "C_default") stats.cWins += 1;
		if (policy.startsWith("D")) stats.dWins += 1;
		tierStats.set(tier, stats);

		console.log(
			`${fixture.padEnd(28)} ${tier.padEnd(10)} ${String(list.length).padStart(5)} ${String(grantedBytes).padStart(6)} ` +
				`${pct(cVerifiedRate).padStart(10)} ${pct(dVerifiedRate).padStart(10)} ` +
				`${cAtom.toFixed(2).padStart(6)} ${dAtom.toFixed(2).padStart(6)} ` +
				`${Math.round(cRoot).toString().padStart(6)} ${Math.round(dRoot).toString().padStart(6)} ${pct(save).padStart(5)} ` +
				`${Math.round(percentile(cLat, 0.5)).toString().padStart(6)} ${Math.round(percentile(dLat, 0.5)).toString().padStart(6)}  ${policy}`,
		);
	}

	console.log("\n--- Tier rollup (complexity-first policy draft) ---");
	for (const tier of ["boundary", "small", "medium", "dense_log", "contradiction"]) {
		const s = tierStats.get(tier);
		if (!s) continue;
		console.log(`${tier.padEnd(14)} fixtures=${s.n}  C_default=${s.cWins}  D_invoke/quality=${s.dWins}`);
	}

	console.log("\n--- Complexity-first gate (NOT grantedBytes >= 550) ---");
	console.log("  simple + single-fact           → C (prose)");
	console.log("  multi_region causal            → D (evidence_packet)");
	console.log("  dense log / structured extract → D");
	console.log("  contradictory evidence         → D (quality, not compression)");
	console.log("  everything else                → C");
	console.log("  grant size is telemetry only — crossover ~549B observed where complexity kicks in");

	const boundaryPairs = pairs.filter(p => p.tier === "boundary");
	if (boundaryPairs.length) {
		const dBetter = boundaryPairs.filter(p => verified(p.d) && !verified(p.c)).length;
		const cBetter = boundaryPairs.filter(p => verified(p.c) && !verified(p.d)).length;
		console.log(
			`\n--- Boundary band (~400–700B) seed consistency ---`,
		);
		console.log(`  pair-seeds=${boundaryPairs.length}  D-only-verified=${dBetter}  C-only-verified=${cBetter}`);
	}

	console.log("\n--- Tokenomics (session, known only) ---");
	console.log(JSON.stringify(tok?.summary ?? {}, null, 2));
	console.log("\nNext: if tier rollup holds, enable rlm.workerMode=auto (log-only) — still no Kerdoios.");
}

main();
