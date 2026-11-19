/**
 * Schema benchmark phases:
 * correctness, compile unique schemas, cold compile plus two calls, and hot calls.
 */
import type { Candidate } from "./candidate";
import { arktypeCandidate } from "./candidates/arktype";
import { omptypeCandidate } from "./candidates/omptype";
import { typeboxCandidate } from "./candidates/typebox";
import { FIXTURES, generateUniqueDefs } from "./fixtures";
import type { Def } from "./ir";

const registry: Candidate[] = [omptypeCandidate, arktypeCandidate, typeboxCandidate];
const filter = process.argv.slice(2);
const candidates = filter.length ? registry.filter(candidate => filter.includes(candidate.name)) : registry;

let correctnessFailed = false;
for (const candidate of candidates) {
	let candidateFailed = false;
	for (const fixture of FIXTURES) {
		let schema: (value: unknown) => unknown;
		let allows: ((value: unknown) => boolean) | undefined;
		try {
			schema = candidate.type(fixture.def);
			allows = candidate.allows?.(fixture.def);
		} catch (error) {
			console.error(`✗ ${candidate.name}/${fixture.name}: type() threw: ${error}`);
			candidateFailed = true;
			continue;
		}
		for (const value of fixture.valid) {
			const result = schema(structuredClone(value));
			if (candidate.isErrors(result)) {
				console.error(
					`✗ ${candidate.name}/${fixture.name}: valid input rejected: ${JSON.stringify(value)} → ${candidate.summary?.(result)}`,
				);
				candidateFailed = true;
			}
			if (allows?.(structuredClone(value)) === false) {
				console.error(
					`✗ ${candidate.name}/${fixture.name}: allows() rejected valid input: ${JSON.stringify(value)}`,
				);
				candidateFailed = true;
			}
		}
		for (const value of fixture.invalid) {
			const result = schema(structuredClone(value));
			if (!candidate.isErrors(result)) {
				console.error(`✗ ${candidate.name}/${fixture.name}: invalid input accepted: ${JSON.stringify(value)}`);
				candidateFailed = true;
			}
			if (allows?.(structuredClone(value))) {
				console.error(
					`✗ ${candidate.name}/${fixture.name}: allows() accepted invalid input: ${JSON.stringify(value)}`,
				);
				candidateFailed = true;
			}
		}
		for (const expectation of fixture.expect ?? []) {
			const input = structuredClone(expectation.input);
			const result = schema(input);
			if (candidate.isErrors(result)) {
				console.error(
					`✗ ${candidate.name}/${fixture.name}: expect input rejected: ${JSON.stringify(expectation.input)} → ${candidate.summary?.(result)}`,
				);
				candidateFailed = true;
				continue;
			}
			if (!Bun.deepEquals(result, expectation.output, true)) {
				console.error(
					`✗ ${candidate.name}/${fixture.name}: morph output mismatch: got ${JSON.stringify(result)}, want ${JSON.stringify(expectation.output)}`,
				);
				candidateFailed = true;
			}
			if (!Bun.deepEquals(input, expectation.input, true)) {
				console.error(`✗ ${candidate.name}/${fixture.name}: schema mutated its input: ${JSON.stringify(input)}`);
				candidateFailed = true;
			}
		}
	}
	correctnessFailed ||= candidateFailed;
	console.log(`correctness ${candidate.name}: ${candidateFailed ? "FAILED" : "ok"}`);
}
if (correctnessFailed) process.exit(1);

function formatNanoseconds(nanoseconds: number): string {
	if (nanoseconds < 1e3) return `${nanoseconds.toFixed(0)}ns`;
	if (nanoseconds < 1e6) return `${(nanoseconds / 1e3).toFixed(2)}µs`;
	if (nanoseconds < 1e9) return `${(nanoseconds / 1e6).toFixed(2)}ms`;
	return `${(nanoseconds / 1e9).toFixed(2)}s`;
}

interface Row {
	candidate: string;
	perOperation: number;
}

function report(title: string, rows: Row[]): void {
	const baseline = rows.find(row => row.candidate === "omptype");
	console.log(`\n== ${title} ==`);
	for (const row of rows) {
		let relative = "";
		if (baseline && row.candidate !== "omptype") {
			const factor = row.perOperation / baseline.perOperation;
			relative =
				factor >= 1 ? `  \x1b[31m▲ ${factor.toFixed(1)}x\x1b[0m` : `  \x1b[32m▼ ${(1 / factor).toFixed(1)}x\x1b[0m`;
		}
		console.log(`  ${row.candidate.padEnd(12)} ${formatNanoseconds(row.perOperation).padStart(10)}/op${relative}`);
	}
}

function rewriteUnique(
	entry: { def: Def; valid: unknown; invalid: unknown },
	tag: string,
): { def: Def; valid: unknown; invalid: unknown } {
	const json = JSON.stringify(entry);
	return JSON.parse(json.replaceAll("alpha_", `alpha${tag}_`).replaceAll("mode_", `mode${tag}_`));
}

{
	const count = 400;
	const rows: Row[] = [];
	for (const candidate of candidates) {
		Bun.gc(true);
		const repetitions: number[] = [];
		for (let repetition = 0; repetition < 5; repetition++) {
			const definitions = generateUniqueDefs(count).map((entry, index) =>
				rewriteUnique(entry, `r${repetition}_${index}`),
			);
			const start = Bun.nanoseconds();
			for (const definition of definitions) candidate.type(definition.def);
			repetitions.push((Bun.nanoseconds() - start) / count);
		}
		rows.push({ candidate: candidate.name, perOperation: Math.min(...repetitions) });
	}
	report(`compile: type() for ${count} unique object schemas`, rows);
}

{
	const count = 400;
	const rows: Row[] = [];
	for (const candidate of candidates) {
		Bun.gc(true);
		const repetitions: number[] = [];
		for (let repetition = 0; repetition < 5; repetition++) {
			const definitions = generateUniqueDefs(count).map((entry, index) =>
				rewriteUnique(entry, `c${repetition}_${index}`),
			);
			const start = Bun.nanoseconds();
			for (const definition of definitions) {
				const schema = candidate.type(definition.def);
				schema(definition.valid);
				schema(definition.invalid);
			}
			repetitions.push((Bun.nanoseconds() - start) / count);
		}
		rows.push({ candidate: candidate.name, perOperation: Math.min(...repetitions) });
	}
	report("cold: type() + 2 validations", rows);
}

{
	const iterations = 200_000;
	for (const fixture of FIXTURES) {
		const rows: Row[] = [];
		const inputs = [...fixture.valid, ...fixture.invalid];
		for (const candidate of candidates) {
			const schema = candidate.type(fixture.def);
			for (let index = 0; index < 2_000; index++) schema(inputs[index % inputs.length]);
			Bun.gc(true);
			let sink = 0;
			const start = Bun.nanoseconds();
			for (let index = 0; index < iterations; index++) {
				const result = schema(inputs[index % inputs.length]);
				if (candidate.isErrors(result)) sink++;
			}
			const duration = Bun.nanoseconds() - start;
			if (sink === 0) throw new Error("benchmark sink was not observed");
			rows.push({ candidate: candidate.name, perOperation: duration / iterations });
		}
		report(`hot: ${fixture.name} × ${iterations}`, rows);
	}
}

{
	const iterations = 2_000_000;
	const rows: Row[] = [];
	const fixture = FIXTURES[2];
	for (const candidate of candidates) {
		let validate = candidate.allows?.(fixture.def);
		if (validate === undefined) {
			const schema = candidate.type(fixture.def);
			validate = (value: unknown) => !candidate.isErrors(schema(value));
		}
		for (let index = 0; index < 20_000; index++) validate(fixture.valid[index % fixture.valid.length]);
		Bun.gc(true);
		let sink = 0;
		const start = Bun.nanoseconds();
		for (let index = 0; index < iterations; index++) {
			if (validate(fixture.valid[index % fixture.valid.length])) sink++;
		}
		const duration = Bun.nanoseconds() - start;
		if (sink === 0) throw new Error("benchmark sink was not observed");
		rows.push({ candidate: candidate.name, perOperation: duration / iterations });
	}
	report(`hot allows/check valid-only: ${fixture.name} × ${iterations}`, rows);
}
