/**
 * Workload command surface: discovery listing, dry-run planning, and execution.
 *
 * See `docs/workloads.md` for the file format. The CLI wrapper
 * (`src/commands/workload.ts`) only parses flags; everything user-visible is
 * decided here so the same behavior is reachable programmatically.
 */
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { discoverWorkloads, loadWorkload, resolveWorkloadArgs, type WorkloadSpec, WorkloadSpecError } from "./spec";
import { runWorkload, type WorkloadRunEvent, type WorkloadRunResult } from "./runner";

export * from "./runner";
export * from "./spec";

export interface RunWorkloadCommandOptions {
	/** Workload name or path; omitted lists what is discoverable. */
	target?: string;
	/** Raw `name=value` strings from `--set`. */
	set?: string[];
	json?: boolean;
	dryRun?: boolean;
	cwd?: string;
	concurrency?: number;
}

/** Render the wave plan without spawning anything, so a spec can be reviewed. */
function renderPlan(spec: WorkloadSpec, args: Record<string, string>): string {
	const lines = [
		`${chalk.bold(spec.name)} ${chalk.dim(spec.sourcePath)}`,
		...(spec.description ? [chalk.dim(spec.description)] : []),
	];
	const declaredArgs = Object.keys(spec.args);
	if (declaredArgs.length > 0) {
		lines.push(
			chalk.dim(`args: ${declaredArgs.map(name => `${name}=${args[name] ?? chalk.red("<unset>")}`).join(" ")}`),
		);
	}
	const stepsById: Record<string, (typeof spec.steps)[number]> = {};
	for (const step of spec.steps) stepsById[step.id] = step;
	for (const [index, wave] of spec.waves.entries()) {
		lines.push(chalk.bold(`wave ${index + 1}/${spec.waves.length}`));
		for (const id of wave) {
			const step = stepsById[id];
			if (!step) continue;
			const facets = [
				step.run ? `run ${step.run.join(" ")}` : `agent ${step.agent}`,
				step.model ? `model ${step.model}` : undefined,
				step.effort ? `effort ${step.effort}` : undefined,
				step.forEach ? `for_each ${step.forEach} (concurrency ${step.concurrency})` : undefined,
				step.isolated ? "isolated" : undefined,
				step.retries > 0 ? `retries ${step.retries}` : undefined,
				step.onFailure === "continue" ? "on_failure continue" : undefined,
				step.needs.length > 0 ? `needs ${step.needs.join(",")}` : undefined,
			].filter(Boolean);
			lines.push(`  ${chalk.cyan(id)} ${chalk.dim(facets.join(" · "))}`);
		}
	}
	return lines.join("\n");
}

/** One-line-per-step summary of a finished run. */
function renderResult(result: WorkloadRunResult): string {
	const glyph: Record<string, string> = { ok: chalk.green("✓"), failed: chalk.red("✗"), skipped: chalk.dim("–") };
	const lines = result.steps.map(report => {
		const facets = [
			report.items !== undefined ? `${report.items} items` : undefined,
			report.attempts > 1 ? `${report.attempts} attempts` : undefined,
			report.resolvedModel,
			report.tokens ? `${report.tokens} tok` : undefined,
			`${(report.durationMs / 1000).toFixed(1)}s`,
		].filter(Boolean);
		const detail = report.error ?? report.skipReason;
		return `${glyph[report.status] ?? "?"} ${report.id} ${chalk.dim(facets.join(" · "))}${
			detail ? `\n    ${chalk.red(detail)}` : ""
		}`;
	});
	lines.push(
		`${result.status === "ok" ? chalk.green("workload ok") : chalk.red("workload failed")} ${chalk.dim(
			`${result.name} · ${(result.durationMs / 1000).toFixed(1)}s`,
		)}`,
	);
	if (result.ledgerPath) lines.push(chalk.dim(`ledger: ${result.ledgerPath}`));
	return lines.join("\n");
}

/**
 * Entry point behind `omp workload`. Returns the process exit code rather than
 * exiting, so callers (and tests) can drive it directly.
 */
export async function runWorkloadCommand(options: RunWorkloadCommandOptions = {}): Promise<{ exitCode: number }> {
	const cwd = options.cwd ?? getProjectDir();
	try {
		if (!options.target) {
			const candidates = await discoverWorkloads(cwd);
			if (options.json) {
				process.stdout.write(`${JSON.stringify({ workloads: candidates }, null, "\t")}\n`);
				return { exitCode: 0 };
			}
			if (candidates.length === 0) {
				process.stdout.write(
					`No workloads found. Create ${chalk.cyan(".omp/workloads/<name>.yml")} — see docs/workloads.md.\n`,
				);
				return { exitCode: 0 };
			}
			for (const candidate of candidates) {
				process.stdout.write(
					`${chalk.cyan(candidate.name)} ${chalk.dim(`${candidate.level} · ${path.relative(cwd, candidate.path) || candidate.path}`)}\n`,
				);
			}
			return { exitCode: 0 };
		}

		const spec = await loadWorkload(options.target, cwd);
		const args = resolveWorkloadArgs(spec, options.set ?? []);
		if (options.dryRun) {
			process.stdout.write(
				options.json
					? `${JSON.stringify({ ...spec, args }, null, "\t")}\n`
					: `${renderPlan(spec, args)}\n${chalk.dim("dry run — nothing was spawned")}\n`,
			);
			return { exitCode: 0 };
		}

		const onEvent = options.json
			? undefined
			: (event: WorkloadRunEvent) => {
					if (event.kind === "wave") {
						process.stderr.write(
							`${chalk.bold(`wave ${event.index}/${event.total}`)} ${chalk.dim(event.steps.join(", "))}\n`,
						);
					} else if (event.kind === "step-start") {
						const facets = [
							event.description,
							event.model,
							event.items ? `${event.items} items` : undefined,
						].filter(Boolean);
						process.stderr.write(`${chalk.dim("→")} ${event.id} ${chalk.dim(facets.join(" · "))}\n`);
					}
				};
		const result = await runWorkload(spec, args, {
			cwd,
			...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
			...(onEvent ? { onEvent } : {}),
		});
		process.stdout.write(options.json ? `${JSON.stringify(result, null, "\t")}\n` : `${renderResult(result)}\n`);
		return { exitCode: result.status === "ok" ? 0 : 1 };
	} catch (err) {
		const message = err instanceof WorkloadSpecError || err instanceof Error ? err.message : String(err);
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ error: message }, null, "\t")}\n`);
		} else {
			process.stderr.write(`${chalk.red("workload:")} ${message}\n`);
		}
		return { exitCode: 1 };
	}
}
