import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { configCache, formatRejectedConfigSources, loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { readConfigFileResult } from "@oh-my-pi/pi-coding-agent/utils/config-file-sources";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const lspTestSettings = await Settings.init({ inMemory: true });

function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: lspTestSettings } as ToolSession;
}

function textResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

/**
 * `loadConfig` walks user config dirs under os.homedir(). Isolate HOME so a
 * developer lsp.json cannot mask the fixture (#15528 coverage).
 */
let lspHomeOverride: string | undefined;
let lspOriginalHome: string | undefined;

beforeEach(() => {
	lspOriginalHome = process.env.HOME;
	lspHomeOverride = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lsp-rejected-home-"));
	process.env.HOME = lspHomeOverride;
	vi.spyOn(os, "homedir").mockReturnValue(lspHomeOverride);
});

afterEach(() => {
	if (lspOriginalHome === undefined) delete process.env.HOME;
	else process.env.HOME = lspOriginalHome;
	if (lspHomeOverride) fs.rmSync(lspHomeOverride, { recursive: true, force: true });
	lspHomeOverride = undefined;
	vi.restoreAllMocks();
});

describe("LSP rejected config sources (#15528)", () => {
	it("readConfigFileResult distinguishes absent, invalid, and unreadable paths", () => {
		const tempDir = TempDir.createSync("@omp-cfg-read-result-");
		try {
			const parseJson = (content: string) => JSON.parse(content) as unknown;

			const missing = path.join(tempDir.path(), "missing.json");
			expect(readConfigFileResult(missing, parseJson)).toEqual({ kind: "absent" });

			const invalid = path.join(tempDir.path(), "bad.json");
			fs.writeFileSync(invalid, '{"servers":');
			const invalidResult = readConfigFileResult(invalid, content => {
				parseJson(content);
				return { ok: true };
			});
			expect(invalidResult.kind).toBe("rejected");
			if (invalidResult.kind === "rejected") {
				expect(invalidResult.rejection.path).toBe(invalid);
				expect(invalidResult.rejection.reason).toBe("invalid");
				expect(invalidResult.rejection.message.length).toBeGreaterThan(0);
			}

			const notObject = path.join(tempDir.path(), "array.json");
			fs.writeFileSync(notObject, "[]");
			const nullAdapt = readConfigFileResult(notObject, () => null);
			expect(nullAdapt).toEqual({
				kind: "rejected",
				rejection: {
					path: notObject,
					reason: "invalid",
					message: "config did not contain a usable object",
				},
			});
		} finally {
			tempDir.removeSync();
		}
	});

	it.skipIf(process.platform === "win32")("readConfigFileResult reports unreadable files", () => {
		const tempDir = TempDir.createSync("@omp-cfg-unreadable-");
		try {
			const locked = path.join(tempDir.path(), "locked.json");
			fs.writeFileSync(locked, '{"servers":{}}');
			fs.chmodSync(locked, 0);
			try {
				const result = readConfigFileResult(locked, content => JSON.parse(content) as unknown);
				expect(result.kind).toBe("rejected");
				if (result.kind === "rejected") {
					expect(result.rejection.reason).toBe("unreadable");
					expect(result.rejection.path).toBe(locked);
				}
			} finally {
				fs.chmodSync(locked, 0o644);
			}
		} finally {
			tempDir.removeSync();
		}
	});

	it("loadConfig records malformed .omp/lsp.json and leaves absent paths silent", () => {
		const tempDir = TempDir.createSync("@omp-lsp-malformed-load-");
		try {
			const cwd = tempDir.path();
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "lsp.json"), '{"servers":');

			configCache.delete(cwd);
			const config = loadConfig(cwd);

			expect(config.rejectedSources?.length).toBe(1);
			expect(config.rejectedSources?.[0]?.reason).toBe("invalid");
			expect(config.rejectedSources?.[0]?.path).toBe(path.join(cwd, ".omp", "lsp.json"));
			expect(formatRejectedConfigSources(cwd, config.rejectedSources)[0]).toContain(path.join(".omp", "lsp.json"));
		} finally {
			configCache.delete(tempDir.path());
			tempDir.removeSync();
		}
	});

	it("loadConfig accepts a valid override without rejectedSources", () => {
		const tempDir = TempDir.createSync("@omp-lsp-valid-load-");
		try {
			const cwd = tempDir.path();
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".omp", "lsp.json"),
				JSON.stringify({
					servers: {
						"fake-custom": {
							command: process.execPath,
							fileTypes: [".xyz"],
							rootMarkers: ["."],
						},
					},
				}),
			);

			configCache.delete(cwd);
			const config = loadConfig(cwd);
			expect(config.rejectedSources).toBeUndefined();
			expect(config.servers["fake-custom"]).toBeDefined();
		} finally {
			configCache.delete(tempDir.path());
			tempDir.removeSync();
		}
	});

	it("status names the rejected source path and parse diagnostic", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-malformed-status-");
		try {
			const cwd = tempDir.path();
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "lsp.json"), '{"servers":');
			configCache.delete(cwd);

			const tool = new LspTool(makeLspSession(cwd));
			const output = textResult(await tool.execute("status-rejected", { action: "status" }));

			expect(output).toContain(`Rejected config: ${path.join(".omp", "lsp.json")} (invalid):`);
		} finally {
			configCache.delete(tempDir.path());
			tempDir.removeSync();
		}
	});

	it("reload * reports the rejected source when config cannot be applied", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-malformed-reload-");
		try {
			const cwd = tempDir.path();
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "lsp.json"), "not: [yaml");
			configCache.delete(cwd);

			const tool = new LspTool(makeLspSession(cwd));
			const output = textResult(await tool.execute("reload-rejected", { action: "reload", file: "*" }));

			expect(output).toContain("No language server found for this action");
			expect(output).toContain(`Rejected config: ${path.join(".omp", "lsp.json")} (invalid):`);
		} finally {
			configCache.delete(tempDir.path());
			tempDir.removeSync();
		}
	});
});
