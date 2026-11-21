/**
 * Boot module-load recorder.
 *
 * Runs as a `bun --preload` ahead of the module under test, so every repository
 * source file the entry evaluates is recorded before the entry's own statement
 * runs. Consumers spawn it as
 * `bun --preload <this file> <entry module>` and read the `BOOT_MODULES` line it
 * writes to stdout on exit.
 *
 * Only repository source files are intercepted: `node_modules` keeps Bun's
 * native loader so package graphs evaluate exactly as they do in a real launch.
 */
import { readFileSync } from "node:fs";

const loaded: string[] = [];
const startedAt = performance.now();

/**
 * Repository source files under `packages/<name>/src/`.
 *
 * Both path separators are accepted: a POSIX-only filter matches nothing on
 * Windows, which silently turned the recorder into a no-op there.
 */
const REPO_SOURCE_FILTER = /[\\/]packages[\\/][^\\/]+[\\/]src[\\/](?!.*\.d\.ts$).+\.tsx?$/;

Bun.plugin({
	name: "boot-module-load-recorder",
	setup(build) {
		// Synchronous on purpose: a module served by an async onLoad cannot be
		// `require()`d (Bun's CJS bridge rejects it), so the recorded graph would
		// diverge from a real launch.
		build.onLoad({ filter: REPO_SOURCE_FILTER }, args => {
			loaded.push(args.path);
			const loader = args.path.endsWith("x") ? "tsx" : "ts";
			return { contents: readFileSync(args.path, "utf8"), loader };
		});
	},
});

interface BootModuleReport {
	entry: string | undefined;
	repoModulesLoaded: number;
	entryEvaluatedMs: number;
	modules: string[];
}

let reported = false;

/**
 * Write the recorded module graph to stdout.
 *
 * Consumers that stop the launch themselves call this before exiting, because
 * the process may hold long-lived handles that keep it from exiting naturally.
 * The `exit` handler below is the fallback for consumers that just end.
 */
export function writeBootModuleReport(): void {
	if (reported) return;
	reported = true;
	const report: BootModuleReport = {
		entry: process.argv[1],
		repoModulesLoaded: loaded.length,
		entryEvaluatedMs: Math.round(performance.now() - startedAt),
		modules: loaded,
	};
	process.stdout.write(`BOOT_MODULES ${JSON.stringify(report)}\n`);
}

process.on("exit", () => {
	writeBootModuleReport();
});
