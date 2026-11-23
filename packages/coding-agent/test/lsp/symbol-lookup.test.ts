import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { DocumentSymbol } from "@oh-my-pi/pi-coding-agent/lsp/types";
import {
	findSymbolInFile,
	formatMatchingDocumentSymbols,
	resolveDiagnosticTargets,
} from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { TempDir } from "@oh-my-pi/pi-utils";

function symbol(name: string, line: number, children?: DocumentSymbol[]): DocumentSymbol {
	const range = { start: { line, character: 0 }, end: { line, character: 1 } };
	return { name, kind: 12, range, selectionRange: range, children };
}

describe("formatMatchingDocumentSymbols", () => {
	test("keeps matching symbols with their container path", () => {
		const tree = [symbol("Schema", 0, [symbol("isInt", 4), symbol("isString", 9)]), symbol("parseInt", 20)];
		const lines = formatMatchingDocumentSymbols(tree, "isint");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("isInt");
		expect(lines[0]).toContain("@ line 5 (in Schema)");
	});
});

describe("findSymbolInFile", () => {
	let tempDir: TempDir | undefined;
	afterEach(() => {
		tempDir?.removeSync();
		tempDir = undefined;
	});

	test("finds the Nth whole-word occurrence when no line is given", async () => {
		tempDir = TempDir.createSync("@omp-lsp-find-symbol-");
		const file = path.join(tempDir.path(), "a.ts");
		await Bun.write(file, "const targetValue = 1;\nfunction target() {}\ntarget();\n");
		expect(await findSymbolInFile(file, "target")).toEqual({ line: 2, character: 9 });
		expect(await findSymbolInFile(file, "target#2")).toEqual({ line: 3, character: 0 });
		await expect(findSymbolInFile(file, "missing")).rejects.toThrow('Symbol "missing" not found');
	});
});

describe("resolveDiagnosticTargets", () => {
	let tempDir: TempDir | undefined;
	afterEach(() => {
		tempDir?.removeSync();
		tempDir = undefined;
	});

	test("accepts a ;-separated list of paths and globs", async () => {
		tempDir = TempDir.createSync("@omp-lsp-diag-targets-");
		const root = tempDir.path();
		await Bun.write(path.join(root, "a.ts"), "");
		await Bun.write(path.join(root, "lib", "b.ts"), "");
		await Bun.write(path.join(root, "lib", "c.ts"), "");
		const { matches, truncated } = await resolveDiagnosticTargets("a.ts; lib/*.ts", root, 10);
		expect(truncated).toBe(false);
		expect(matches.sort()).toEqual(["a.ts", path.join("lib", "b.ts"), path.join("lib", "c.ts")]);
	});
});
