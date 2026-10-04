import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

// Ported from #14071: an inbound IRC wake can own the session before print
// dispatches. The printed response must belong to the prompt, not that wake.
describe("print mode with an inbound IRC wake in flight", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let stdoutOutput: string[];
	let releaseWakeTurn: () => void;
	let wakeTurnStarted: Promise<void>;
	let modelCalls: string[];
	let scenario: "wake" | "next-turn" | "tail-wake";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `omp-irc-wake-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		stdoutOutput = [];
		modelCalls = [];
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdoutOutput.push(chunk);
			const last = args[args.length - 1];
			if (typeof last === "function") (last as () => void)();
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const wakeGate = Promise.withResolvers<void>();
		const wakeStarted = Promise.withResolvers<void>();
		releaseWakeTurn = wakeGate.resolve;
		wakeTurnStarted = wakeStarted.promise;

		const model = createMockModel({
			id: "mock-irc-wake",
			handler: async () => {
				if (
					(scenario === "wake" && modelCalls.length === 0) ||
					(scenario === "tail-wake" && modelCalls.length === 1)
				) {
					modelCalls.push("wake");
					wakeStarted.resolve();
					await wakeGate.promise;
					return { content: ["pong"] };
				}
				modelCalls.push("prompt");
				// Todo-error reminders also wait for a next prompt that print mode
				// will never send. They are not undispatched user follow-ups.
				if (scenario === "next-turn") {
					await session.sendCustomMessage(
						{ customType: "print-mode-test-reminder", content: "pending reminder", display: false },
						{ deliverAs: "nextTurn" },
					);
				}
				return { content: ["OK"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "mock-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (m, context, options) => model.stream(m, context, options),
		});
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("mock", "mock-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		releaseWakeTurn();
		await session.abort().catch(() => {});
		await session.dispose().catch(() => {});
		authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("queues behind the wake, cuts off receiving before capture, prints the prompt answer, and disposes", async () => {
		scenario = "wake";
		const disposeSpy = vi.spyOn(session, "dispose");
		const promptQueued = Promise.withResolvers<void>();
		const realPrompt = session.prompt.bind(session);
		vi.spyOn(session, "prompt").mockImplementation(async (text, options) => {
			const result = await realPrompt(text, options);
			promptQueued.resolve();
			return result;
		});
		let receiving = true;

		expect(
			await session.deliverIrcMessage({
				id: Snowflake.next(),
				ts: Date.now(),
				from: "other-01234567",
				to: "Main",
				body: "ping from another process",
				remote: true,
			}),
		).toBe("woken");
		await wakeTurnStarted;
		expect(session.isStreaming).toBe(true);

		const run = runPrintMode(session, {
			mode: "text",
			initialMessage: "Reply with exactly: OK",
			bindMailboxTarget: () => () => {
				expect(session.isStreaming).toBe(false);
				receiving = false;
			},
		});
		await promptQueued.promise;
		expect(session.isStreaming).toBe(true);
		releaseWakeTurn();
		expect(await run).toBe(0);
		expect(receiving).toBe(false);
		expect(modelCalls).toEqual(["wake", "prompt"]);
		expect(stdoutOutput.join("")).toContain("OK");
		expect(stdoutOutput.join("")).not.toContain("pong");
		expect(disposeSpy).toHaveBeenCalled();
	});

	it("keeps the CLI answer when a peer wakes during the prompt's tail window", async () => {
		scenario = "tail-wake";
		const realPrompt = session.prompt.bind(session);
		vi.spyOn(session, "prompt").mockImplementation(async (text, options) => {
			const result = await realPrompt(text, options);
			expect(
				await session.deliverIrcMessage({
					id: Snowflake.next(),
					ts: Date.now(),
					from: "other-01234567",
					to: "Main",
					body: "late peer message",
					remote: true,
				}),
			).toBe("woken");
			await wakeTurnStarted;
			return result;
		});
		const run = runPrintMode(session, { mode: "text", initialMessage: "Reply with exactly: OK" });
		await wakeTurnStarted;
		releaseWakeTurn();
		expect(await run).toBe(0);
		expect(modelCalls).toEqual(["prompt", "wake"]);
		expect(stdoutOutput.join("")).toBe("OK\n");
	});

	it("does not mistake a hidden next-turn message for an undispatched prompt", async () => {
		scenario = "next-turn";
		expect(await runPrintMode(session, { mode: "text", initialMessage: "Reply with exactly: OK" })).toBe(0);
		expect(modelCalls).toEqual(["prompt"]);
		expect(stdoutOutput.join("")).toContain("OK");
	});

	it("disposes and withdraws receiving when dispatch throws, preserving the original error", async () => {
		const failure = new Error("prompt dispatch failed");
		vi.spyOn(session, "prompt").mockRejectedValue(failure);
		const disposeSpy = vi.spyOn(session, "dispose");
		let receiving = true;
		await expect(
			runPrintMode(session, {
				mode: "text",
				initialMessage: "hello",
				bindMailboxTarget: () => () => {
					receiving = false;
				},
			}),
		).rejects.toBe(failure);
		expect(receiving).toBe(false);
		expect(disposeSpy).toHaveBeenCalled();
	});
});
