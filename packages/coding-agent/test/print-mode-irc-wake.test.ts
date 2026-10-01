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
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";

// A bridge extension claims its IRC namespace during extension load, so a peer message can
// reach a `-p` session and wake it into a real turn before print mode dispatches the initial
// prompt. `prompt()` on a busy session throws AgentBusyError; print mode used to let that
// escape before `session.dispose()`, so the process died without `session_shutdown` and the
// bridge's claims leaked. Print mode must queue behind the wake turn and still print the
// prompt's own answer.
describe("print mode with an inbound IRC wake in flight", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let stdoutOutput: string[];
	let releaseWakeTurn: () => void;
	let wakeTurnStarted: Promise<void>;
	let modelCalls: string[];

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

		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);
		const model = createMockModel({
			id: "mock-irc-wake",
			// Call order is fixed by the test: the IRC wake turn is started (and gated) before print
			// mode dispatches, so the first model call is the wake turn and the second is the prompt.
			handler: async () => {
				if (modelCalls.length === 0) {
					modelCalls.push("wake");
					wakeStarted.resolve();
					await wakeGate.promise;
					return { content: ["pong"] };
				}
				modelCalls.push("prompt");
				return { content: ["OK"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "mock-key",
			initialState: { model, systemPrompt: ["Test"], tools },
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
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("queues the initial prompt behind the wake turn, prints the prompt's answer, and disposes", async () => {
		const disposeSpy = vi.spyOn(session, "dispose");
		// Resolves once print mode's prompt() call has returned, i.e. the prompt is queued behind
		// the wake turn (a queued prompt returns immediately; a direct one would have thrown).
		const promptQueued = Promise.withResolvers<void>();
		const realPrompt = session.prompt.bind(session);
		vi.spyOn(session, "prompt").mockImplementation(async (text, options) => {
			const result = await realPrompt(text, options);
			promptQueued.resolve();
			return result;
		});

		// Inbound from a remote peer lands on the idle session: a real turn starts.
		const outcome = await session.deliverIrcMessage({
			id: Snowflake.next(),
			ts: Date.now(),
			from: "@cluster-a/leia",
			to: "Main",
			body: "ping from leia",
		});
		expect(outcome).toBe("woken");
		await wakeTurnStarted;
		expect(session.isStreaming).toBe(true);

		// Print mode dispatches while that turn is streaming. Before the fix: AgentBusyError escaped.
		const run = runPrintMode(session, { mode: "text", initialMessage: "Reply with exactly: OK" });
		await promptQueued.promise;
		expect(session.isStreaming).toBe(true);
		releaseWakeTurn();
		const exitCode = await run;

		expect(exitCode).toBe(0);
		expect(modelCalls).toEqual(["wake", "prompt"]);
		// Text mode prints the final assistant message: the prompt's answer, not the wake turn's.
		expect(stdoutOutput.join("")).toContain("OK");
		expect(stdoutOutput.join("")).not.toContain("pong");
		expect(disposeSpy).toHaveBeenCalled();
	});
});
