import { describe, expect, it } from "bun:test";
import * as url from "node:url";
import {
	__getLegacyPiBundledModulesGlobal,
	__synthesizeLegacyPiBundledSourceWithModules,
	resolveBundledVirtualSpecifier,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { BunPlugin } from "bun";

// Regression for issue #3423: Bun 1.3.14 made `--compile` extras unreachable
// via every filesystem-style API. The compat layer now routes canonical
// `@oh-my-pi/pi-*` imports through virtual modules backed by live host module
// references. The synthesizer must preserve every named/default export.
describe("legacy-pi bundled virtual module synthesizer (issue #3423)", () => {
	const modules = {
		"@oh-my-pi/pi-coding-agent": {
			VERSION: "16.1.17",
			defineTool: () => undefined,
			Type: { Object: () => undefined },
		},
		"@oh-my-pi/pi-utils": {
			isCompiledBinary: () => false,
			default: () => "default-export",
			VERSION: "16.1.17",
		},
		typebox: {
			Type: { Object: () => undefined },
		},
	};
	const globalKey = __getLegacyPiBundledModulesGlobal();

	it("emits one ES named export per enumerable namespace key", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@oh-my-pi/pi-coding-agent", modules);
		expect(src).toContain(
			`const __omp_bundled = globalThis[${JSON.stringify(globalKey)}]["@oh-my-pi/pi-coding-agent"];`,
		);
		expect(src).toContain('export const VERSION = __omp_bundled["VERSION"];');
		expect(src).toContain('export const defineTool = __omp_bundled["defineTool"];');
		expect(src).toContain('export const Type = __omp_bundled["Type"];');
		// Every named export emerges from a live module lookup — never the FS.
		expect(src).not.toMatch(/\$bunfs|file:\/\//);
	});

	it("forwards `default` through `export default` so default imports survive", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@oh-my-pi/pi-utils", modules);
		expect(src).toContain("export default __omp_bundled.default;");
		// Default and named exports coexist on the same module.
		expect(src).toContain('export const VERSION = __omp_bundled["VERSION"];');
		expect(src).toContain('export const isCompiledBinary = __omp_bundled["isCompiledBinary"];');
	});

	it("omits `default` line when the registered namespace has no default export", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@oh-my-pi/pi-coding-agent", modules);
		expect(src).not.toContain("export default");
	});

	it("throws when asked to synthesize a key the bundled modules do not cover", () => {
		expect(() => __synthesizeLegacyPiBundledSourceWithModules("@oh-my-pi/pi-not-bundled", modules)).toThrow(
			/no bundled module registered for @oh-my-pi\/pi-not-bundled/,
		);
	});

	it("addresses the same globalThis key the install function would stash to", () => {
		// The emitted source MUST read from the exact key the install function
		// writes to — a rename of either side breaks every legacy extension
		// load with a `Cannot read properties of undefined` at first import.
		const src = __synthesizeLegacyPiBundledSourceWithModules("typebox", modules);
		expect(src.startsWith(`const __omp_bundled = globalThis[${JSON.stringify(globalKey)}]["typebox"];`)).toBe(true);
	});

	it("end-to-end: synthesized source resolves named bindings against a runtime globalThis entry", () => {
		// Evaluate the synthesized source in isolation. Bun's loader normally
		// turns it into an ES module; here we use `new Function` to exercise
		// the inner globalThis lookup + property-getter pattern in isolation —
		// it would `throw` if the emitted code addressed the wrong stash key
		// or skipped an enumerable export.
		Reflect.set(globalThis, globalKey, modules);
		try {
			const src = __synthesizeLegacyPiBundledSourceWithModules("@oh-my-pi/pi-coding-agent", modules);
			// Strip the ES export prefix and run the body as a plain script so
			// we can read `__omp_bundled` from the returned closure.
			const body = src
				.split("\n")
				.filter(line => line.startsWith("const __omp_bundled"))
				.join("\n");
			const fn = new Function(`${body}; return __omp_bundled;`);
			const live: unknown = fn();
			if (typeof live !== "object" || live === null) {
				throw new Error("synthetic module did not resolve an object namespace");
			}
			expect("VERSION" in live ? live.VERSION : undefined).toBe("16.1.17");
			expect(typeof ("defineTool" in live ? live.defineTool : undefined)).toBe("function");
			expect(typeof ("Type" in live ? live.Type : undefined)).toBe("object");
		} finally {
			Reflect.deleteProperty(globalThis, globalKey);
		}
	});

	it("routes Bun plugin resolution through the bundled namespace so onLoad can serve extension imports", async () => {
		using tempDir = TempDir.createSync("@omp-legacy-pi-bundled-virtual-");
		const entryPath = tempDir.join("extension-entry.ts");
		const bundlePath = tempDir.join("extension-entry.bundle.mjs");

		await Bun.write(
			entryPath,
			['export { legacyAnswer } from "omp-legacy-pi-bundled:@oh-my-pi/pi-utils";', ""].join("\n"),
		);

		expect(resolveBundledVirtualSpecifier("@oh-my-pi/pi-utils")).toEqual({
			namespace: "omp-legacy-pi-bundled",
			path: "@oh-my-pi/pi-utils",
		});
		expect(resolveBundledVirtualSpecifier("omp-legacy-pi-bundled:@oh-my-pi/pi-utils")).toEqual({
			namespace: "omp-legacy-pi-bundled",
			path: "@oh-my-pi/pi-utils",
		});

		const onLoadPaths: string[] = [];
		const plugin: BunPlugin = {
			name: "omp-legacy-pi-bundled-virtual-regression",
			setup(build) {
				build.onResolve({ filter: /^omp-legacy-pi-bundled:.+$/, namespace: "file" }, args =>
					resolveBundledVirtualSpecifier(args.path),
				);
				build.onResolve({ filter: /.*/, namespace: "omp-legacy-pi-bundled" }, args =>
					resolveBundledVirtualSpecifier(args.path),
				);
				build.onLoad({ filter: /.*/, namespace: "omp-legacy-pi-bundled" }, args => {
					onLoadPaths.push(args.path);
					return {
						contents: `export const legacyAnswer = ${JSON.stringify(`served:${args.path}`)};`,
						loader: "js",
					};
				});
			},
		};

		const buildResult = await Bun.build({
			entrypoints: [entryPath],
			external: ["bun"],
			format: "esm",
			plugins: [plugin],
			target: "bun",
		});
		const buildLogs = buildResult.logs.map(log => log.message).join("\n");
		expect(buildResult.success, buildLogs).toBe(true);
		await Bun.write(bundlePath, await buildResult.outputs[0]!.text());
		expect(onLoadPaths).toEqual(["@oh-my-pi/pi-utils"]);

		// The generated bundle has a runtime-selected temp path; importing it is the loading boundary under test.
		const bundledModule = (await import(url.pathToFileURL(bundlePath).href)) as { legacyAnswer: string };
		expect(bundledModule.legacyAnswer).toBe("served:@oh-my-pi/pi-utils");
	});
});
