import { describe, expect, it } from "bun:test";
import {
	__getLegacyPiBundledRegistryGlobal,
	__synthesizeLegacyPiBundledSourceWithRegistry,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

// Regression for issue #3423: Bun 1.3.14 made `--compile` extras unreachable
// via every filesystem-style API, so `legacy-pi-compat.ts` now routes
// canonical `@pk-nerdsaver-ai/pi-*` imports through a virtual specifier whose body
// re-exports a live registry entry from `globalThis`. The synthesizer must
// preserve every named export (and a default if present) so legacy
// extensions see the same surface they would have through a real `file://`
// load — otherwise `import { foo } from "@pk-nerdsaver-ai/pi-coding-agent"` raises
// `Export named 'foo' not found in module ...`.
describe("legacy-pi bundled virtual module synthesizer (issue #3423)", () => {
	const registry = {
		"@pk-nerdsaver-ai/pi-coding-agent": {
			VERSION: "16.1.17",
			defineTool: () => undefined,
			Type: { Object: () => undefined },
		},
		"@pk-nerdsaver-ai/pi-utils": {
			isCompiledBinary: () => false,
			default: () => "default-export",
			VERSION: "16.1.17",
		},
		typebox: {
			Type: { Object: () => undefined },
		},
	};
	const globalKey = __getLegacyPiBundledRegistryGlobal();

	it("emits one ES named export per enumerable namespace key", () => {
		const src = __synthesizeLegacyPiBundledSourceWithRegistry("@pk-nerdsaver-ai/pi-coding-agent", registry);
		expect(src).toContain(
			`const __omp_bundled = globalThis[${JSON.stringify(globalKey)}]["@pk-nerdsaver-ai/pi-coding-agent"];`,
		);
		expect(src).toContain('export const VERSION = __omp_bundled["VERSION"];');
		expect(src).toContain('export const defineTool = __omp_bundled["defineTool"];');
		expect(src).toContain('export const Type = __omp_bundled["Type"];');
		// Every named export emerges from a live registry lookup — never the FS.
		expect(src).not.toMatch(/\$bunfs|file:\/\//);
	});

	it("forwards `default` through `export default` so default imports survive", () => {
		const src = __synthesizeLegacyPiBundledSourceWithRegistry("@pk-nerdsaver-ai/pi-utils", registry);
		expect(src).toContain("export default __omp_bundled.default;");
		// Default and named exports coexist on the same module.
		expect(src).toContain('export const VERSION = __omp_bundled["VERSION"];');
		expect(src).toContain('export const isCompiledBinary = __omp_bundled["isCompiledBinary"];');
	});

	it("omits `default` line when the registered namespace has no default export", () => {
		const src = __synthesizeLegacyPiBundledSourceWithRegistry("@pk-nerdsaver-ai/pi-coding-agent", registry);
		expect(src).not.toContain("export default");
	});

	it("throws when asked to synthesize a key the registry does not cover", () => {
		expect(() => __synthesizeLegacyPiBundledSourceWithRegistry("@pk-nerdsaver-ai/pi-not-bundled", registry)).toThrow(
			/no bundled module registered for @pk-nerdsaver-ai\/pi-not-bundled/,
		);
	});

	it("addresses the same globalThis key the install function would stash to", () => {
		// The emitted source MUST read from the exact key the install function
		// writes to — a rename of either side breaks every legacy extension
		// load with a `Cannot read properties of undefined` at first import.
		const src = __synthesizeLegacyPiBundledSourceWithRegistry("typebox", registry);
		expect(src.startsWith(`const __omp_bundled = globalThis[${JSON.stringify(globalKey)}]["typebox"];`)).toBe(true);
	});

	it("end-to-end: synthesized source resolves named bindings against a runtime globalThis entry", () => {
		// Evaluate the synthesized source in isolation. Bun's loader normally
		// turns it into an ES module; here we use `new Function` to exercise
		// the inner globalThis lookup + property-getter pattern in isolation —
		// it would `throw` if the emitted code addressed the wrong stash key
		// or skipped an enumerable export.
		(globalThis as Record<string, unknown>)[globalKey] = registry;
		try {
			const src = __synthesizeLegacyPiBundledSourceWithRegistry("@pk-nerdsaver-ai/pi-coding-agent", registry);
			// Strip the ES export prefix and run the body as a plain script so
			// we can read `__omp_bundled` from the returned closure.
			const body = src
				.split("\n")
				.filter(line => line.startsWith("const __omp_bundled"))
				.join("\n");
			const fn = new Function(`${body}; return __omp_bundled;`);
			const live = fn() as Record<string, unknown>;
			expect(live.VERSION).toBe("16.1.17");
			expect(typeof live.defineTool).toBe("function");
			expect(typeof live.Type).toBe("object");
		} finally {
			delete (globalThis as Record<string, unknown>)[globalKey];
		}
	});
});
