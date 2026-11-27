import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const pkgRoot = path.resolve(import.meta.dir, "..");

async function importedModules(...entries: string[]): Promise<string[]> {
	const probe = `${entries.map(entry => `await import(${JSON.stringify(path.join(pkgRoot, entry))});`).join("\n")}
		const reg = typeof Loader !== "undefined" && Loader.registry ? [...Loader.registry.keys()] : Object.keys(require.cache);
		console.log(JSON.stringify(reg));`;
	const proc = Bun.spawn([process.execPath, "-e", probe], { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, err).toBe(0);
	const registry: string[] = JSON.parse(out.trim().split("\n").at(-1)!);
	// Windows registry keys use `\`; normalize so the path assertions below are portable.
	return registry.map(module => module.replaceAll("\\", "/"));
}

function expectGraphExcludes(modules: string[], forbidden: RegExp[]): void {
	const violations = modules.filter(module => forbidden.some(pattern => pattern.test(module)));
	expect(violations).toEqual([]);
}

describe("startup composer prepaint graph", () => {
	it("keeps CLI bootstrap isolated from command, worker, provider, and failure-runtime graphs", async () => {
		const modules = await importedModules("src/cli.ts");

		// Positive controls: the entry and its bootstrap-only selector table were evaluated.
		expect(modules.some(module => module.endsWith("/src/cli.ts"))).toBe(true);
		expect(modules.some(module => module.includes("/cli/worker-selectors"))).toBe(true);
		expectGraphExcludes(modules, [
			/commands\/launch/,
			/eval\/js\/worker-core/,
			/eval\/js\/shared\/runtime/,
			/eval\/preludes/,
			/tools\/browser\/aria/,
			/provider-models/,
			/providers\/.*auth/,
			/modes\/interactive-mode/,
			/postmortem/,
			/node:inspector/,
			/node:readline/,
			/node:worker_threads/,
			/omptype/,
		]);
	});

	it("loads session construction only after CLI bootstrap, and optional feature implementations only on demand", async () => {
		const featureOnly = [
			/coding-agent\/src\/cursor(?:-bridge-tools)?\.ts$/,
			/irc\/mesh-link\.ts$/,
			/advisor\/transcript-recorder\.ts$/,
			/registry\/persisted-scan\.ts$/,
			/task\/persisted-revive\.ts$/,
		];
		const main = await importedModules("src/commands/launch.ts", "src/main.ts");
		expectGraphExcludes(main, [
			...featureOnly,
			// Test the combined graph: loading these from launch instead of main is not a win.
			/cli\/(?:auto-update|update-cli|build-service|gc-auto-compress|gc-compress|file-processor)\.ts$/,
			/session\/(?:foreign-session-import|claude-session-store|codex-session-store)\.ts$/,
			/eval\/py\/kernel\.ts$/,
			/utils\/src\/ar\/index\.ts$/,
			/tui\/src\/host\.ts$/,
			/coding-agent\/src\/sdk\.ts$/,
			/coding-agent\/src\/tools\/index\.ts$/,
		]);
		expectGraphExcludes(await importedModules("src/sdk.ts"), [
			...featureOnly,
			// Session construction needs built-in factories and owner hooks, not the public
			// tools barrel, the browser action evaluator, or the optional desktop supervisor.
			/coding-agent\/src\/tools\/index\.ts$/,
			/tools\/browser\/actions\.ts$/,
			/tools\/browser\/aria\/aria-snapshot\.bundle\.txt$/,
			/tools\/computer\/supervisor\.ts$/,
		]);
		expectGraphExcludes(await importedModules("src/cursor.ts"), [/coding-agent\/src\/(sdk|tools\/index)\.ts$/]);
	});
});
