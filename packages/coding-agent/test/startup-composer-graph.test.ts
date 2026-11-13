import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const pkgRoot = path.resolve(import.meta.dir, "..");

async function importedModules(entry: string, action = ""): Promise<string[]> {
	const probe = `const NativeWorker = Worker;
		let workers = 0;
		globalThis.Worker = class extends NativeWorker { constructor(...args) { workers++; super(...args); } };
		const module = await import(${JSON.stringify(path.join(pkgRoot, entry))});
		${action}
		if (workers) throw new Error("Unexpected worker construction");
		const reg = [...new Set([...(typeof Loader !== "undefined" && Loader.registry ? [...Loader.registry.keys()] : []), ...Object.keys(require.cache)])];
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
	it("isolates interactive imports and enabled registration from MathJax and workers", async () => {
		for (const [entry, action] of [
			["src/modes/interactive-mode.ts", ""],
			[
				"src/modes/math-image-renderer.ts",
				"module.registerCodingAgentMathImageRenderer({ renderMath: true, showImages: true });",
			],
		]) {
			const modules = await importedModules(entry, action);
			expect(modules.some(module => module.includes("/modes/math-image-renderer"))).toBe(true);
			expect(modules.some(module => module.includes("/tui/src/math-image-renderer"))).toBe(true);
			if (entry.includes("interactive-mode"))
				expect(modules.some(module => module.includes("/modes/interactive-mode"))).toBe(true);
			expectGraphExcludes(modules, [/@mathjax\//, /modes\/mathjax-renderer/, /modes\/math-worker-entry/]);
		}
	});
	it("observes MathJax and static SVG glyph modules in the converter positive control", async () => {
		const modules = await importedModules(
			"src/modes/mathjax-renderer.ts",
			`
			const result = module.renderMathImageSvg({ tex: "x+y=1", display: false, inkHex: "#ffffff", cellWidthPx: 9, cellHeightPx: 18, pixelsPerEx: 9, maxWidthPx: 720 });
			if (!result.svg.includes("<path")) throw new Error("Missing glyph output");`,
		);
		expect(modules.some(module => module.includes("@mathjax/src"))).toBe(true);
		expect(modules.some(module => /@mathjax\/mathjax-tex-font\/.*svg/.test(module))).toBe(true);
	});
});
