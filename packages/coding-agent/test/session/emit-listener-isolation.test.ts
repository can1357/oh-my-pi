// Tests #emit listener isolation in agent.ts (Agent) and agent-session.ts (AgentSession):
// a throwing or rejecting listener must not prevent later listeners from receiving the event,
// and an async listener's rejection must not become an unhandled rejection.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AutoLearnController } from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "../collab/helpers/in-memory-relay";

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
			authStorage.keys.setRuntime("anthropic", "test-key");
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
			vi.restoreAllMocks();
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

		it("delivers mental-model startup warnings past an auto-started collab mirror exactly once", async () => {
			const client = new HindsightApi({ baseUrl: "https://hindsight.invalid" });
			new AutoLearnController({ session, settings: Settings.isolated(), capture: async () => {} });
			vi.spyOn(client, "listMentalModels").mockResolvedValue({
				items: [
					{
						id: "paused-guidance",
						bank_id: "bank",
						name: "Paused guidance",
						content: "Previous guidance",
						last_refresh_failed_at: "2026-10-09T00:00:00Z",
					},
				],
			});
			vi.spyOn(session, "refreshBaseSystemPrompt").mockResolvedValue(undefined);
			const state = new HindsightSessionState({
				sessionId: "startup-warning",
				client,
				bankId: "bank",
				config: {
					...loadHindsightConfig(Settings.isolated()),
					mentalModelsEnabled: true,
					mentalModelAutoSeed: false,
				},
				session,
				banksSet: new Set(["bank"]),
			});
			session.setHindsightSessionState(state);
			state.attachSessionListeners();

			await state.runMentalModelLoad({ bankId: "bank" });

			AgentRegistry.resetGlobalForTests();
			installInMemoryRelay();
			const ctx = {
				session,
				sessionManager: session.sessionManager,
				settings: session.settings,
				statusLine: {
					setCollabStatus: () => {},
					invalidate: () => {},
					getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
				},
				ui: { requestRender: () => {} },
				showStatus: () => {},
			} as unknown as InteractiveModeContext;
			const host = new CollabHost(ctx);
			const originalConnect = CollabSocket.prototype.connect;
			let transport: CollabSocket | undefined;
			vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
				transport = this;
				return originalConnect.call(this);
			});
			try {
				await host.start("ws://localhost:8788");
				if (!transport) throw new Error("host transport missing");
				const send = vi.spyOn(transport, "send").mockImplementation(() => {});
				vi.spyOn(transport, "sendBatch").mockImplementation(() => {});

				const first: string[] = [];
				const unsubscribe = session.subscribe(event => {
					if (event.type === "notice" && event.source === "Hindsight") first.push(event.message);
				});
				expect(first).toHaveLength(1);
				expect(first[0]).toContain("paused-guidance");
				expect(first[0]).toContain("automatic refresh paused");
				expect(send.mock.calls).toEqual([]);
				unsubscribe();
				const later: string[] = [];
				session.subscribe(event => {
					if (event.type === "notice" && event.source === "Hindsight") later.push(event.message);
				});
				expect(later).toEqual([]);

				// A later guest gets a welcome, not a replay of the startup warning.
				transport.onFrame!({ t: "hello", proto: COLLAB_PROTO, name: "late-guest" }, 1);
				expect(send.mock.calls[0]?.[0]).toMatchObject({ t: "welcome" });
				expect(JSON.stringify(send.mock.calls)).not.toContain("paused-guidance");
				session.emitNotice("info", "live-probe", "test");
				expect(JSON.stringify(send.mock.calls)).toContain("live-probe");
				expect(first).toHaveLength(1);
				expect(later).toEqual([]);
			} finally {
				await host.stop("test cleanup");
				uninstallInMemoryRelay();
				AgentRegistry.resetGlobalForTests();
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
