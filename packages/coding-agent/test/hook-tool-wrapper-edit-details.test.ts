/**
 * `EditToolResultEvent.details` is no longer the producer's raw legacy
 * bag (`EditToolDetails`) — it's projected into a per-file outcome shape at
 * the `tool_result` construction boundary (`normalizeToolEventDetails`,
 * `extensibility/tool-event-details.ts`). Exercised through the real
 * `HookToolWrapper` route (not the projection function in isolation) so this
 * proves the actual event a hook observes, not just that the helper compiles.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { HookRunner, type LoadedHook } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { HookToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/tool-wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("HookToolWrapper tool_result edit details projection", () => {
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-hook-wrapper-edit-details-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	function makeRunner(capture: (event: unknown) => void): HookRunner {
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
		handlers.set("tool_result", [
			async (event: unknown) => {
				capture(event);
				return undefined;
			},
		]);
		const hook: LoadedHook = {
			path: "test-hook",
			resolvedPath: "/test/test-hook.ts",
			handlers,
			messageRenderers: new Map(),
			commands: new Map(),
			setSendMessageHandler: () => {},
			setAppendEntryHandler: () => {},
		} as unknown as LoadedHook;
		return new HookRunner([hook], sharedTempDir.path(), SessionManager.inMemory(), modelRegistry);
	}

	function makeEditTool(details: unknown): AgentTool {
		return {
			name: "edit",
			label: "Edit",
			description: "Test edit tool",
			parameters: Type.Object({ path: Type.String() }),
			strict: true,
			execute: async () => ({ content: [{ type: "text", text: "done" }], details }),
		} as AgentTool;
	}

	it("projects a single-file bag into one applied file entry", async () => {
		let captured: { details?: unknown } | undefined;
		const runner = makeRunner(event => {
			captured = event as { details?: unknown };
		});
		const wrapped = new HookToolWrapper(
			makeEditTool({ diff: "--- a\n+++ b\n", path: "src/single-file-42871.ts", oldText: "one", newText: "two" }),
			runner,
		);

		await wrapped.execute("call-single", { path: "src/single-file-42871.ts" } as never);

		expect(captured?.details).toEqual({
			diff: "--- a\n+++ b\n",
			files: [
				{
					status: "applied",
					path: "src/single-file-42871.ts",
					diff: "--- a\n+++ b\n",
					operation: undefined,
					sourcePath: undefined,
				},
			],
		});
	});

	it("projects a moved file's op+sourcePath into an explicit move operation", async () => {
		let captured: { details?: unknown } | undefined;
		const runner = makeRunner(event => {
			captured = event as { details?: unknown };
		});
		const wrapped = new HookToolWrapper(
			makeEditTool({
				diff: "--- a\n+++ b\n",
				path: "src/renamed-19273.ts",
				sourcePath: "src/original-19273.ts",
				op: "update",
			}),
			runner,
		);

		await wrapped.execute("call-move", { path: "src/renamed-19273.ts" } as never);

		const details = captured?.details as { files: unknown[] } | undefined;
		expect(details?.files).toEqual([
			{
				status: "applied",
				path: "src/renamed-19273.ts",
				diff: "--- a\n+++ b\n",
				operation: "move",
				sourcePath: "src/original-19273.ts",
			},
		]);
	});

	it("projects a multi-file bag's applied/failed/unattempted entries into per-file outcomes", async () => {
		let captured: { details?: unknown } | undefined;
		const runner = makeRunner(event => {
			captured = event as { details?: unknown };
		});
		const wrapped = new HookToolWrapper(
			makeEditTool({
				diff: "combined-diff-58204",
				perFileResults: [
					{ path: "src/ok-58204.ts", diff: "--- ok\n+++ ok\n" },
					{ path: "src/bad-58204.ts", diff: "", isError: true, errorText: "boom-58204" },
				],
				unattemptedPaths: ["src/never-58204.ts"],
			}),
			runner,
		);

		await wrapped.execute("call-multi", { path: "src/ok-58204.ts" } as never);

		expect(captured?.details).toEqual({
			diff: "combined-diff-58204",
			files: [
				{
					status: "applied",
					path: "src/ok-58204.ts",
					diff: "--- ok\n+++ ok\n",
					operation: undefined,
					sourcePath: undefined,
				},
				{ status: "failed", path: "src/bad-58204.ts", message: "boom-58204" },
				{ status: "skipped", path: "src/never-58204.ts" },
			],
		});
	});

	it("projects a thrown/malformed edit result to undefined details rather than echoing the raw bag", async () => {
		let captured: { details?: unknown } | undefined;
		const runner = makeRunner(event => {
			captured = event as { details?: unknown };
		});
		// The agent loop's shape for a built-in edit call that threw: no bag was
		// ever built, so there is no per-file outcome to derive.
		const wrapped = new HookToolWrapper(makeEditTool({}), runner);

		await wrapped.execute("call-thrown", { path: "src/thrown-77120.ts" } as never);

		expect(captured?.details).toBeUndefined();
	});

	it("does not project a non-edit tool's details", async () => {
		let captured: { details?: unknown } | undefined;
		const runner = makeRunner(event => {
			captured = event as { details?: unknown };
		});
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Test bash tool",
			parameters: Type.Object({ command: Type.String() }),
			strict: true,
			execute: async () => ({ content: [{ type: "text", text: "ran" }], details: { exitCode: 0 } }),
		} as AgentTool;
		const wrapped = new HookToolWrapper(bashTool, runner);

		await wrapped.execute("call-bash", { command: "echo hi" } as never);

		expect(captured?.details).toEqual({ exitCode: 0 });
	});
});
