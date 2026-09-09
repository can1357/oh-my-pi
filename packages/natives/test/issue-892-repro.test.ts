/**
 * Repro for https://github.com/can1357/oh-my-pi/issues/892
 *
 * The old CommonJS fix depended on Bun's CJS-to-ESM analyzer statically
 * scanning `module.exports.<Name> = …` assignments. The loader is now ESM,
 * so named exports must be real `export const` declarations instead of CJS
 * assignments that Bun happens to detect.
 *
 * The contract this test pins down: ESM consumers of `@oh-my-pi/pi-natives`
 * resolve to `native/index.js`, and that file declares every public symbol
 * from `native/index.d.ts` as a real ESM named export.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const nativeDir = path.join(import.meta.dir, "..", "native");
const indexJsPath = path.join(nativeDir, "index.js");
const indexDtsPath = path.join(nativeDir, "index.d.ts");

const PUBLIC_SYMBOL_RE = /^export declare (?:class|function|enum) (\w+)/gm;

async function readPublicSymbols(): Promise<string[]> {
	const dts = await Bun.file(indexDtsPath).text();
	const names: string[] = [];
	PUBLIC_SYMBOL_RE.lastIndex = 0;
	for (;;) {
		const m = PUBLIC_SYMBOL_RE.exec(dts);
		if (m === null) break;
		names.push(m[1]!);
	}
	return names;
}

function esmExportsName(js: string, name: string): boolean {
	const escaped = name.replace(/[$]/g, "\\$");
	const re = new RegExp(`(?:^|\\n)\\s*export\\s+const\\s+${escaped}\\s*=`);
	return re.test(js);
}

describe("issue 892: pi-natives public surface", () => {
	it("declares every public .d.ts symbol as an explicit ESM export", async () => {
		const [js, symbols] = await Promise.all([Bun.file(indexJsPath).text(), readPublicSymbols()]);
		expect(symbols.length).toBeGreaterThan(0);

		const missing = symbols.filter(name => !esmExportsName(js, name));
		expect(missing).toEqual([]);
	});
});
