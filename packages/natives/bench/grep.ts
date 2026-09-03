import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GrepOutputMode, grep } from "../native/index.js";

const ITERATIONS = Number(Bun.env.GREP_BENCH_ITERATIONS ?? "50");
const CONCURRENCY = 2;

const packages = path.resolve(import.meta.dir, "../..");

interface BenchCase {
	name: string;
	path: string;
	pattern: string;
	glob?: string;
	mode?: GrepOutputMode;
	iterations?: number;
	concurrency?: number;
}

const cases: BenchCase[] = [
	{ name: "Medium content (50 files)", path: path.resolve(packages, "tui/src"), pattern: "export", glob: "*.ts" },
	{
		name: "Medium filesWithMatches (50 files)",
		path: path.resolve(packages, "tui/src"),
		pattern: "export",
		glob: "*.ts",
		mode: GrepOutputMode.FilesWithMatches,
	},
	{
		name: "Large content (200+ files)",
		path: path.resolve(packages, "coding-agent/src"),
		pattern: "import",
		glob: "*.ts",
	},
	{
		name: "Large filesWithMatches (200+ files)",
		path: path.resolve(packages, "coding-agent/src"),
		pattern: "import",
		glob: "*.ts",
		mode: GrepOutputMode.FilesWithMatches,
	},
	{
		name: "Large count (200+ files)",
		path: path.resolve(packages, "coding-agent/src"),
		pattern: "import",
		glob: "*.ts",
		mode: GrepOutputMode.Count,
	},
];

const cargoRegistry = path.join(Bun.env.HOME ?? "", ".cargo/registry/src");
try {
	if ((await fs.stat(cargoRegistry)).isDirectory()) {
		cases.push({
			name: "Cargo registry content",
			path: cargoRegistry,
			pattern: "pub mod modal|pub mod dialog|pub mod drawer",
			iterations: 1,
			concurrency: 1,
		});
	}
} catch {
	// Skip the registry case in environments without a local Cargo registry.
}

// Warm per-root state before timing so the benchmark measures steady-state search.
for (const c of cases) {
	await grep({ pattern: c.pattern, path: c.path, glob: c.glob, mode: c.mode, gitignore: false });
}

console.log(`Benchmark: ${ITERATIONS} default iterations per case\n`);

for (const c of cases) {
	const grepArgs = { pattern: c.pattern, path: c.path, glob: c.glob, mode: c.mode, gitignore: false };
	const caseIterations = c.iterations ?? ITERATIONS;
	const concurrency = c.concurrency ?? CONCURRENCY;
	const rgDefaultArgs = ["--hidden", "--no-ignore", "--no-ignore-vcs"];
	const modeArg =
		c.mode === GrepOutputMode.FilesWithMatches
			? ["--files-with-matches"]
			: c.mode === GrepOutputMode.Count
				? ["--count"]
				: ["--json"];
	const globArg = c.glob ? ["-g", c.glob] : [];
	const runNative = () => grep(grepArgs);

	const runRg = async (): Promise<string> => {
		const proc = Bun.spawn(["rg", ...modeArg, ...rgDefaultArgs, ...globArg, c.pattern, c.path], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return stdout;
	};

	const countMatches = (result: string): number => {
		const lines = result.split("\n").filter(line => line.trim());
		if (c.mode === GrepOutputMode.FilesWithMatches) {
			return lines.length;
		}
		if (c.mode === GrepOutputMode.Count) {
			return lines.reduce((sum, line) => {
				const rawCount = line.includes(":") ? line.slice(line.lastIndexOf(":") + 1) : line;
				const count = Number(rawCount);
				return Number.isFinite(count) ? sum + count : sum;
			}, 0);
		}

		let matches = 0;
		for (const line of lines) {
			try {
				if (JSON.parse(line).type === "match") matches++;
			} catch {
				/* ignore */
			}
		}
		return matches;
	};

	const nativeMetric = await runNative();
	const nativeMatches =
		c.mode === GrepOutputMode.FilesWithMatches ? nativeMetric.filesWithMatches : nativeMetric.totalMatches;

	const rgMatches = countMatches(await runRg());

	let start = Bun.nanoseconds();
	for (let i = 0; i < caseIterations; i++) await runNative();
	const nativeMs = (Bun.nanoseconds() - start) / 1e6 / caseIterations;

	start = Bun.nanoseconds();
	for (let i = 0; i < caseIterations; i++) {
		await Promise.all(Array.from({ length: concurrency }, () => runNative()));
	}
	const nativeConcurrentMs = (Bun.nanoseconds() - start) / 1e6 / caseIterations;

	start = Bun.nanoseconds();
	for (let i = 0; i < caseIterations; i++) await runRg();
	const rgMs = (Bun.nanoseconds() - start) / 1e6 / caseIterations;

	start = Bun.nanoseconds();
	for (let i = 0; i < caseIterations; i++) {
		await Promise.all(Array.from({ length: concurrency }, () => runRg()));
	}
	const rgConcurrentMs = (Bun.nanoseconds() - start) / 1e6 / caseIterations;

	console.log(`${c.name}:`);
	console.log(
		`  Native grep:         ${nativeMs.toFixed(2)}ms (${nativeMatches} ${c.mode === GrepOutputMode.FilesWithMatches ? "files" : "matches"})`,
	);
	console.log(`  Native grep ${concurrency}x:      ${nativeConcurrentMs.toFixed(2)}ms`);
	console.log(
		`  Subprocess rg:       ${rgMs.toFixed(2)}ms (${rgMatches} ${c.mode === GrepOutputMode.FilesWithMatches ? "files" : "matches"})`,
	);
	console.log(`  Subprocess rg ${concurrency}x:    ${rgConcurrentMs.toFixed(2)}ms`);

	const nativeVsRg = rgMs / nativeMs;
	const nativeVsRgConcurrent = rgConcurrentMs / nativeConcurrentMs;
	console.log(
		`  => Native grep is ${nativeVsRg > 1 ? `${nativeVsRg.toFixed(1)}x faster` : `${(1 / nativeVsRg).toFixed(1)}x slower`} than rg (sequential)`,
	);
	console.log(
		`  => Native grep is ${nativeVsRgConcurrent > 1 ? `${nativeVsRgConcurrent.toFixed(1)}x faster` : `${(1 / nativeVsRgConcurrent).toFixed(1)}x slower`} than rg (${concurrency}x concurrent)\n`,
	);
}
