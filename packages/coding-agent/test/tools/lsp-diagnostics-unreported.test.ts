import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import { DeferredDiagnostics } from "@oh-my-pi/pi-coding-agent/lsp/deferred-diagnostics";
import type { LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { DeferredDiagnosticsEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { OutputMetaBuilder, wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression tests for issue #15408: a language server that never published a
 * report for a file left the file indistinguishable from a clean one. The
 * server's silence is a missing verdict, so neither the `lsp diagnostics` tool
 * nor the notice an edit/write hands the model may present the file as clean.
 *
 * The unverified state that survives the wait is already carried as
 * `FileDiagnosticsResult.unreported`; what these tests pin is that nothing
 * downstream reads an empty message list as success while it is set.
 */

const lspTestSettings = Settings.isolated();

function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: lspTestSettings } as ToolSession;
}

function textResult(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** A push-only client that never publishes a report for its documents. */
function silentClient(name: string, cwd: string, config: ServerConfig): LspClient {
	return {
		name,
		cwd,
		config,
		proc: {
			stdin: {
				write() {},
				flush: async () => {},
			},
		} as unknown as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		publishedDiagnostics: new Map(),
		pulledDiagnostics: new Map(),
		pendingRequests: new Map(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		startedAt: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

describe("issue #15408: a server that never reported is not a clean file", () => {
	afterEach(() => {
		// Restore in a hook, not at the end of a test body: a failing expectation
		// must not leave the LSP client factory mocked for the next test.
		vi.restoreAllMocks();
	});

	it("fails the `lsp diagnostics` tool instead of answering OK", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-unreported-15408-");
		try {
			const targetFile = path.join(tempDir.path(), "wrangler.toml");
			await Bun.write(targetFile, 'name = "lsp-probe"\n');
			// The diagnostics renderer prefixes status lines via the global theme,
			// which production initializes before any tool runs.
			await initTheme();

			const config: ServerConfig = {
				command: "silent-lsp",
				fileTypes: ["toml"],
				rootMarkers: [],
				// A linter-style server waits the single-file budget rather than the
				// project-aware one, so the unverified wait ends inside the call's own
				// deadline instead of racing it.
				isLinter: true,
			};
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "silent-lsp": config },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["silent-lsp", config]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(silentClient("silent-lsp", tempDir.path(), config));

			const result = await new LspTool(makeLspSession(tempDir.path())).execute("diag-unreported", {
				action: "diagnostics",
				file: targetFile,
				timeout: 1,
			});

			// No server judged the file: the call must not read as a clean one.
			expect(result.details?.success).toBe(false);
			const output = textResult(result);
			expect(output).not.toBe("OK");
			expect(output).toContain("no diagnostics report yet from silent-lsp");
		} finally {
			tempDir.removeSync();
		}
	}, 15_000);

	it("hands the model an unverified notice instead of a silent result", async () => {
		const tool = wrapToolWithMetaNotice({
			name: "probe",
			description: "probe",
			parameters: {} as AgentTool["parameters"],
			execute: async () => ({
				content: [{ type: "text", text: "wrote src/a.ts" }],
				details: {
					meta: new OutputMetaBuilder()
						.diagnostics("no diagnostics report yet from silent-lsp", [], ["silent-lsp"])
						.get(),
				},
			}),
		} as unknown as AgentTool);

		const result = await tool.execute("write-unreported", {});

		// A file nobody checked must not read as one that came back clean.
		const output = textResult(result as AgentToolResult<unknown>);
		expect(output).toContain("LSP diagnostics unavailable: no diagnostics report yet from silent-lsp");
	});

	it("keeps the unverified state in the deferred entry", () => {
		const queued: DeferredDiagnosticsEntry[] = [];
		const session = {
			cwd: "/tmp/issue-15408",
			settings: Settings.isolated({ "lsp.diagnosticsDeduplicate": true }),
			queueDeferredDiagnostics: (entry: DeferredDiagnosticsEntry) => queued.push(entry),
		} as unknown as ToolSession;

		const handle = new DeferredDiagnostics(session).begin("/tmp/issue-15408/wrangler.toml");
		// The server published no verdict: no messages, only the servers that
		// never reported. The batch message the model reads is built from the
		// entry's summary, so dropping the entry would silence the whole result.
		handle.onDeferredDiagnostics({
			messages: [],
			summary: "no diagnostics report yet from silent-lsp",
			errored: false,
			unreported: ["silent-lsp"],
		});

		expect(queued).toHaveLength(1);
		expect(queued[0]?.messages).toEqual([]);
		expect(queued[0]?.summary).toContain("no diagnostics report yet from silent-lsp");
		expect(queued[0]?.unreported).toEqual(["silent-lsp"]);
	});
});
