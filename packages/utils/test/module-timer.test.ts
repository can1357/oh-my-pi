import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ModuleLoadEvent } from "../src/timing-buffer";

const preload = resolve(import.meta.dir, "../src/module-timer.ts");
const buffer = resolve(import.meta.dir, "../src/timing-buffer.ts");

test("the opt-in preload observes reads and top-level evaluation, not the gap between them", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-module-timer-"));
	const cwd = join(root, "packages/utils/src");
	try {
		mkdirSync(cwd, { recursive: true });
		copyFileSync(preload, join(cwd, "module-timer.ts"));
		copyFileSync(buffer, join(cwd, "timing-buffer.ts"));
		const write = (name: string, source: string) => writeFileSync(join(cwd, name), source);
		mkdirSync(join(cwd, "jsx"));
		write("jsx/jsx-runtime.js", "export const jsx = tag => tag;");
		write("jsx/jsx-dev-runtime.js", "export const jsxDEV = tag => tag;");
		write("leaf.ts", `export const begin = performance.now();
await Bun.file(import.meta.path).text();
export const end = performance.now();`);
		write("root.tsx", `#!/usr/bin/env bun
/** @jsxImportSource ./jsx */
"use strict"
import { begin, end } from "./leaf.ts";
export const bounds = [begin, end];
export const tag = <probe/>;
`);
		write("asset.d.ts", "declare const text: string;");
		write("common.cts", "module.exports = 42;");
		writeFileSync(join(root, "common.ts"), "module.exports = 99;");
		write("after-stop.ts", "export const afterStop = true;");
		write("later.ts", "export const later = performance.now();");
		write("entry.mjs", `
import { drainModuleLoadEvents, stopModuleLoadTiming } from "./timing-buffer.ts";
import { bounds, tag } from "./root.tsx";
import asset from "./asset.d.ts" with { type: "text" };
import common from "./common.cts";
import commonTS from "../../../common.ts";
const first = drainModuleLoadEvents();
// Load a second module after draining to exercise the preload's retained queue.
const { later } = await import("./later.ts");
const second = drainModuleLoadEvents();
stopModuleLoadTiming();
// Exercise the opt-out boundary; a static import would have already evaluated.
const { afterStop } = await import("./after-stop.ts");
console.log(JSON.stringify({ bounds, tag, common, commonTS, asset, first, later, second, afterStop, third: drainModuleLoadEvents() }));
`);
		for (const mode of ["x", "x,modules", "full"]) {
			const run = Bun.spawnSync([process.execPath, "--preload", "./module-timer.ts", "entry.mjs"], {
				cwd,
				env: { ...process.env, PI_TIMING: mode },
			});
			expect(run.exitCode, run.stderr.toString()).toBe(0);
			const { bounds, tag, common, commonTS, asset, first, later, second, afterStop, third } = JSON.parse(run.stdout.toString());
			expect(third).toEqual([]);
			expect(afterStop).toBe(true);
			expect(commonTS).toBe(99);
			expect(tag).toBe("probe");
			expect(common).toBe(42);
			expect(asset).toBe("declare const text: string;");
			if (mode === "x") {
				expect([first, second]).toEqual([[], []]);
				continue;
			}
			expect(first.map((event: ModuleLoadEvent) => basename(event.path))).toEqual(["leaf.ts", "root.tsx"]);
			expect(second.map((event: ModuleLoadEvent) => basename(event.path))).toEqual(["later.ts"]);
			for (const event of [...first, ...second]) {
				expect(event.readStart).toBeLessThanOrEqual(event.readEnd);
				expect(event.readEnd).toBeLessThanOrEqual(event.bodyStart);
				expect(event.bodyStart).toBeLessThanOrEqual(event.bodyEnd);
			}
			const [leaf, root] = first;
			expect(leaf.bodyStart).toBeLessThanOrEqual(bounds[0]);
			expect(bounds[0]).toBeLessThan(bounds[1]);
			expect(bounds[1]).toBeLessThanOrEqual(leaf.bodyEnd);
			expect(leaf.bodyEnd).toBeLessThanOrEqual(root.bodyStart);
			expect(second[0].bodyStart).toBeLessThanOrEqual(later);
			expect(later).toBeLessThanOrEqual(second[0].bodyEnd);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
