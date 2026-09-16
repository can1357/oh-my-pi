import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	__rewriteLegacyExtensionSourceForTests,
	installLegacyPiSpecifierShim,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

// The shim registers a process-global Bun plugin (see typebox-remap.test.ts);
// these tests exist to exercise resolution *through* it.
installLegacyPiSpecifierShim();

/** Any importer inside the package, so workspace `node_modules` links resolve. */
const IMPORTER = path.join(import.meta.dir, "entry.ts");

describe("legacy pi shim canonical subpath resolution", () => {
	// Regression: `resolveLegacyPiSpecifier` resolved the specifier it was asked
	// about with `Bun.resolveSync`, which re-runs this plugin's own `onResolve`
	// for that specifier. The hook re-entered itself once per level and every
	// level prefixed `file:` to the inner result, so the path grew past PATH_MAX
	// and callers failed with `BuildMessage: NameTooLong reading
	// "file:file:…/packages/ai/src/index.ts"` — the error that killed an omp
	// process when the /model view started an OAuth login for a greyed-out
	// provider.
	test("a canonical subpath resolves to the real module instead of accumulating file: prefixes", () => {
		// Resolution is idempotent: repeating the lookup must not grow the path.
		const first = Bun.resolveSync("@oh-my-pi/pi-ai/index.js", path.dirname(IMPORTER));
		const second = Bun.resolveSync("@oh-my-pi/pi-ai/index.js", path.dirname(IMPORTER));

		expect(second).toBe(first);
		// At most one `file:` prefix is Bun's own marker for a plugin-resolved
		// path; hundreds of them are the re-entrancy bug.
		expect((first.match(/file:/g) ?? []).length).toBeLessThanOrEqual(1);
		const filePath = first.replace(/^file:/, "");
		expect(fs.existsSync(filePath)).toBe(true);
		expect(path.basename(filePath)).toBe("index.ts");
	});

	test("rewriting an extension import of a canonical subpath emits a loadable file URL", async () => {
		// `@oh-my-pi/pi-ai/oauth` resolves cleanly; `.../index.js` is the form
		// whose resolution re-entered the hook and came back PATH_MAX-corrupted.
		for (const specifier of ["@oh-my-pi/pi-ai/oauth", "@oh-my-pi/pi-ai/index.js"]) {
			const rewritten = await __rewriteLegacyExtensionSourceForTests(`import "${specifier}";\n`, IMPORTER);

			expect(rewritten).not.toContain("file:file:");
			const url = /"([^"]+)"/.exec(rewritten)?.[1] ?? "";
			expect(url.startsWith("file:///")).toBe(true);
			expect(fs.existsSync(url.slice("file://".length))).toBe(true);
		}
	});
});
