#!/usr/bin/env bun

import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const concurrency = 7;

interface CheckJob {
	name: string;
	command: string[];
	cwd: string;
}

interface CheckResult extends CheckJob {
	exitCode: number;
	output: string;
	seconds: number;
}

type CheckSpawn = (
	command: string[],
	options: { cwd: string; stdout: "pipe"; stderr: "pipe" },
) => Bun.Subprocess<"ignore", "pipe", "pipe">;

function shellQuote(word: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export async function collectCheckJobs(root = repoRoot): Promise<CheckJob[]> {
	const jobs: CheckJob[] = [
		{
			name: "tool lint (oxlint)",
			command: ["bun", "run", "check:tools:lint"],
			cwd: root,
		},
		{
			name: "tool format (oxfmt)",
			command: ["bun", "run", "check:tools:format"],
			cwd: root,
		},
	];
	const packageFiles = await Array.fromAsync(new Bun.Glob("packages/*/package.json").scan({ cwd: root }));
	packageFiles.sort();

	for (const packageFile of packageFiles) {
		const packageRoot = path.dirname(path.join(root, packageFile));
		const packageJson = (await Bun.file(path.join(root, packageFile)).json()) as {
			name?: string;
			scripts?: Record<string, string>;
		};
		if (packageJson.scripts?.["check:types"] == null) continue;
		jobs.push({
			name: `${packageJson.name ?? packageFile} check:types`,
			command: ["bun", "run", "check:types"],
			cwd: packageRoot,
		});
	}

	return jobs;
}

export async function runCheckJobs(
	jobs: CheckJob[],
	options: {
		concurrency?: number;
		emit?: (line: string) => void;
		spawn?: CheckSpawn;
	} = {},
): Promise<number> {
	const width = options.concurrency ?? concurrency;
	if (!Number.isInteger(width) || width < 1) throw new Error(`Invalid check concurrency: ${width}`);
	const emit = options.emit ?? (line => process.stdout.write(`${line}\n`));
	const spawn = options.spawn ?? Bun.spawn;
	const results: CheckResult[] = Array.from({ length: jobs.length });
	let nextJob = 0;

	async function worker(): Promise<void> {
		while (true) {
			const index = nextJob++;
			if (index >= jobs.length) return;
			const job = jobs[index]!;
			const startedAt = performance.now();
			try {
				const child = spawn(job.command, { cwd: job.cwd, stdout: "pipe", stderr: "pipe" });
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				results[index] = {
					...job,
					exitCode,
					output: [stdout, stderr].filter(Boolean).join("\n").trimEnd(),
					seconds: (performance.now() - startedAt) / 1000,
				};
			} catch (error) {
				// Process creation itself failed: record it like any other
				// failure so the remaining workers finish and the summary
				// still prints instead of Promise.all rejecting outright.
				results[index] = {
					...job,
					exitCode: -1,
					output: `failed to start: ${error instanceof Error ? error.message : String(error)}`,
					seconds: (performance.now() - startedAt) / 1000,
				};
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, () => worker()));

	const failures = results.filter(result => result.exitCode !== 0);
	for (const result of results) {
		if (result.exitCode === 0) {
			emit(`✓ ${result.name} (${result.seconds.toFixed(1)}s)`);
			// Passing checks can still print warnings; keep them in the log.
			if (result.output) emit(result.output);
		}
	}
	for (const failure of failures) {
		emit(`\n✗ ${failure.name} (exit ${failure.exitCode})`);
		emit(`$ (cd ${shellQuote(failure.cwd)} && ${failure.command.map(shellQuote).join(" ")})`);
		if (failure.output) emit(failure.output);
	}
	emit(
		`\n${results.length - failures.length}/${results.length} checks passed; ${failures.length} failed; concurrency limit ${width}.`,
	);
	return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await runCheckJobs(await collectCheckJobs());
}
