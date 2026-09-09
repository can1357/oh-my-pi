// Tests #emit listener isolation in agent.ts (Agent) and agent-session.ts (AgentSession):
// a throwing or rejecting listener must not prevent later listeners from receiving the event,
// and an async listener's rejection must not become an unhandled rejection.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function makeEvent(): AgentEvent {
	return { type: "tool_execution_start", toolCallId: "probe-1", toolName: "probe", args: {} };
}

describe("#emit listener isolation", () => {
	describe("Agent.#emit (packages/agent/src/agent.ts)", () => {
		it("continues to deliver to later listeners when an earlier listener throws synchronously", () => {
			const agent = new Agent();
			const calls: string[] = [];
			agent.subscribe(() => {
				calls.push("A");
				throw new Error("listener A boom");
			});
			agent.subscribe(() => {
				calls.push("B");
			});

			agent.emitExternalEvent(makeEvent());

			expect(calls).toEqual(["A", "B"]);
		});

		it("does not surface an unhandled rejection when an async listener rejects", async () => {
			const agent = new Agent();
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			const calls: string[] = [];
			try {
				agent.subscribe(async () => {
					calls.push("A");
					throw new Error("async A boom");
				});
				agent.subscribe(() => {
					calls.push("B");
				});

				agent.emitExternalEvent(makeEvent());
				await Bun.sleep(10);

				expect(calls).toEqual(["A", "B"]);
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
	});

	describe("AgentSession.#emit (packages/coding-agent/src/session/agent-session.ts)", () => {
		let session: AgentSession;
		let tempDir: string;
		let authStorage: AuthStorage | undefined;

		beforeEach(async () => {
			tempDir = path.join(os.tmpdir(), `pi-emit-iso-${Snowflake.next()}`);
			fs.mkdirSync(tempDir, { recursive: true });
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Test model not found");
			authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const mock = createMockModel({ responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				initialState: { model, systemPrompt: ["t"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				modelRegistry,
			});
		});

		afterEach(async () => {
			await session.dispose();
			authStorage?.close();
			authStorage = undefined;
			if (fs.existsSync(tempDir)) {
				try {
					removeSyncWithRetries(tempDir);
				} catch {
					// Windows may hold sqlite handles briefly after close; best-effort cleanup.
				}
			}
		});

		it("continues to deliver to later listeners when an earlier listener throws synchronously", () => {
			const calls: string[] = [];
			session.subscribe(() => {
				calls.push("A");
				throw new Error("session listener A boom");
			});
			session.subscribe(() => {
				calls.push("B");
			});

			session.emitNotice("info", "probe", "test");

			expect(calls).toEqual(["A", "B"]);
		});

		it("does not surface an unhandled rejection when an async listener rejects", async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			const calls: string[] = [];
			try {
				session.subscribe(async () => {
					calls.push("A");
					throw new Error("async session A boom");
				});
				session.subscribe(() => {
					calls.push("B");
				});

				session.emitNotice("info", "probe", "test");
				await Bun.sleep(10);

				expect(calls).toEqual(["A", "B"]);
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
	});
});
