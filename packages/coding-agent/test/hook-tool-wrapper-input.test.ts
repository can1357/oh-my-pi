/**
 * Tests for HookToolWrapper `tool_call` control and passive-context results.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { HookRunner, type LoadedHook } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { HookToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/tool-wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("HookToolWrapper tool_call contract", () => {
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-hook-wrapper-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	function makeHook(handler: (event: unknown) => unknown): LoadedHook {
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
		handlers.set("tool_call", [async (event: unknown) => handler(event)]);
		return {
			path: "test-hook",
			resolvedPath: "/test/test-hook.ts",
			handlers,
			messageRenderers: new Map(),
			commands: new Map(),
			setSendMessageHandler: () => {},
			setAppendEntryHandler: () => {},
		} as unknown as LoadedHook;
	}

	function makeRunner(hooks: LoadedHook | LoadedHook[]): HookRunner {
		return new HookRunner(
			Array.isArray(hooks) ? hooks : [hooks],
			sharedTempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
	}

	// Records the exact params it executed with, so an input override is observable.
	function makeRecordingTool(sink: unknown[]): AgentTool {
		return {
			name: "bash",
			label: "Bash",
			description: "Test bash tool",
			parameters: Type.Object({ command: Type.String() }),
			strict: true,
			execute: async (_id: string, params: unknown) => {
				sink.push(params);
				return { content: [{ type: "text", text: "ran" }] };
			},
		} as AgentTool;
	}

	it("executes the tool with a non-blocking hook's replacement input", async () => {
		const executed: unknown[] = [];
		const runner = makeRunner(makeHook(() => ({ input: { command: "echo revised" } })));
		const wrapped = new HookToolWrapper(makeRecordingTool(executed), runner);

		const result = await wrapped.execute("call-1", { command: "echo original" } as never);

		expect(result.content).toEqual([{ type: "text", text: "ran" }]);
		expect(executed).toEqual([{ command: "echo revised" }]);
	});

	it("aggregates and forwards passive context from every non-blocking hook", async () => {
		const executed: unknown[] = [];
		const runner = makeRunner([
			makeHook(() => ({ additionalContext: "first context" })),
			makeHook(() => ({ additionalContext: "   " })),
			makeHook(() => ({ additionalContext: "second context" })),
		]);
		const wrapped = new HookToolWrapper(makeRecordingTool(executed), runner);
		const delivered: string[] = [];

		await wrapped.execute("call-context", { command: "echo context" } as never, undefined, undefined, {
			addAdditionalContext: (context: string) => {
				delivered.push(context);
			},
		} as unknown as AgentToolContext);

		expect(executed).toEqual([{ command: "echo context" }]);
		expect(delivered).toEqual(["first context\n\nsecond context"]);
	});

	it("discards replacement input and collected context when a later hook blocks", async () => {
		const executed: unknown[] = [];
		const runner = makeRunner([
			makeHook(() => ({ additionalContext: "must not leak" })),
			makeHook(() => ({ block: true, reason: "nope", input: { command: "echo revised" } })),
		]);
		const wrapped = new HookToolWrapper(makeRecordingTool(executed), runner);
		const delivered: string[] = [];

		await expect(
			wrapped.execute("call-2", { command: "echo original" } as never, undefined, undefined, {
				addAdditionalContext: (context: string) => {
					delivered.push(context);
				},
			} as unknown as AgentToolContext),
		).rejects.toThrow("nope");
		expect(executed).toEqual([]);
		expect(delivered).toEqual([]);
	});

	it("executes with the original input when the hook returns no replacement", async () => {
		const executed: unknown[] = [];
		const runner = makeRunner(makeHook(() => undefined));
		const wrapped = new HookToolWrapper(makeRecordingTool(executed), runner);

		await wrapped.execute("call-3", { command: "echo original" } as never);

		expect(executed).toEqual([{ command: "echo original" }]);
	});
});
