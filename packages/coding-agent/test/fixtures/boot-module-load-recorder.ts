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

const loaded: string[] = [];
const startedAt = performance.now();

Bun.plugin({
	name: "boot-module-load-recorder",
	setup(build) {
		build.onLoad({ filter: /\/packages\/[^/]+\/src\/(?!.*\.d\.ts$).+\.tsx?$/ }, async args => {
			loaded.push(args.path);
			const loader = args.path.endsWith("x") ? "tsx" : "ts";
			return { contents: await Bun.file(args.path).text(), loader };
		});
	},
});

interface BootModuleReport {
	entry: string | undefined;
	repoModulesLoaded: number;
	entryEvaluatedMs: number;
	modules: string[];
}

process.on("exit", () => {
	const report: BootModuleReport = {
		entry: process.argv[1],
		repoModulesLoaded: loaded.length,
		entryEvaluatedMs: Math.round(performance.now() - startedAt),
		modules: loaded,
	};
	process.stdout.write(`BOOT_MODULES ${JSON.stringify(report)}\n`);
});
