import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createSessionTeardown } from "@oh-my-pi/pi-coding-agent/modes/session-teardown";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Regression: an extension timer armed before teardown (ExtensionRunner's `ctx.setTimeout` /
// `ctx.setInterval`, or the runner-less command context's fallback registry) used to survive
// `beginDispose()`. Both registries were cleared only inside `dispose()` — the runner's in
// `emitSessionShutdownEvent`'s `finally`, the fallback's right after that awaited emit — so a timer
// due in the gap a wrapper opens (the draft write in `createSessionTeardown`, the SDK's lifecycle
// teardown) still fired, and its callback could call `pi.sendUserMessage`, which starts a turn and a
// paid provider call from a session that already reports `isDisposed`. Both registries must stop at
// `beginDispose()`, the one synchronous entry every disposal path shares.
describe("AgentSession disposal stops extension timers", () => {
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		const current = session;
		session = undefined;
		vi.useRealTimers();
		if (current) await current.dispose();
		authStorage.close();
		vi.restoreAllMocks();
	});

	/** Observable effects of a timer callback that behaves like a real extension's. */
	interface Observed {
		fired: boolean[];
		providerCalls: boolean[];
		firstCall: PromiseWithResolvers<void>;
	}

	function createSession(withRunner: boolean): Observed {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const observed: Observed = { fired: [], providerCalls: [], firstCall: Promise.withResolvers<void>() };
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: (...args: Parameters<typeof mock.stream>) => {
				observed.providerCalls.push(session?.isDisposed === true);
				observed.firstCall.resolve();
				return mock.stream(...args);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			...(withRunner
				? {
						extensionRunner: new ExtensionRunner(
							[],
							new ExtensionRuntime(),
							sessionManager.getCwd(),
							sessionManager,
							modelRegistry,
						),
					}
				: {}),
			...(withRunner
				? {}
				: {
						customCommands: [
							{
								path: "probe-arm.ts",
								resolvedPath: "probe-arm.ts",
								command: {
									name: "arm",
									description: "arm an extension timer",
									execute: (
										_args: unknown,
										ctx: { setTimeout: (callback: () => void, ms: number) => unknown },
									) => {
										armTimer(ctx, observed);
										return "";
									},
								},
							},
						],
					}),
		} as never);
		return observed;
	}

	/** What a typical extension timer does: wake the session with a message. */
	function armTimer(ctx: { setTimeout: (callback: () => void, ms: number) => unknown }, observed: Observed): void {
		ctx.setTimeout(() => {
			observed.fired.push(session?.isDisposed === true);
			void session?.sendUserMessage("message from extension timer").catch(() => {});
		}, 1000);
	}

	/** Let the prompt flow run to its first provider call without advancing the clock further. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 200; i++) await Promise.resolve();
	}

	describe("runner-owned timers (ctx.setTimeout)", () => {
		it("fires and starts a turn while the session is live", async () => {
			const observed = createSession(true);
			const runner = session?.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			vi.useFakeTimers();
			armTimer(runner.createContext(), observed);
			vi.advanceTimersByTime(1000);
			// The callback has run; the turn it starts is ordinary async work, so hand the clock
			// back and await the provider call the session really makes.
			vi.useRealTimers();
			await observed.firstCall.promise;

			expect(observed.fired).toEqual([false]);
			expect(observed.providerCalls).toEqual([false]);
		});

		it("does not fire after beginDispose()", async () => {
			const observed = createSession(true);
			const runner = session?.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			vi.useFakeTimers();
			armTimer(runner.createContext(), observed);

			session?.beginDispose();
			vi.advanceTimersByTime(5000);
			await settle();

			expect(observed.fired).toEqual([]);
			expect(observed.providerCalls).toEqual([]);
		});

		it("does not fire in the draft-write gap of the interactive teardown", async () => {
			const observed = createSession(true);
			const current = session;
			const runner = current?.extensionRunner;
			if (!current || !runner) throw new Error("expected session with extension runner");
			vi.useFakeTimers();
			armTimer(runner.createContext(), observed);

			const draftHeld = Promise.withResolvers<void>();
			const draftStarted = Promise.withResolvers<void>();
			const close = createSessionTeardown({
				getDraftText: () => "",
				beginDispose: () => current.beginDispose(),
				saveDraft: async () => {
					draftStarted.resolve();
					await draftHeld.promise;
				},
				disposeSession: () => current.dispose(),
			});
			const closing = close();
			await draftStarted.promise;
			expect(current.isDisposed).toBe(true);

			vi.advanceTimersByTime(5000);
			await settle();

			expect(observed.fired).toEqual([]);
			expect(observed.providerCalls).toEqual([]);

			draftHeld.resolve();
			vi.useRealTimers();
			await closing;
		});
	});

	describe("fallback timers of the runner-less command context", () => {
		it("fires and starts a turn while the session is live", async () => {
			const observed = createSession(false);
			await session?.prompt("/arm");
			vi.useFakeTimers();
			vi.advanceTimersByTime(1000);
			vi.useRealTimers();
			await observed.firstCall.promise;

			expect(observed.fired).toEqual([false]);
			expect(observed.providerCalls).toEqual([false]);
		});

		it("does not fire after beginDispose()", async () => {
			const observed = createSession(false);
			await session?.prompt("/arm");
			expect(observed.providerCalls).toEqual([]);
			vi.useFakeTimers();

			session?.beginDispose();
			vi.advanceTimersByTime(5000);
			await settle();

			expect(observed.fired).toEqual([]);
			expect(observed.providerCalls).toEqual([]);
		});
	});
});
