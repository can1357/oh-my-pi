/**
 * Model-callable `restart` tool.
 *
 * The tool's contract:
 *   - it is unavailable (createIf → null; execute → error notice) when no
 *     requestRestart binding exists, and constructed when the binding is present;
 *   - it does NOT deadlock: execute() returns an ack immediately and fires
 *     requestRestart() from an UNTRACKED continuation, so the host callback runs
 *     AFTER the tool's turn settles — a tracked #postPromptTask would self-
 *     deadlock and hang the turn (the test fails closed on a timeout);
 *   - it reports the real outcome split on dispose ordering: a pre-dispose
 *     refusal is surfaced to the still-open transcript via queueDeferredMessage
 *     (never swallowed behind the ack), while a post-dispose host-callback throw
 *     on the model path is caught + logged (no awaiting caller; not unhandled,
 *     not silently vanished);
 *   - it requires exec approval, exactly like RefreshTool.
 *
 * The no-deadlock case drives the tool through a real turn on a file-backed
 * session; the outcome-split cases drive execute() directly against a ToolSession
 * stub so the routing (ack vs deferred vs logged) is observed in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type RequestRestartResult } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { requiresApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { RestartTool } from "@oh-my-pi/pi-coding-agent/tools/restart";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

// A minimal ToolSession carrying only what RestartTool reads: requestRestart and
// queueDeferredMessage. Mirrors refresh-tool.test.ts's stub.
function toolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/restart-tool-test",
		hasUI: false,
		...overrides,
	} as unknown as ToolSession;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for condition");
}

describe("RestartTool binding guard", () => {
	// Bullet 1: no binding ⇒ the tool is not offered at all.
	it("createIf returns null when requestRestart is unbound", () => {
		expect(RestartTool.createIf(toolSession())).toBeNull();
	});

	// Bullet 1: a bound binding ⇒ a real tool is created.
	it("createIf returns a tool when requestRestart is bound", () => {
		const tool = RestartTool.createIf(toolSession({ requestRestart: async () => ({ ok: true }) }));
		expect(tool).toBeInstanceOf(RestartTool);
		expect(tool!.name).toBe("restart");
	});

	// Bullet 1: a directly-constructed tool over an unbound session returns the
	// unavailable notice from execute() (isError), never silently succeeds.
	it("execute refuses with a clear message when requestRestart is unbound", async () => {
		const tool = new RestartTool(toolSession());

		const out = await tool.execute("call-1", {});

		expect(out.isError).toBe(true);
		expect(out.content).toEqual([{ type: "text", text: "Restart is unavailable in this session." }]);
		expect(out.details).toEqual({ scheduled: false });
	});
});

describe("RestartTool approval tier", () => {
	// Bullet 4: exec tier — direct property.
	it("is tiered 'exec'", () => {
		const tool = new RestartTool(toolSession({ requestRestart: async () => ({ ok: true }) }));
		expect(tool.approval).toBe("exec");
	});

	// Bullet 4: the tier is load-bearing through the approval gate — a prompt is
	// forced in always-ask/write, auto-allowed only in yolo (mirrors refresh).
	it("forces an approval prompt in always-ask and write, auto-allows only in yolo", () => {
		const tool = new RestartTool(toolSession({ requestRestart: async () => ({ ok: true }) }));
		expect(requiresApproval(tool, {}, "always-ask").required).toBe(true);
		expect(requiresApproval(tool, {}, "write").required).toBe(true);
		expect(requiresApproval(tool, {}, "yolo").required).toBe(false);
	});
});

describe("RestartTool outcome reporting (split on dispose ordering)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Bullet 3 (pre-dispose): a busy refusal is surfaced to the still-open
	// transcript via queueDeferredMessage — not swallowed behind the ack. The ack
	// itself still returns scheduled:true immediately.
	it("surfaces a pre-dispose refusal to the transcript, behind the ack", async () => {
		const queued: CustomMessage[] = [];
		const requestRestart = vi.fn(async (): Promise<RequestRestartResult> => ({ ok: false, reason: "busy" }));
		const tool = new RestartTool(
			toolSession({
				requestRestart,
				queueDeferredMessage: (message: CustomMessage) => void queued.push(message),
			}),
		);

		const out = await tool.execute("call-1", {});
		// The ack returns immediately, before the untracked continuation settles.
		expect(out.details).toEqual({ scheduled: true });
		expect(out.isError).toBeUndefined();

		// The refusal is delivered to the transcript once the continuation runs.
		await waitFor(() => queued.length > 0);
		expect(requestRestart).toHaveBeenCalledTimes(1);
		expect(queued).toHaveLength(1);
		expect(queued[0]!.customType).toBe("restart-refused");
		const text =
			typeof queued[0]!.content === "string"
				? queued[0]!.content
				: queued[0]!.content.map(b => (b.type === "text" ? b.text : "")).join("");
		expect(text).toContain("input is still queued");
	});

	// A pre-dispose rejection is rendered into a `display: true` message, so the
	// raw error must be sanitized first: tabs and newlines break TUI layout and an
	// absolute home path leaks the home directory (AGENTS.md § TUI Sanitization).
	it("sanitizes a pre-dispose failure before displaying it", async () => {
		const queued: CustomMessage[] = [];
		const home = os.homedir();
		const requestRestart = vi.fn(async (): Promise<RequestRestartResult> => {
			throw new Error(
				`flush failed\n\tat ${home}/repo/packages/coding-agent/src/session/agent-session.ts:1\n\tretry`,
			);
		});
		const tool = new RestartTool(
			toolSession({
				requestRestart,
				isDisposed: () => false,
				queueDeferredMessage: (message: CustomMessage) => void queued.push(message),
			}),
		);

		await tool.execute("call-1", {});
		await waitFor(() => queued.length > 0);
		const text =
			typeof queued[0]!.content === "string"
				? queued[0]!.content
				: queued[0]!.content.map(b => (b.type === "text" ? b.text : "")).join("");

		// One line: no raw newline or tab survives into the displayed message.
		expect(text).not.toContain("\n");
		expect(text).not.toContain("\t");
		// The home directory is replaced rather than leaked verbatim.
		expect(text).not.toContain(home);
		expect(text).toContain("~/repo/packages");
		// The underlying failure is still reported, not swallowed by sanitizing.
		expect(text).toContain("flush failed");
	});

	// Bullet 3 (post-dispose): a host-callback throw after dispose has no awaiting
	// caller on the model path — it is caught and logged (recovery via the durable
	// session file), never left unhandled and never silently swallowed.
	it("catches and logs a post-dispose failure rather than leaving it unhandled", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const boom = new Error("re-attach failed after dispose");
		const requestRestart = vi.fn(async (): Promise<RequestRestartResult> => {
			throw boom;
		});
		// If the continuation left the rejection unhandled, this listener would fire.
		let unhandled: unknown;
		const onUnhandled = (reason: unknown) => {
			unhandled = reason;
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const tool = new RestartTool(toolSession({ requestRestart }));

			const out = await tool.execute("call-1", {});
			expect(out.details).toEqual({ scheduled: true });

			await waitFor(() => errorSpy.mock.calls.length > 0);
			// Give any stray unhandled-rejection microtask a chance to surface.
			await Promise.resolve();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(requestRestart).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy.mock.calls[0]![0]).toContain("restart");
		expect(unhandled).toBeUndefined();
	});

	// Fix M1 — the failure log is dispose-agnostic. A rejected requestRestart() can
	// be a recoverable PRE-dispose throw (flush/ensureOnDisk/drainedRefresh failed,
	// session still alive) OR a terminal post-dispose throw; the tool cannot tell
	// them apart and cannot append either way, so it logs one dispose-agnostic
	// message. This drives the pre-dispose branch (session never disposed) and pins
	// that the log does NOT claim teardown that never happened.
	//
	// RED (pre-fix): the string was "restart tool: requestRestart failed after
	// dispose" — it asserted dispose ran, which is false on the recoverable
	// pre-dispose rejection. Post-fix it reads "restart tool: requestRestart failed"
	// with no "after dispose".
	it("logs a dispose-agnostic message when requestRestart rejects", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		// A pre-dispose I/O throw: session still alive, no teardown occurred.
		const requestRestart = vi.fn(async (): Promise<RequestRestartResult> => {
			throw new Error("ensureOnDisk failed: disk full");
		});
		const tool = new RestartTool(toolSession({ requestRestart }));

		const out = await tool.execute("call-1", {});
		expect(out.details).toEqual({ scheduled: true });

		// Await the detached .catch() microtask, as the sibling post-dispose test does.
		await waitFor(() => errorSpy.mock.calls.length > 0);

		expect(requestRestart).toHaveBeenCalledTimes(1);
		const message = errorSpy.mock.calls[0]![0] as string;
		expect(message).toBe("restart tool: requestRestart failed");
		expect(message).not.toContain("after dispose");
	});

	// Pre-dispose throw: flush()/ensureOnDisk() rejected BEFORE dispose began, so
	// the session is still alive and unlatched — the restart did NOT happen. The
	// tool must surface a phase-aware failure to the still-open transcript (a
	// `restart-refused` custom message) so the model learns the recycle was
	// refused, not just log it behind the "restart scheduled" ack.
	//
	// RED (pre-fix): the .catch() only logged; queueDeferredMessage was never
	// called on a rejection, so `queued` stayed empty and this fails.
	it("surfaces a pre-dispose throw to the still-alive transcript", async () => {
		vi.spyOn(logger, "error").mockImplementation(() => {});
		const queued: CustomMessage[] = [];
		const requestRestart = vi.fn(async (): Promise<RequestRestartResult> => {
			throw new Error("ensureOnDisk failed: disk full");
		});
		const tool = new RestartTool(
			toolSession({
				requestRestart,
				// Session is still alive: the throw happened before dispose began.
				isDisposed: () => false,
				queueDeferredMessage: (message: CustomMessage) => void queued.push(message),
			}),
		);

		const out = await tool.execute("call-1", {});
		expect(out.details).toEqual({ scheduled: true });

		await waitFor(() => queued.length > 0);
		expect(requestRestart).toHaveBeenCalledTimes(1);
		expect(queued).toHaveLength(1);
		expect(queued[0]!.customType).toBe("restart-refused");
		const text =
			typeof queued[0]!.content === "string"
				? queued[0]!.content
				: queued[0]!.content.map(b => (b.type === "text" ? b.text : "")).join("");
		expect(text).toContain("still active");
		expect(text).toContain("disk full");
	});

	// Post-dispose throw: the host callback threw AFTER dispose closed the
	// transcript. There is no open transcript to append to, so the tool must NOT
	// queue a deferred message (it would target a dead session) — log-only,
	// recovery via the durable session file.
	it("does not surface a post-dispose throw (transcript already closed)", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const queued: CustomMessage[] = [];
		const requestRestart = vi.fn(async (): Promise<RequestRestartResult> => {
			throw new Error("re-attach failed after dispose");
		});
		const tool = new RestartTool(
			toolSession({
				requestRestart,
				// Session was already disposed when the callback threw.
				isDisposed: () => true,
				queueDeferredMessage: (message: CustomMessage) => void queued.push(message),
			}),
		);

		const out = await tool.execute("call-1", {});
		expect(out.details).toEqual({ scheduled: true });

		await waitFor(() => errorSpy.mock.calls.length > 0);
		expect(requestRestart).toHaveBeenCalledTimes(1);
		expect(queued).toHaveLength(0);
	});
});

describe("RestartTool no-deadlock (model turn)", () => {
	let tempDir: string;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-restart-tool-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	// Bullet 2: the tool call returns while the turn is in flight, and
	// requestRestart() runs AFTER the turn settles. A tracked #postPromptTask
	// version self-deadlocks (requestRestart()'s own waitForIdle()/dispose() await
	// the set the task lives in) and this test times out. The pass proves the
	// continuation is untracked: the turn completes and the callback fires only
	// after the turn is idle.
	it("does not deadlock: the callback fires after the tool's turn settles", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let callbackFired = false;
		let streamingAtCallback: boolean | undefined;

		// Build the tool over a ToolSession stub that delegates to the real session.
		// oxlint-disable-next-line prefer-const -- the stub closure below captures `session`, which is constructed further down
		let session!: AgentSession;
		const restartTool = new RestartTool(
			toolSession({
				requestRestart: () => session.requestRestart(),
			}),
		);

		// Mock model: first turn emits a `restart` tool call, then stops.
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [restartTool], messages: [] },
			convertToLlm,
			streamFn: (_model, _context) => {
				const toolCallTurn = callCount === 0;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: `tc-${callCount}`, name: "restart", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Acknowledged." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				callCount++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});

		const cwd = path.join(tempDir, "cwd");
		const sessionDir = path.join(tempDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(cwd, sessionDir),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([[restartTool.name, restartTool as AgentTool]]),
			onRestartRequested: () => {
				callbackFired = true;
				// At callback time the owning turn has already settled — the untracked
				// continuation's waitForIdle() only resolves once the turn is idle.
				streamingAtCallback = session.isStreaming;
			},
		});
		sessions.push(session);

		// The turn runs the restart tool and settles WITHOUT hanging: if the
		// continuation were a tracked post-prompt task, waitForIdle() would await a
		// set containing the restart task itself and never return (this line times
		// out on regression).
		await session.prompt("please restart");
		await session.waitForIdle();

		// The tool's turn produced a tool result but did NOT restart inline — the
		// callback fires from the untracked continuation after the turn is idle.
		await waitFor(() => callbackFired);
		expect(callbackFired).toBe(true);
		expect(streamingAtCallback).toBe(false);
		// The untracked continuation drove requestRestart() to completion: dispose.
		await waitFor(() => session.isDisposed);
		expect(session.isDisposed).toBe(true);
	});
});
