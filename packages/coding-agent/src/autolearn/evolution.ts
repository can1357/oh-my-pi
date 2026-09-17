import * as fs from "node:fs/promises";
import * as path from "node:path";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import proposePrompt from "../prompts/system/skill-evolution-propose.md" with { type: "text" };
import solvePrompt from "../prompts/system/skill-evolution-solve.md" with { type: "text" };
import {
	type EvolutionCandidate,
	type EvolutionCase,
	type EvolutionInput,
	type EvolutionReport,
	type EvolutionResult,
	evolutionCandidateSchema,
	evolutionInputSchema,
	evolutionReportSchema,
} from "./evolution-types";
import { readManagedSkill, sanitizeSkillName, validateManagedSkillPayload, writeManagedSkill } from "./managed-skills";

export type EvolutionCompletion = (system: string, user: string, signal: AbortSignal) => Promise<string>;
export interface EvolutionOptions {
	agentDir: string;
	model: string;
	complete: EvolutionCompletion;
	maxCalls: number;
	signal: AbortSignal;
}
const MAX_REPORT_BYTES = 2_000_000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** User-supplied benchmark inputs are disjoint and bounded before a provider is called. */
export function validateEvolutionInput(raw: EvolutionInput): EvolutionInput {
	const input = evolutionInputSchema(raw);
	if (input instanceof type.errors) throw new Error(input.summary);
	if (!input.lessons.trim() || input.lessons.length > 16_000)
		throw new Error("Lessons must contain 1–16,000 characters.");
	const ids = new Set<string>();
	const prompts = new Set<string>();
	for (const cases of [input.training, input.holdout]) {
		if (cases.length < 1 || cases.length > 8) throw new Error("Each benchmark split requires 1–8 cases.");
		for (const item of cases) {
			if (!item.id.trim() || item.id.length > 80 || !item.prompt.trim() || !item.expected.trim()) {
				throw new Error("Benchmark IDs, prompts and expected answers must be non-empty.");
			}
			if (item.prompt.length > 8_000 || item.expected.length > 4_000)
				throw new Error("Benchmark case is oversized.");
			if (ids.has(item.id) || prompts.has(item.prompt.trim()))
				throw new Error("Training and holdout cases must be distinct.");
			ids.add(item.id);
			prompts.add(item.prompt.trim());
		}
	}
	return input;
}

export function scoreEvolution(cases: EvolutionCase[], results: EvolutionResult[]): number {
	if (cases.length !== results.length || cases.some((item, index) => item.id !== results[index]?.id)) {
		throw new Error("Incomplete or mismatched benchmark results.");
	}
	return cases.filter((item, index) => item.expected.trim() === results[index].actual.trim()).length;
}
function noRegressions(cases: EvolutionCase[], before: EvolutionResult[], after: EvolutionResult[]): boolean {
	scoreEvolution(cases, before);
	scoreEvolution(cases, after);
	return cases.every(
		(item, index) =>
			before[index].actual.trim() !== item.expected.trim() || after[index].actual.trim() === item.expected.trim(),
	);
}
export function isEvolutionEligible(report: EvolutionReport): boolean {
	if (!report.candidate) return false;
	return (
		scoreEvolution(report.input.training, report.training) >
			scoreEvolution(report.input.training, report.baselineTraining) &&
		noRegressions(report.input.training, report.baselineTraining, report.training) &&
		noRegressions(report.input.holdout, report.baselineHoldout, report.holdout)
	);
}

async function runDirectory(agentDir: string): Promise<string> {
	// Only create descendants of an existing agent root; reject symlinked audit directories.
	const root = await fs.realpath(agentDir);
	let current = root;
	for (const part of ["autolearn", "evolution"]) {
		current = path.join(current, part);
		await fs.mkdir(current).catch(err => {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		});
		const stat = await fs.lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe skill-evolution audit directory.");
	}
	return current;
}
export async function saveEvolutionReport(agentDir: string, report: EvolutionReport): Promise<string> {
	if (!RUN_ID.test(report.id)) throw new Error("Invalid evolution run ID.");
	const file = path.join(await runDirectory(agentDir), `${report.id}.json`);
	const text = JSON.stringify(report, null, 2);
	if (Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new Error("Evolution audit report exceeds its size budget.");
	await fs.writeFile(file, text, { flag: "wx", mode: 0o600 });
	return file;
}
export async function loadEvolutionReport(agentDir: string, id: string): Promise<EvolutionReport> {
	if (!RUN_ID.test(id)) throw new Error("Invalid evolution run ID.");
	const file = path.join(await runDirectory(agentDir), `${id}.json`);
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_REPORT_BYTES)
		throw new Error("Unsafe evolution audit file.");
	const report = evolutionReportSchema(JSON.parse(await Bun.file(file).text()));
	if (report instanceof type.errors) throw new Error(`Invalid evolution report: ${report.summary}`);
	if (report.id !== id) throw new Error("Evolution report identity mismatch.");
	validateEvolutionInput(report.input);
	return report;
}

/** Training-only search followed by one independent holdout gate. Never installs a candidate. */
export async function evolveSkill(
	name: string,
	raw: EvolutionInput,
	options: EvolutionOptions,
): Promise<{ report: EvolutionReport; path: string }> {
	const safe = sanitizeSkillName(name);
	const input = validateEvolutionInput(raw);
	if (isNameClaimedByAuthoredSkill(safe))
		throw new Error("An authored skill cannot be evolved through managed skills.");
	const rounds = input.rounds ?? 1;
	const candidates = input.candidates ?? 2;
	const requiredCalls =
		input.training.length * (1 + rounds * candidates) + rounds * candidates + 2 * input.holdout.length;
	if (!Number.isInteger(options.maxCalls) || options.maxCalls < requiredCalls || options.maxCalls > 64) {
		throw new Error(
			`Evolution requires at most ${requiredCalls} model calls; configured cap is ${options.maxCalls} (maximum 64).`,
		);
	}
	await runDirectory(options.agentDir);
	const baseline = await readManagedSkill(safe, options.agentDir);
	const report: EvolutionReport = {
		version: 1,
		id: Bun.randomUUIDv7(),
		name: safe,
		createdAt: new Date().toISOString(),
		model: options.model,
		state: "failed",
		input,
		baseline,
		candidate: null,
		baselineTraining: [],
		baselineHoldout: [],
		training: [],
		holdout: [],
		attempts: [],
		calls: 0,
	};
	const call: EvolutionCompletion = async (system, user, signal) => {
		signal.throwIfAborted();
		if (++report.calls > options.maxCalls) throw new Error("Evolution model-call budget exhausted.");
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason ?? new Error("Evolution cancelled."));
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await Promise.race([options.complete(system, user, signal), aborted.promise]);
			signal.throwIfAborted();
			if (Buffer.byteLength(result) > 64_000) throw new Error("Evolution completion exceeds its output budget.");
			return result;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	};
	const evaluate = async (
		candidate: EvolutionCandidate | null,
		cases: EvolutionCase[],
	): Promise<EvolutionResult[]> => {
		const results: EvolutionResult[] = [];
		for (const item of cases) {
			// Expected answers never enter the solver context. Each call has fresh history and no tools.
			results.push({
				id: item.id,
				actual: await call(
					prompt.render(solvePrompt, { skill: candidate?.body ?? "" }),
					item.prompt,
					options.signal,
				),
			});
		}
		return results;
	};
	try {
		report.baselineTraining = await evaluate(baseline, input.training);
		let best: EvolutionCandidate | null = baseline;
		let bestResults = report.baselineTraining;
		for (let round = 0; round < rounds; round++) {
			for (let variation = 0; variation < candidates; variation++) {
				const text = await call(
					proposePrompt,
					JSON.stringify({
						lessons: input.lessons,
						skill: best,
						training: input.training,
						results: bestResults,
						round,
						variation,
					}),
					options.signal,
				);
				const proposal = evolutionCandidateSchema(JSON.parse(text));
				if (proposal instanceof type.errors) throw new Error(`Invalid candidate: ${proposal.summary}`);
				const validation = validateManagedSkillPayload({ name: safe, ...proposal });
				if (!validation.ok || !validation.normalized)
					throw new Error(validation.issues.map(issue => issue.message).join(" "));
				const candidate = { description: validation.normalized.description, body: validation.normalized.body };
				const results = await evaluate(candidate, input.training);
				report.attempts.push({ round, candidate, training: results });
				if (
					scoreEvolution(input.training, results) > scoreEvolution(input.training, bestResults) &&
					noRegressions(input.training, bestResults, results)
				) {
					best = candidate;
					bestResults = results;
				}
			}
		}
		report.candidate = best;
		report.training = bestResults;
		// Holdout results never feed candidate generation, even when they reject the final candidate.
		report.baselineHoldout = await evaluate(baseline, input.holdout);
		report.holdout = await evaluate(best, input.holdout);
		report.state = isEvolutionEligible(report) ? "eligible" : "rejected";
	} catch (error) {
		report.state = "failed";
		report.error = error instanceof Error ? error.message : String(error);
	}
	return { report, path: await saveEvolutionReport(options.agentDir, report) };
}

/** Explicit promotion, with an immutable audit receipt and a baseline compare-and-swap. */
export async function promoteEvolution(
	agentDir: string,
	id: string,
	expectedName: string,
): Promise<{ path: string; report: EvolutionReport }> {
	const report = await loadEvolutionReport(agentDir, id);
	if (sanitizeSkillName(expectedName) !== report.name) throw new Error("Evolution run belongs to a different skill.");
	if (report.state !== "eligible" || !isEvolutionEligible(report) || !report.candidate)
		throw new Error("Evolution run is not eligible for promotion.");
	if (isNameClaimedByAuthoredSkill(report.name))
		throw new Error("An authored skill now claims this name; promotion refused.");
	const dir = await runDirectory(agentDir);
	const receipt = path.join(dir, `${id}.promotion.json`);
	// Atomic claim prevents two sessions from promoting the same evaluation concurrently.
	const handle = await fs.open(receipt, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify({ state: "promoting", id }));
		await handle.sync();
		const result = await writeManagedSkill({
			name: report.name,
			...report.candidate,
			action: report.baseline ? "update" : "create",
			agentDir,
			expectedContent: report.baseline?.content ?? null,
		});
		report.state = "promoted";
		await handle.truncate(0);
		await handle.write(
			JSON.stringify({ state: "promoted", id, path: result.path, promotedAt: new Date().toISOString() }),
			0,
			"utf8",
		);
		await handle.sync();
		return { path: receipt, report };
	} catch (error) {
		// Keep the claim on failure: a crash after replacement must never silently replay promotion.
		throw new Error(
			`Promotion stopped; inspect ${receipt} and the current skill before retrying: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		await handle.close();
	}
}
