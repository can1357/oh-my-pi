/**
 * HookRunner `context` event override contract.
 *
 * Regression: `[]` is truthy in JavaScript, so a bare
 * `if (handlerResult.messages)` check treated "the handler returned an empty
 * array" as a valid override and replaced the LLM context with nothing. The
 * provider then rejected the request with "messages is required".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { HookRunner, type LoadedHook } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type TestMessage = { role: "user"; content: string; timestamp: number };

describe("HookRunner context event override", () => {
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-hooks-runner-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	const makeUserMsg = (id: string): TestMessage => ({ role: "user", content: `msg-${id}`, timestamp: Date.now() });

	function makeRunner(results: unknown[]): HookRunner {
		const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
		handlers.set(
			"context",
			results.map(result => async () => result),
		);
		const hook = {
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

	it("keeps the original messages when a handler returns { messages: [] }", async () => {
		const input = [makeUserMsg("u1"), makeUserMsg("u2")];
		const result = await makeRunner([{ messages: [] }]).emitContext(input);
		expect(result).toBe(input);
	});

	it("keeps the original messages when a handler returns { messages: undefined }", async () => {
		const input = [makeUserMsg("u1")];
		const result = await makeRunner([{ messages: undefined }]).emitContext(input);
		expect(result).toBe(input);
	});

	it("keeps the original messages when a handler returns nothing", async () => {
		const input = [makeUserMsg("u1")];
		const result = await makeRunner([undefined]).emitContext(input);
		expect(result).toBe(input);
	});

	it("applies an override when a handler returns a non-empty array", async () => {
		const override = [makeUserMsg("override")];
		const result = await makeRunner([{ messages: override }]).emitContext([makeUserMsg("original")]);
		expect(result).toBe(override);
	});

	it("keeps an earlier override when a later handler returns { messages: [] }", async () => {
		const override = [makeUserMsg("first")];
		const result = await makeRunner([{ messages: override }, { messages: [] }]).emitContext([
			makeUserMsg("original"),
		]);
		expect(result).toBe(override);
	});

	it("reports the error and keeps the messages when a handler throws", async () => {
		const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
		handlers.set("context", [
			async () => {
				throw new Error("boom");
			},
		]);
		const hook = {
			path: "test-hook",
			resolvedPath: "/test/test-hook.ts",
			handlers,
			messageRenderers: new Map(),
			commands: new Map(),
			setSendMessageHandler: () => {},
			setAppendEntryHandler: () => {},
		} as unknown as LoadedHook;
		const runner = new HookRunner([hook], sharedTempDir.path(), SessionManager.inMemory(), modelRegistry);
		const errors: string[] = [];
		runner.onError(error => errors.push(error.error));

		const input = [makeUserMsg("u1")];
		const result = await runner.emitContext(input);

		expect(result).toBe(input);
		expect(errors).toEqual(["boom"]);
	});
});
