import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import type { TypedLspQueryRequest } from "../lsp";
import type { ToolSession } from "../tools";
import { ContextOracle, createContextOracleCache } from "./context-oracle";

async function makeSession(): Promise<{ dir: string; session: ToolSession }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "context-oracle-"));
	const session = {
		cwd: dir,
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated({ "contextLayer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as ToolSession;
	return { dir, session };
}

describe("ContextOracle", () => {
	test("symbol lookup uses deterministic search evidence without LSP", async () => {
		const { dir, session } = await makeSession();
		await fs.writeFile(path.join(dir, "alpha.ts"), "export function targetSymbol() {\n\treturn 1;\n}\n");
		const result = await new ContextOracle(session).getSymbolContext("targetSymbol", { maxEvidence: 4 });
		expect(result.confidence).toBe("medium");
		expect(result.evidence.some(item => item.type === "search" && item.file === "alpha.ts")).toBe(true);
	});

	test("symbol lookup consumes typed LSP locations without tool text parsing", async () => {
		const { dir, session } = await makeSession();
		session.enableLsp = true;
		const oracle = new ContextOracle(session, {
			queryLsp: async (_cwd, request) => ({
				action: request.action,
				success: true,
				serverName: "test-lsp",
				locations: [
					{
						uri: `file://${path.join(dir, "typed.ts").replaceAll("\\", "/")}`,
						range: {
							start: { line: 4, character: 0 },
							end: { line: 6, character: 1 },
						},
					},
				],
			}),
		});
		const result = await oracle.getSymbolContext("typedSymbol", { file: "typed.ts", line: 5 });
		expect(result.confidence).toBe("high");
		expect(result.evidence[0]).toMatchObject({
			type: "lsp",
			file: "typed.ts",
			range: { startLine: 5, endLine: 7 },
			symbol: "typedSymbol",
		});
	});

	test("symbol lookup cache is shared across oracle instances through the session", async () => {
		const { dir, session } = await makeSession();
		session.contextOracleCache = createContextOracleCache();
		session.enableLsp = true;
		await fs.writeFile(path.join(dir, "symbol-cache.ts"), "export function cachedSymbol() { return 1; }\n");
		let calls = 0;
		const dependencies = {
			queryLsp: async (_cwd: string, request: TypedLspQueryRequest) => {
				calls += 1;
				return {
					action: request.action,
					success: true,
					serverName: "test-lsp",
					locations: [
						{
							uri: `file://${path.join(dir, "symbol-cache.ts").replaceAll("\\", "/")}`,
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 21 },
							},
						},
					],
				};
			},
		};
		const first = await new ContextOracle(session, dependencies).getSymbolContext("cachedSymbol", {
			file: "symbol-cache.ts",
			line: 1,
		});
		const second = await new ContextOracle(session, dependencies).getSymbolContext("cachedSymbol", {
			file: "symbol-cache.ts",
			line: 1,
		});
		expect(calls).toBe(3);
		expect(first.evidence[0]?.type).toBe("lsp");
		expect(second.evidence[0]?.type).toBe("cache");
	});

	test("workspace symbol cache invalidates after file change", async () => {
		const { dir, session } = await makeSession();
		session.contextOracleCache = createContextOracleCache();
		const file = path.join(dir, "symbol-invalidate.ts");
		await fs.writeFile(file, "export const staleSymbol = 1;\n");
		await new ContextOracle(session).getSymbolContext("staleSymbol");
		await Bun.sleep(5);
		await fs.writeFile(file, "export const freshSymbol = 22;\n");
		const result = await new ContextOracle(session).getSymbolContext("freshSymbol");
		expect(result.evidence[0]?.type).not.toBe("cache");
		expect(result.evidence[0]?.detail).toContain("freshSymbol");
	});

	test("configured compressor can shorten answer without changing evidence", async () => {
		const { dir, session } = await makeSession();
		await fs.writeFile(path.join(dir, "compress.ts"), "export function compressMe() { return 1; }\n");
		const oracle = new ContextOracle(session, {
			compressEvidence: async input =>
				`Compressed: ${input.evidence[0]?.file}:${input.evidence[0]?.range?.startLine}`,
		});
		const result = await oracle.getSymbolContext("compressMe");
		expect(result.answer).toBe("Compressed: compress.ts:1");
		expect(result.evidence.some(item => item.type === "search" && item.file === "compress.ts")).toBe(true);
	});

	test("compressor failure falls back to deterministic answer", async () => {
		const { dir, session } = await makeSession();
		await fs.writeFile(path.join(dir, "fallback.ts"), "export const fallbackSymbol = 1;\n");
		const oracle = new ContextOracle(session, {
			compressEvidence: async () => {
				throw new Error("compressor unavailable");
			},
		});
		const result = await oracle.getSymbolContext("fallbackSymbol");
		expect(result.answer).toContain("Context for symbol");
		expect(result.confidence).toBe("medium");
	});

	test("file summary cache invalidates after file change", async () => {
		const { dir, session } = await makeSession();
		const file = path.join(dir, "cache.ts");
		await fs.writeFile(file, "export const first = 1;\n");
		const oracle = new ContextOracle(session);
		const first = await oracle.getFileContext("cache.ts");
		expect(first.evidence[0]?.detail).toContain("first");
		await fs.writeFile(file, "export const second = 22;\nexport const changed = true;\n");
		const second = await oracle.getFileContext("cache.ts");
		expect(second.evidence[0]?.type).not.toBe("cache");
		expect(second.evidence[0]?.detail).toContain("second");
	});

	test("file summary cache is shared across oracle instances through the session", async () => {
		const { dir, session } = await makeSession();
		session.contextOracleCache = createContextOracleCache();
		await fs.writeFile(path.join(dir, "shared-cache.ts"), "export const shared = 1;\n");
		const first = await new ContextOracle(session).getFileContext("shared-cache.ts");
		const second = await new ContextOracle(session).getFileContext("shared-cache.ts");
		expect(first.evidence[0]?.type).toBe("summary");
		expect(second.evidence[0]?.type).toBe("cache");
		expect(second.evidence[1]?.detail).toContain("shared");
	});

	test("shared file summary cache invalidates after file change", async () => {
		const { dir, session } = await makeSession();
		session.contextOracleCache = createContextOracleCache();
		const file = path.join(dir, "shared-invalidate.ts");
		await fs.writeFile(file, "export const oldValue = 1;\n");
		await new ContextOracle(session).getFileContext("shared-invalidate.ts");
		await fs.writeFile(file, "export const newValue = 2;\n");
		const result = await new ContextOracle(session).getFileContext("shared-invalidate.ts");
		expect(result.evidence[0]?.type).not.toBe("cache");
		expect(result.evidence[0]?.detail).toContain("newValue");
	});

	test("cache setting can disable shared cache hits", async () => {
		const { dir, session } = await makeSession();
		session.contextOracleCache = createContextOracleCache();
		session.settings = Settings.isolated({ "contextLayer.enabled": true, "contextLayer.cache": false });
		await fs.writeFile(path.join(dir, "no-cache.ts"), "export const uncached = 1;\n");
		await new ContextOracle(session).getFileContext("no-cache.ts");
		const result = await new ContextOracle(session).getFileContext("no-cache.ts");
		expect(result.evidence[0]?.type).toBe("summary");
	});

	test("diagnostics context returns low confidence when LSP is disabled", async () => {
		const { session } = await makeSession();
		const result = await new ContextOracle(session).getDiagnosticsContext("*");
		expect(result.confidence).toBe("low");
		expect(result.evidence).toEqual([]);
	});

	test("ask returns bounded output", async () => {
		const { dir, session } = await makeSession();
		await fs.writeFile(path.join(dir, "bounded.ts"), `export const ${"x".repeat(80)} = 1;\n`);
		const result = await new ContextOracle(session).ask("x", { maxAnswerChars: 80, maxEvidence: 1 });
		expect(result.answer.length).toBeLessThanOrEqual(80);
		expect(result.evidence.length).toBeLessThanOrEqual(1);
	});

	test("missing evidence returns low confidence instead of inventing", async () => {
		const { dir, session } = await makeSession();
		await fs.writeFile(path.join(dir, "empty.ts"), "export const present = 1;\n");
		const result = await new ContextOracle(session).getSymbolContext("missingSymbol");
		expect(result.confidence).toBe("low");
		expect(result.evidence).toEqual([]);
	});
});
