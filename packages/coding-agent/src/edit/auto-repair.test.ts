import { describe, expect, test } from "bun:test";
import { summarizeCode } from "@oh-my-pi/pi-natives";
import { computeRepairRegion, repairParseRegression } from "./auto-repair";

const PATH = "/repo/src/sample.ts";

function sourceParses(code: string): boolean {
	return summarizeCode({ code: code.length === 0 ? "\n" : code, path: PATH }).parsed;
}

/** A parseable base file with distinct sections so multi-hunk edits stay apart. */
const BASE = [
	"export function alpha(a: number): number {",
	"\treturn a + 1;",
	"}",
	"",
	...Array.from({ length: 10 }, (_, i) => `export const pad${i} = ${i};`),
	"",
	"export function beta(b: number): number {",
	"\tconst doubled = b * 2;",
	"\treturn doubled;",
	"}",
	"",
	...Array.from({ length: 10 }, (_, i) => `export const tail${i} = ${i};`),
	"",
	"export function gamma(c: number): number {",
	"\treturn c - 1;",
	"}",
].join("\n");

describe("computeRepairRegion", () => {
	test("isolates the breaking hunk of a multi-hunk edit and its reference restores the parse", () => {
		// Two edits far apart: a valid rename in alpha, a broken brace in beta.
		const next = BASE.replace("return a + 1;", "return a + 2;").replace(
			"const doubled = b * 2;",
			"const doubled = (b * 2;",
		);
		expect(sourceParses(next)).toBe(false);

		const region = computeRepairRegion({ path: PATH, prev: BASE, next });
		expect(region).toBeDefined();
		if (!region) throw new Error("unreachable");
		// The valid alpha edit is not part of the repair region.
		expect(region.brokenText).not.toContain("return a + 2;");
		expect(region.brokenText).toContain("(b * 2;");
		expect(region.language).toBe("typescript");

		// Invariant: splicing the reference back reproduces a parseable file, so
		// the region provably contains the whole breakage.
		const lines = next.split("\n");
		const spliced = [
			...lines.slice(0, region.bStart),
			...region.referenceText.split("\n"),
			...lines.slice(region.bEnd),
		].join("\n");
		expect(sourceParses(spliced)).toBe(true);
	});

	test("returns undefined when the broken span exceeds the region cap", () => {
		const bigBody = Array.from({ length: 200 }, (_, i) => `\tconst v${i} = ${i};`).join("\n");
		const prev = `export function big(): void {\n${bigBody}\n}\n`;
		// Break the opening line and mutate every body line so the culprit hunk
		// spans the whole (oversized) function.
		const next = `export function big(: void {\n${bigBody.replaceAll("const", "let")}\n}\n`;
		expect(sourceParses(prev)).toBe(true);
		expect(sourceParses(next)).toBe(false);
		expect(computeRepairRegion({ path: PATH, prev, next })).toBeUndefined();
	});
});

describe("repairParseRegression", () => {
	const broken = BASE.replace("const doubled = b * 2;", "const doubled = (b * 2;");

	test("accepts a candidate that fixes the syntax while keeping the intended change", async () => {
		const repair = await repairParseRegression({ path: PATH, prev: BASE, next: broken }, async built => {
			expect(built).toContain("(b * 2;");
			expect(built).toContain("const doubled = b * 2;");
			// The model closes the paren instead of reverting.
			return built.split("AFTER (broken):")[1].split("```")[1].replace("(b * 2;", "(b * 2);").trim();
		});
		expect(repair).toBeDefined();
		if (!repair) throw new Error("unreachable");
		expect(repair.attempts).toBe(1);
		expect(sourceParses(repair.content)).toBe(true);
		expect(repair.content).toContain("const doubled = (b * 2);");
		// Untouched sections survive byte-for-byte.
		expect(repair.content).toContain("export function alpha(a: number): number {");
	});

	test("rejects a revert candidate even though it would parse", async () => {
		let calls = 0;
		const repair = await repairParseRegression({ path: PATH, prev: BASE, next: broken }, async built => {
			calls++;
			// Echo the BEFORE region verbatim: a parseable revert of the change.
			return built.split("BEFORE (valid typescript):")[1].split("```")[1].trim();
		});
		expect(repair).toBeUndefined();
		// The revert burned the first attempt and the feedback retry.
		expect(calls).toBe(2);
	});

	test("rescues a candidate whose echoed context lost its indentation", async () => {
		const repair = await repairParseRegression({ path: PATH, prev: BASE, next: broken }, async built => {
			const region = built.split("AFTER (broken):")[1].split("```")[1].trim();
			// Fix the paren but strip all leading whitespace, as small models do.
			return region
				.replace("(b * 2;", "(b * 2);")
				.split("\n")
				.map(line => line.trimStart())
				.join("\n");
		});
		expect(repair).toBeDefined();
		if (!repair) throw new Error("unreachable");
		expect(sourceParses(repair.content)).toBe(true);
		// Realignment restored original bytes for the echoed context lines; only
		// the genuinely changed line keeps the model's (dedented) shape.
		expect(repair.content).toContain("\treturn doubled;");
		expect(repair.content).toContain("\treturn a + 1;");
		expect(repair.content).toContain("(b * 2);");
	});

	test("feeds the failed attempt back and succeeds on the retry", async () => {
		let calls = 0;
		const repair = await repairParseRegression({ path: PATH, prev: BASE, next: broken }, async built => {
			calls++;
			if (calls === 1) return "const doubled = (b * 2;"; // still broken
			expect(built).toContain("PREVIOUS ATTEMPT (rejected):");
			expect(built).toContain("const doubled = (b * 2;");
			return built.split("AFTER (broken):")[1].split("```")[1].replace("(b * 2;", "(b * 2);").trim();
		});
		expect(repair).toBeDefined();
		if (!repair) throw new Error("unreachable");
		expect(repair.attempts).toBe(2);
		expect(sourceParses(repair.content)).toBe(true);
	});

	test("gives up after the retry when no candidate re-parses", async () => {
		const repair = await repairParseRegression(
			{ path: PATH, prev: BASE, next: broken },
			async () => "const doubled = (b * 2; // still broken",
		);
		expect(repair).toBeUndefined();
	});
});
