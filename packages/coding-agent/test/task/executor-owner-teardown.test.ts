/**
 * A subagent run settles with the lifecycle owner it started under. A top-level
 * session disposes its lifecycle before it aborts its own running tools, so a
 * run can finish after its owner's teardown began, or after it settled. Such an
 * agent must be released like every agent its owner had already adopted
 * (session disposed, owned resources released, ref unregistered), not kept
 * alive by a lifecycle that will never dispose it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function assistantStop(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A child session whose first turn runs until `finish` settles. */
function childSession(entered: () => void, finish: Promise<void>) {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let disposeCalls = 0;
	const session = {
		...createSessionDefaults(),
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			entered();
			await finish;
			const message = assistantStop("done");
			state.messages.push(message);
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const listener of [...listeners]) listener({ type: "message_end", message } as AgentSessionEvent);
			return true;
		},
		getLastAssistantMessage: () => state.messages.at(-1),
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		dispose: async () => {
			disposeCalls++;
		},
	} as unknown as AgentSession;
	return { session, disposeCalls: () => disposeCalls };
}

describe("runSubprocess whose lifecycle owner tears down first", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it.each(["while the owner's teardown is releasing its other agents", "after the owner's teardown settled"])(
		"releases a kept-alive agent that finishes %s",
		async when => {
			const registry = AgentRegistry.global();
			const owner = AgentLifecycleManager.global();
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const child = childSession(entered.resolve, finish.promise);
			const id = "Late-Child";
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				session: child.session,
				sessionFile: null,
				status: "running",
			});
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
				session: child.session,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} as CreateAgentSessionResult);
			const releaseChild = vi.fn(async () => {});

			const run = runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "do the work",
				index: 0,
				id,
				onRelease: releaseChild,
			});
			await entered.promise;

			if (when === "after the owner's teardown settled") {
				await owner.dispose();
				finish.resolve();
				await run;
				// The SDK's top-level dispose drains its lifecycle again once its own teardown is done.
				await owner.dispose();
			} else {
				// An agent adopted earlier holds the owner's teardown open.
				const siblingReleasing = Promise.withResolvers<void>();
				const holdSibling = Promise.withResolvers<void>();
				registry.register({
					id: "Sibling",
					displayName: "Sibling",
					kind: "sub",
					session: childSession(() => {}, Promise.resolve()).session,
					sessionFile: null,
					status: "idle",
				});
				owner.adopt("Sibling", {
					idleTtlMs: 0,
					onRelease: async () => {
						siblingReleasing.resolve();
						await holdSibling.promise;
					},
				});
				const teardown = owner.dispose();
				await siblingReleasing.promise;
				finish.resolve();
				await run;
				holdSibling.resolve();
				await teardown;
			}

			expect(child.disposeCalls()).toBe(1);
			expect(releaseChild).toHaveBeenCalledTimes(1);
			expect(registry.get(id)).toBeUndefined();
			expect(AgentLifecycleManager.global().has(id)).toBe(false);
		},
	);
});
