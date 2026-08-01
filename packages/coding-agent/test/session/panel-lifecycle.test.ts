/**
 * Tests for AgentSession's panel lifecycle: one active run at a time,
 * abort() cancelling and awaiting an active panel before its own cleanup
 * completes, and #panelRun/#panelAbortController always clearing.
 *
 * The panel runtime itself (`../../src/panel/runtime`) is mocked so these
 * tests exercise only the session-owned lifecycle wrapper, never a real
 * model provider.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { PanelRunOptions, PanelRunPlan, PanelRunResult } from "../../src/panel/runtime";

// `runPanelImpl` is swapped per test; the mock factory below delegates to
// whatever implementation the current test installed. Bun keys `mock.module`
// overrides by resolved path, so this single top-level registration covers
// every specifier that resolves to `src/panel/runtime.ts`, including the
// relative one `agent-session.ts` uses internally.
let runPanelImpl: (options: PanelRunOptions) => Promise<PanelRunResult>;
let preparePanelRunImpl: (options: Omit<PanelRunOptions, "onProgress" | "plan" | "signal">) => PanelRunPlan;
mock.module("../../src/panel/runtime", () => ({
	preparePanelRun: (options: Omit<PanelRunOptions, "onProgress" | "plan" | "signal">) => preparePanelRunImpl(options),
	runPanel: (options: PanelRunOptions) => runPanelImpl(options),
}));

// Deliberate dynamic import: `agent-session.ts` imports the real panel
// runtime internally, so the mock above must be installed before that module
// is first loaded, not after the static-import hoist would load it.
const { AgentSession: AgentSessionCtor } = await import("@oh-my-pi/pi-coding-agent/session/agent-session");

function fakePanelResult(): PanelRunResult {
	return {
		role: { roleId: "test", role: { strategy: "independent", members: [] } },
		members: [],
		results: [],
		cancelled: false,
		usage: { tokens: 0, requests: 0, cost: 0 },
		synthesisInput: "synthesis",
	} as unknown as PanelRunResult;
}

describe("AgentSession panel lifecycle", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-panel-lifecycle-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const mockModel = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			initialState: { model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mockModel.stream,
		});
		session = new AgentSessionCtor({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		preparePanelRunImpl = () => {
			throw new Error("preparePanelRun is not used by this test");
		};
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

	it("rejects a second concurrent runPanel call while the first is still active", async () => {
		const { promise: firstSettle, resolve: resolveFirst } = Promise.withResolvers<PanelRunResult>();
		const { promise: firstDispatched, resolve: resolveFirstDispatched } = Promise.withResolvers<void>();
		let dispatchCount = 0;
		runPanelImpl = () => {
			dispatchCount += 1;
			resolveFirstDispatched();
			return firstSettle;
		};

		const firstRun = session.runPanel({ taskMode: "answer", request: "first" });
		expect(session.isPanelRunning).toBe(true);

		await firstDispatched;
		await expect(session.runPanel({ taskMode: "answer", request: "second" })).rejects.toThrow(/already running/i);
		expect(dispatchCount).toBe(1);
		expect(session.isPanelRunning).toBe(true);

		resolveFirst(fakePanelResult());
		await firstRun;
		expect(session.isPanelRunning).toBe(false);

		// The session admits a new run once the prior one has settled and cleared.
		runPanelImpl = () => Promise.resolve(fakePanelResult());
		await expect(session.runPanel({ taskMode: "answer", request: "third" })).resolves.toBeDefined();
	});

	it("dispatches an approved plan through its original ToolSession", async () => {
		const plan = {
			preview: {
				role: { roleId: "prepared", role: { strategy: "independent", members: [] } },
				members: [],
			},
			taskMode: "answer",
			request: "prepared request",
		} as PanelRunPlan;
		let preparedSession: PanelRunOptions["session"] | undefined;
		let dispatched: PanelRunOptions | undefined;
		preparePanelRunImpl = options => {
			preparedSession = options.session;
			return plan;
		};
		runPanelImpl = options => {
			dispatched = options;
			return Promise.resolve(fakePanelResult());
		};

		const approved = session.preparePanelRun({ taskMode: "answer", request: "prepared request" });
		await session.runPanel({ taskMode: "answer", request: "prepared request", plan: approved });

		expect(dispatched?.plan).toBe(plan);
		expect(dispatched?.session).toBe(preparedSession);
	});

	it("abort() signals a dispatched active panel immediately and awaits its settlement before returning", async () => {
		const { promise: panelSettle, resolve: resolvePanel } = Promise.withResolvers<PanelRunResult>();
		const { promise: panelDispatched, resolve: resolvePanelDispatched } = Promise.withResolvers<void>();
		let abortSignalSeen = false;
		runPanelImpl = options => {
			options.signal?.addEventListener("abort", () => {
				abortSignalSeen = true;
			});
			resolvePanelDispatched();
			return panelSettle;
		};

		const runPromise = session.runPanel({ taskMode: "plan", request: "goal" });
		// runPanel invokes its runtime on a microtask. Wait until that dispatch has
		// installed the listener before asserting what abort() exposes synchronously.
		await panelDispatched;
		expect(session.isPanelRunning).toBe(true);

		let abortResolved = false;
		const abortPromise = session.abort().then(() => {
			abortResolved = true;
		});

		// abort() calls abortPanel(), which aborts the controller before its first
		// await. Because the panel runtime has already installed its listener, this
		// synchronous boundary can observe the cancellation without relying on
		// runPanel's deferred dispatch implementation.
		expect(abortSignalSeen).toBe(true);
		expect(abortResolved).toBe(false);
		expect(session.isPanelRunning).toBe(true);

		resolvePanel(fakePanelResult());
		await abortPromise;
		expect(abortResolved).toBe(true);
		expect(session.isPanelRunning).toBe(false);

		await runPromise;
	});

	it("abort() is unaffected when no panel is running", async () => {
		expect(session.isPanelRunning).toBe(false);
		await session.abort();
		expect(session.isPanelRunning).toBe(false);
	});

	it("clears panel state after a successful run", async () => {
		runPanelImpl = () => Promise.resolve(fakePanelResult());
		const result = await session.runPanel({ taskMode: "answer", request: "q" });
		expect(result.synthesisInput).toBe("synthesis");
		expect(session.isPanelRunning).toBe(false);
	});

	it("clears panel state after a failed run and allows a subsequent run", async () => {
		runPanelImpl = () => Promise.reject(new Error("dispatch failed"));
		await expect(session.runPanel({ taskMode: "answer", request: "q" })).rejects.toThrow("dispatch failed");
		expect(session.isPanelRunning).toBe(false);

		runPanelImpl = () => Promise.resolve(fakePanelResult());
		await expect(session.runPanel({ taskMode: "answer", request: "q2" })).resolves.toBeDefined();
		expect(session.isPanelRunning).toBe(false);
	});

	it("forwards a caller-supplied ephemeralRole verbatim to the panel runtime", async () => {
		const ephemeralRole = {
			strategy: "independent" as const,
			members: [{ model: "claude-opus-4-6" }, { model: "gpt-5.4" }],
		};
		let receivedOptions: PanelRunOptions | undefined;
		runPanelImpl = options => {
			receivedOptions = options;
			return Promise.resolve(fakePanelResult());
		};

		await session.runPanel({ taskMode: "answer", request: "one-off lineup", ephemeralRole });

		expect(receivedOptions?.ephemeralRole).toEqual(ephemeralRole);
		expect(receivedOptions?.requestedRole).toBeUndefined();
	});

	it("abortPanel() is a no-op when no panel is running", async () => {
		await expect(session.abortPanel()).resolves.toBeUndefined();
	});
});
