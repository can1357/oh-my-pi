import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import {
	DiagnosticsUnavailableError,
	getDiagnosticsForFile,
	waitForDiagnostics,
} from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import { DeferredDiagnostics } from "@oh-my-pi/pi-coding-agent/lsp/deferred-diagnostics";
import type { Diagnostic, LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { DeferredDiagnosticsEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type LspToolDetails } from "@oh-my-pi/pi-tui/tools/lsp";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression tests for issue #15408: `lsp diagnostics` reported `OK` with
 * `success: true` for a file whose language server never published a report
 * for it. "No publish observed" was indistinguishable from "clean", so an
 * agent could be told a broken file was fine.
 *
 * The fix refuses the unverified wait: a file no server judged is reported as
 * unjudged, never as clean.
 */

const lspTestSettings = Settings.isolated();

function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: lspTestSettings } as ToolSession;
}

function textResult(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** A push-only client that never publishes anything for its documents. */
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
		pendingRequests: new Map(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

const FINDING: Diagnostic = {
	message: "expected a value of type String",
	severity: 1,
	range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
};

describe("issue #15408: diagnostics that never arrive are not a clean file", () => {
	// Restore in a hook, not at the end of a test body: an expectation that
	// fails must not leave `getOrCreateClient` mocked for the next test.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses the wait when the server published nothing for the document", async () => {
		const client = silentClient("silent-push", "/tmp/issue-15408", {
			command: "silent-push",
			fileTypes: ["toml"],
			rootMarkers: [],
		});
		const uri = "file:///tmp/issue-15408/wrangler.toml";

		// Before the fix this resolved with `[]`, which every caller read as
		// "the server reported the file clean".
		await expect(waitForDiagnostics(client, uri, { timeoutMs: 50 })).rejects.toBeInstanceOf(
			DiagnosticsUnavailableError,
		);
	});

	it("still accepts a published report", async () => {
		const client = silentClient("push-lsp", "/tmp/issue-15408", {
			command: "push-lsp",
			fileTypes: ["toml"],
			rootMarkers: [],
		});
		const uri = "file:///tmp/issue-15408/wrangler.toml";
		client.diagnostics.set(uri, { diagnostics: [FINDING], version: null });
		client.diagnosticsVersion += 1;

		expect(await waitForDiagnostics(client, uri, { timeoutMs: 1_000, settleMs: 0 })).toEqual([FINDING]);
	});

	it("accepts an empty published report instead of refusing it", async () => {
		const client = silentClient("push-lsp", "/tmp/issue-15408", {
			command: "push-lsp",
			fileTypes: ["toml"],
			rootMarkers: [],
		});
		const uri = "file:///tmp/issue-15408/wrangler.toml";
		// The server published a report and it was empty: that is a verdict
		// (a clean file), not a missing one. Only a missing report is refused,
		// so this case must not be confused with the one above.
		client.diagnostics.set(uri, { diagnostics: [], version: null });
		client.diagnosticsVersion += 1;

		expect(await waitForDiagnostics(client, uri, { timeoutMs: 1_000, settleMs: 0 })).toEqual([]);
	});

	it("reports a file no server judged as unjudged instead of clean", async () => {
		const config: ServerConfig = { command: "silent-lsp", fileTypes: ["toml"], rootMarkers: [] };
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(
			silentClient("silent-lsp", "/tmp/issue-15408", config),
		);

		const result = await getDiagnosticsForFile(
			"/tmp/issue-15408/wrangler.toml",
			"/tmp/issue-15408",
			[["silent-lsp", config]],
			{ timeoutMs: 50 },
		);

		// The file was never checked, so the result must not claim it was clean.
		expect(result?.summary).toBe("diagnostics unavailable from silent-lsp");
		expect(result?.messages).toEqual([]);
		expect(result?.errored).toBe(false);
		expect(result?.unjudgedServers).toEqual(["silent-lsp"]);
	});

	it("keeps the findings of a server that judged the file and names the silent one", async () => {
		const judgedConfig: ServerConfig = { command: "judged-lsp", fileTypes: ["toml"], rootMarkers: [] };
		const silentConfig: ServerConfig = { command: "silent-lsp", fileTypes: ["toml"], rootMarkers: [] };
		const uri = "file:///tmp/issue-15408/wrangler.toml";

		const judged = silentClient("judged-lsp", "/tmp/issue-15408", judgedConfig);
		judged.diagnostics.set(uri, { diagnostics: [FINDING], version: null });
		judged.diagnosticsVersion += 1;

		vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async config =>
			config.command === "judged-lsp" ? judged : silentClient("silent-lsp", "/tmp/issue-15408", silentConfig),
		);

		const result = await getDiagnosticsForFile(
			"/tmp/issue-15408/wrangler.toml",
			"/tmp/issue-15408",
			[
				["judged-lsp", judgedConfig],
				["silent-lsp", silentConfig],
			],
			{ timeoutMs: 500 },
		);

		// The real finding survives, and the report says it is incomplete.
		expect(result?.messages).toHaveLength(1);
		expect(result?.errored).toBe(true);
		expect(result?.summary).toContain("1 error(s)");
		expect(result?.summary).toContain("diagnostics unavailable from silent-lsp");
		expect(result?.unjudgedServers).toEqual(["silent-lsp"]);
	});

	it("fails the `lsp diagnostics` tool instead of reporting a clean file", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-unavailable-15408-");
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
				// A linter-style server: the tool waits the single-file budget for
				// its report, so the wait ends before the tool deadline.
				isLinter: true,
			};
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "silent-lsp": config },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["silent-lsp", config]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(silentClient("silent-lsp", tempDir.path(), config));

			const result = await new LspTool(makeLspSession(tempDir.path())).execute("diag-unavailable", {
				action: "diagnostics",
				file: targetFile,
				timeout: 5,
			});

			// A file no server judged must not come back as `OK`/success.
			expect(result.details?.success).toBe(false);
			const output = textResult(result);
			expect(output).not.toBe("OK");
			expect(output).toContain("no diagnostics available");
			expect(output).toContain("silent-lsp");
		} finally {
			tempDir.removeSync();
		}
	}, 15_000);

	// A post-write diagnostics request that misses the inline window is
	// delivered later, as a deferred entry. The entry has to name the servers
	// that published no verdict: the late renderer counts the messages only,
	// so an entry without them reads as a clean file (issue #15408).
	it("carries the unjudged servers into the deferred entry", () => {
		const queued: DeferredDiagnosticsEntry[] = [];
		const session = {
			cwd: "/tmp/issue-15408",
			settings: Settings.isolated({ "lsp.diagnosticsDeduplicate": true }),
			queueDeferredDiagnostics: (entry: DeferredDiagnosticsEntry) => queued.push(entry),
		} as unknown as ToolSession;

		const deferred = new DeferredDiagnostics(session);
		const handle = deferred.begin("/tmp/issue-15408/wrangler.toml");
		// The server published no verdict: the result carries no messages, only
		// the names of the servers that never answered.
		handle.onDeferredDiagnostics({
			messages: [],
			summary: "diagnostics unavailable from silent-lsp",
			errored: false,
			unjudgedServers: ["silent-lsp"],
		});

		expect(queued).toHaveLength(1);
		expect(queued[0]?.messages).toEqual([]);
		expect(queued[0]?.unjudgedServers).toEqual(["silent-lsp"]);
	});
});
