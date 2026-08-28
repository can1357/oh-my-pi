import { describe, expect, test } from "bun:test";
import { getDiagnosticsForFile } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import type { Diagnostic, LinterClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";

/**
 * Regression test for issue #4910: `edit` silently hangs forever on some
 * files, and because the edit tool runs `exclusive`, every later edit queues
 * behind the wedged one.
 *
 * Root cause: the batched writethrough flush reaches `getDiagnosticsForFile`
 * on its blocking (non-deferred) branch with a user-abort-only signal. Two
 * steps inside the per-server pipeline had no own deadline:
 *
 * 1. `getOrCreateClient` → `sendRequest(client, "initialize", …, signal)`
 *    skips its default timeout whenever a signal is present, assuming the
 *    caller's signal is a deadline. The edit tool's signal only fires on user
 *    abort, so a wedged language server blocked the request forever.
 * 2. Custom `LinterClient.lint` takes no signal or timeout at all, so a hung
 *    linter subprocess blocked forever.
 *
 * The fix wraps each server's whole pipeline in `untilAborted` with a
 * wall-clock budget (`pipelineBudgetMs`, defaulting to the diagnostics wait
 * budget plus `DIAGNOSTICS_PIPELINE_GRACE_MS`). An overrunning server is
 * rejected, skipped by the existing `Promise.allSettled` collection, and the
 * edit returns.
 *
 * These tests use the custom-linter branch (no real LSP process needed) with
 * the `pipelineBudgetMs` test seam shrunk so the bound is observable in
 * milliseconds.
 */

/** A linter whose `lint` never settles — models a hung linter subprocess. */
function hungLinterConfig(): ServerConfig {
	const client: LinterClient = {
		format: async (_filePath, content) => content,
		lint: () => Promise.withResolvers<Diagnostic[]>().promise,
	};
	return {
		command: "hung-linter-4910",
		fileTypes: [".py"],
		rootMarkers: [],
		createClient: () => client,
	};
}

/** A healthy linter that returns immediately with no findings. */
function healthyLinterConfig(): ServerConfig {
	const client: LinterClient = {
		format: async (_filePath, content) => content,
		lint: async () => [],
	};
	return {
		command: "healthy-linter-4910",
		fileTypes: [".py"],
		rootMarkers: [],
		createClient: () => client,
	};
}

describe("issue #4910: diagnostics pipeline is wall-clock bounded", () => {
	test("a linter that never settles cannot hang getDiagnosticsForFile", async () => {
		const started = Date.now();
		// Unique server name: getLinterClient caches by `serverName:cwd`.
		const result = await getDiagnosticsForFile(
			"/tmp/issue-4910/falcon_emu.py",
			"/tmp/issue-4910",
			[["hung-linter-4910", hungLinterConfig()]],
			{ pipelineBudgetMs: 50 },
		);
		const elapsed = Date.now() - started;

		// The hung server is skipped, so no server produced results.
		expect(result).toBeUndefined();
		// Bounded promptly by the budget, not by any multi-second default.
		// Generous ceiling to stay robust on slow CI machines.
		expect(elapsed).toBeLessThan(5_000);
	});

	test("passes the pipeline deadline to cancellable linter work", async () => {
		let aborted = false;
		const pending = Promise.withResolvers<Diagnostic[]>();
		const client: LinterClient = {
			format: async (_filePath, content) => content,
			lint: (_filePath, signal) => {
				signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						pending.reject(signal.reason);
					},
					{ once: true },
				);
				return pending.promise;
			},
		};
		const config: ServerConfig = {
			command: "cancellable-linter-4910",
			fileTypes: [".py"],
			rootMarkers: [],
			createClient: () => client,
		};

		const result = await getDiagnosticsForFile(
			"/tmp/issue-4910/falcon_emu.py",
			"/tmp/issue-4910",
			[["cancellable-linter-4910", config]],
			{ pipelineBudgetMs: 50 },
		);

		expect(result).toBeUndefined();
		expect(aborted).toBe(true);
	});

	test("a healthy linter still reports normally under the same budget", async () => {
		const result = await getDiagnosticsForFile(
			"/tmp/issue-4910/falcon_emu.py",
			"/tmp/issue-4910",
			[["healthy-linter-4910", healthyLinterConfig()]],
			{ pipelineBudgetMs: 5_000 },
		);

		expect(result).toBeDefined();
		expect(result?.server).toBe("healthy-linter-4910");
		expect(result?.summary).toBe("OK");
		expect(result?.errored).toBe(false);
	});
});
