// Wall time and peak resident memory of `Shell.run` on shallow shell code,
// where every compound list checks the remaining stack, and on deep
// recursion, where execution moves onto allocated stack segments.
//
//   bun bench/shell-nesting.ts [--runs N] ADDON.node [ADDON.node ...]
//
// Each run is a fresh Bun process, so its peak RSS is that run's alone. Runs
// alternate between the given addon builds (A B A B ...), so a change in host
// load falls on every build alike. The script prints one JSON line per run,
// then the median per scenario and build. A run whose process dies is
// reported with its signal and leaves the medians.
//
// To compare two revisions on Linux, build the addon in each checkout with
// `cargo build --profile local -p pi-natives`, copy each
// `target/local/libpi_natives.so` to its own `.node` file, and pass both.
import * as path from "node:path";
import type { Shell } from "../native";

const scenarios: Record<string, string> = {
	"shallow-calls": "f() { :; }; for ((i=0;i<10000;i++)); do f; done",
	"compound-groups": "for ((i=0;i<10000;i++)); do { :; }; done",
	"recursive-20": "f() { if (( $1 > 0 )); then f $(( $1 - 1 )); fi; }; for ((i=0;i<100;i++)); do f 20; done",
	"deep-500":
		'FUNCNEST=5000; f() { if (( $1 > 0 )); then f $(( $1 - 1 )); else /bin/sleep 0.02; printf "LEAF\\n"; fi; }; f 500',
	"deep-4000":
		'FUNCNEST=5000; f() { if (( $1 > 0 )); then f $(( $1 - 1 )); else /bin/sleep 0.02; printf "LEAF\\n"; fi; }; f 4000',
};

interface RunResult {
	elapsedMs: number;
	exitCode: number | undefined;
	maxRssKiB: number;
}

if (Bun.argv[2] === "--child") {
	const [addonPath, scenario] = Bun.argv.slice(3);
	const command = scenarios[scenario];
	if (!addonPath || command === undefined) throw new Error(`unknown scenario ${scenario}`);
	const addon = require(addonPath) as { Shell: new () => Shell };
	const shell = new addon.Shell();
	const started = performance.now();
	const result = await shell.run({ command, timeoutMs: 60_000 }, () => {});
	const run: RunResult = {
		elapsedMs: performance.now() - started,
		exitCode: result.exitCode,
		maxRssKiB: process.resourceUsage().maxRSS,
	};
	console.log(JSON.stringify(run));
	process.exit(0);
}

const args = Bun.argv.slice(2);
let runs = 5;
if (args[0] === "--runs") {
	runs = Number(args[1]);
	args.splice(0, 2);
}
const addons = args.map(addon => path.resolve(addon));
if (addons.length === 0 || !Number.isInteger(runs) || runs < 1) {
	throw new Error("Usage: bun bench/shell-nesting.ts [--runs N] ADDON.node [ADDON.node ...]");
}

const median = (values: number[]): number => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

const completed = new Map<string, RunResult[]>();
const died = new Map<string, number>();
for (let run = 0; run < runs; run++) {
	for (const scenario of Object.keys(scenarios)) {
		for (const addon of addons) {
			const child = Bun.spawn([process.execPath, import.meta.path, "--child", addon, scenario], {
				stdout: "pipe",
				stderr: "inherit",
			});
			const stdout = await new Response(child.stdout).text();
			await child.exited;
			const key = `${scenario}\0${addon}`;
			if (child.exitCode === 0) {
				const result = JSON.parse(stdout) as RunResult;
				completed.set(key, [...(completed.get(key) ?? []), result]);
				console.log(JSON.stringify({ run, scenario, addon, ...result }));
			} else {
				died.set(key, (died.get(key) ?? 0) + 1);
				console.log(JSON.stringify({ run, scenario, addon, exitCode: child.exitCode, signal: child.signalCode }));
			}
		}
	}
}

for (const scenario of Object.keys(scenarios)) {
	for (const addon of addons) {
		const key = `${scenario}\0${addon}`;
		const results = completed.get(key) ?? [];
		console.log(
			JSON.stringify({
				scenario,
				addon,
				completed: results.length,
				died: died.get(key) ?? 0,
				medianElapsedMs: results.length ? median(results.map(result => result.elapsedMs)) : null,
				medianMaxRssKiB: results.length ? median(results.map(result => result.maxRssKiB)) : null,
			}),
		);
	}
}
