/**
 * Tests for HookToolWrapper - the tool_call `input` override (a non-blocking hook can revise the
 * arguments the tool executes with) and the block path it sits beside.
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

describe("HookToolWrapper tool_call input override", () => {
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

	function makeHook(handler: (event: unknown) => unknown, event = "tool_call"): LoadedHook {
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
		handlers.set(event, [async (event: unknown) => handler(event)]);
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

	function makeRunner(hook: LoadedHook): HookRunner {
		return new HookRunner([hook], sharedTempDir.path(), SessionManager.inMemory(), modelRegistry);
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

	it("ignores the replacement input when the hook also blocks", async () => {
		const executed: unknown[] = [];
		const runner = makeRunner(makeHook(() => ({ block: true, reason: "nope", input: { command: "echo revised" } })));
		const wrapped = new HookToolWrapper(makeRecordingTool(executed), runner);

		await expect(wrapped.execute("call-2", { command: "echo original" } as never)).rejects.toThrow("nope");
		expect(executed).toEqual([]); // tool never executed
	});

	it("executes with the original input when the hook returns no replacement", async () => {
		const executed: unknown[] = [];
		const runner = makeRunner(makeHook(() => undefined));
		const wrapped = new HookToolWrapper(makeRecordingTool(executed), runner);

		await wrapped.execute("call-3", { command: "echo original" } as never);

		expect(executed).toEqual([{ command: "echo original" }]);
	});

	it("keeps a private result replayable when a tool_result hook echoes the public projection", async () => {
		const events: unknown[] = [];
		const runner = makeRunner(
			makeHook(event => {
				events.push(event);
				const { content } = event as { content: unknown[] };
				return { content: [...content, { type: "text", text: "hook annotation" }], details: { patched: true } };
			}, "tool_result"),
		);
		const notes: AgentTool = {
			name: "notes.read_file",
			label: "notes.read_file",
			description: "Private model-only tool",
			parameters: Type.Object({}),
			modelOnly: true,
			execute: async () => ({
				content: [{ type: "encrypted", encryptedContent: "replay-ciphertext" }],
				details: { secret: "private-details" },
			}),
		} as unknown as AgentTool;

		const result = await new HookToolWrapper(notes, runner).execute("call-private", {} as never);

		expect(result.content).toEqual([{ type: "encrypted", encryptedContent: "replay-ciphertext" }]);
		expect(result.details).toEqual({ secret: "private-details" });
		expect(JSON.stringify(events)).not.toContain("replay-ciphertext");
		expect(JSON.stringify(events)).not.toContain("private-details");
		expect(JSON.stringify(events)).toContain("[private model-only result]");
	});
});
