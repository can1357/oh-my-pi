import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolCallPresentation, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import {
	executionToolArguments,
	publicToolArguments,
	streamId,
	ToolPresentationStream,
} from "@oh-my-pi/pi-agent-core/presentation";
import type { PtyRunResult, PtyStartOptions } from "@oh-my-pi/pi-natives";
import type { SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import { Terminal as XtermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { AsyncJobManager } from "../src/async/job-manager";
import { Settings } from "../src/config/settings";
import { checkedNotificationPayload, encodeToolFrames } from "../src/modes/acp/view/encoder";
import { negotiateTerminalMetaCap } from "../src/modes/acp/view/frames";
import type { AcpRenderContext, DeliveryReceipt } from "../src/modes/acp/view/reducer";
import { INITIAL_ACP_TOOL_VIEW, reduceAcpToolView } from "../src/modes/acp/view/reducer";
import { getThemeByName } from "../src/modes/theme/theme";
import { deobfuscateToolArguments } from "../src/secrets/message-transform";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import type { ClientBridge, ClientBridgeTerminalHandle } from "../src/session/client-bridge";
import { OutputSink } from "../src/session/streaming-output";
import type { ToolSession } from "../src/tools";
import { BashTool, type BashToolDetails, bashOutcome } from "../src/tools/bash";
import type {
	InteractivePtyRunnerDependencies,
	InteractivePtyUi,
	InteractivePtyUiFactory,
} from "../src/tools/bash-interactive";
import * as bashInteractive from "../src/tools/bash-interactive";
import { driveAcpToolView } from "./helpers/acp-tool-view-driver";

/**
 * The phase-1 bash slice, end to end on local producer-owned routes: **local
 * non-PTY bash rendered through a display-only meta terminal** (`pty: false`,
 * `terminalMetaCapable: true`, `realTerminalCapable: false`, no
 * `ClientBridge.createTerminal`).
 *
 * The property under test is that this route needs no snapshot-vs-delivered
 * overlap scan and no re-render classifier: the producer declares offsets,
 * the reducer asserts them, and the wire receives each byte exactly once.
 */

const cleanupRoots: string[] = [];

beforeEach(() => {
	// The real foreground executor asks Settings for its shell/output policy. Keep
	// that path deterministic without initializing the process-global settings
	// singleton (the PTY runner itself receives all runtime inputs from its fake).
	vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated());
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

function makeSession(
	overrides: {
		readonly asyncEnabled?: boolean;
		readonly asyncJobManager?: AsyncJobManager;
		readonly agentId?: string;
		readonly autoBackground?: boolean;
		readonly autoBackgroundThresholdMs?: number;
		readonly bridge?: ClientBridge;
		readonly cwd?: string;
	} = {},
): ToolSession {
	const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-presentation-"));
	cleanupRoots.push(artifactDir);
	let nextArtifactId = 0;
	return {
		cwd: overrides.cwd ?? "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return overrides.asyncEnabled ?? false;
				if (key === "bash.autoBackground.enabled") return overrides.autoBackground ?? false;
				if (key === "bash.autoBackground.thresholdMs") return overrides.autoBackgroundThresholdMs ?? 60_000;
				if (key === "bashInterceptor.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules: () => [],
			getShellConfig: () => Settings.isolated().getShellConfig(),
		},
		getClientBridge: () => overrides.bridge,
		getAgentId: () => overrides.agentId,
		asyncJobManager: overrides.asyncJobManager,
		allocateOutputArtifact: async () => {
			const id = String(nextArtifactId++);
			return { path: path.join(artifactDir, `${id}.txt`), id };
		},
		saveArtifact: async (text: string) => {
			const id = String(nextArtifactId++);
			fs.writeFileSync(path.join(artifactDir, `${id}.txt`), text);
			return id;
		},
	} as unknown as ToolSession;
}

interface RecordedBashRun {
	readonly events: readonly ToolPresentationEvent[];
	readonly result: AgentToolResult<BashToolDetails>;
	readonly updates: readonly SessionUpdate[];
	readonly receipts: readonly DeliveryReceipt[];
	readonly legacyUpdates: number;
}

interface PtyUiHarness {
	readonly ui: InteractivePtyUi;
	disposed(): boolean;
}

interface PtyRunnerHarness extends PtyUiHarness {
	readonly startOptions: readonly PtyStartOptions[];
	killCalls(): number;
}

async function createPtyUiHarness(): Promise<PtyUiHarness> {
	const theme = await getThemeByName("dark");
	if (theme === undefined) throw new Error("expected built-in dark theme");
	let didDispose = false;
	const ui: InteractivePtyUi = {
		async custom<T>(factory: InteractivePtyUiFactory<T>): Promise<T> {
			const completion = Promise.withResolvers<T>();
			const component = await factory(
				{ terminal: { columns: 120, rows: 40 }, requestRender: () => {} },
				theme,
				{},
				(result: T) => completion.resolve(result),
			);
			if (component.dispose === undefined) throw new Error("expected PTY overlay to expose dispose");
			try {
				return await completion.promise;
			} finally {
				component.dispose();
				didDispose = true;
			}
		},
	};
	return { ui, disposed: () => didDispose };
}

async function installPtyRunnerFake(chunks: readonly string[], outcome: PtyRunResult): Promise<PtyRunnerHarness> {
	const ptyUi = await createPtyUiHarness();
	const startOptions: PtyStartOptions[] = [];
	let killCalls = 0;
	const dependencies = {
		async loadRuntimeSettings() {
			return { shell: "/bin/sh", headBytes: 50_000, maxColumns: 2_000 };
		},
		async loadTerminal() {
			return XtermTerminal;
		},
		createSession() {
			return {
				async start(options, onChunk) {
					startOptions.push(options);
					for (const chunk of chunks) onChunk?.(null, chunk);
					return outcome;
				},
				write() {},
				resize() {},
				kill() {
					killCalls++;
				},
			};
		},
	} satisfies InteractivePtyRunnerDependencies;
	const runWithFakeDependencies = bashInteractive.runInteractiveBashPty;
	vi.spyOn(bashInteractive, "runInteractiveBashPty").mockImplementation((ui, options) =>
		runWithFakeDependencies(ui, options, dependencies),
	);
	return { ...ptyUi, startOptions, killCalls: () => killCalls };
}

function metaOnlyContext(): AcpRenderContext {
	const cap = negotiateTerminalMetaCap(true);
	if (!cap) throw new Error("expected a capability witness");
	return { phase: "live", terminal: { kind: "meta_only", cap }, cwd: "/tmp", fence: true };
}

function realTerminalContext(): AcpRenderContext {
	const metaCap = negotiateTerminalMetaCap(true);
	if (!metaCap) throw new Error("expected a capability witness");
	return { phase: "live", terminal: { kind: "real", metaCap }, cwd: "/tmp", fence: true };
}

/**
 * Run one bash call the way the dispatcher does on the presentation arm: a scoped
 * producer on `ctx.toolCall.progress`, **no** `onUpdate`, a loop-owned `started`
 * before and a loop-owned `freeze()` + `settled` after.
 */
async function runSpike(
	tool: BashTool,
	args: { readonly command: string; readonly timeout?: number; readonly pty?: boolean; readonly async?: boolean },
	options: {
		readonly renderContext?: AcpRenderContext;
		readonly signal?: AbortSignal;
		readonly steeringSignal?: AbortSignal;
		readonly ptyUi?: PtyUiHarness;
		readonly onPresentationEvent?: (event: ToolPresentationEvent) => void;
	} = {},
): Promise<RecordedBashRun> {
	const toolCallId = "bash-call";
	const events: ToolPresentationEvent[] = [];
	const emitPresentation = (event: ToolPresentationEvent): void => {
		events.push(event);
		options.onPresentationEvent?.(event);
	};
	const producer = new ToolPresentationStream(streamId(toolCallId), emitPresentation);
	const localContext: AgentToolContext | undefined =
		options.ptyUi === undefined ? undefined : ({ hasUI: true, ui: options.ptyUi.ui } as AgentToolContext);

	const selection = tool.presentation.selects.call(tool, executionToolArguments(args), localContext);
	expect(selection).not.toBe(false);
	const routing = typeof selection === "object" ? selection.routing : undefined;
	emitPresentation({
		type: "started",
		call: tool.presentation.start.call(tool, toolCallId, publicToolArguments(args), routing),
	});

	let result: AgentToolResult<BashToolDetails>;
	let thrown: unknown;
	let legacyUpdates = 0;
	try {
		result = await tool.execute(
			toolCallId,
			args as never,
			options.signal,
			() => {
				legacyUpdates++;
			},
			{
				...localContext,
				toolCall: {
					batchId: "b",
					index: 0,
					total: 1,
					toolCalls: [{ id: toolCallId, name: "bash" }],
					...(options.steeringSignal === undefined ? {} : { steeringSignal: options.steeringSignal }),
					progress: { kind: "presentation_events", presentation: producer },
				},
			} as unknown as AgentToolContext,
		);
	} catch (error) {
		thrown = error;
		result = { content: [], details: {} };
	}
	// The barrier the agent loop runs in `finally`, on every settlement path.
	await producer.freeze();
	const outcome =
		thrown === undefined
			? bashOutcome(result)
			: ({
					kind: "failed",
					failure: { reason: "thrown", message: thrown instanceof Error ? thrown.message : String(thrown) },
				} as const);
	emitPresentation({ type: "settled", outcome });
	producer.runAfterSettlementCallbacks();

	const run = driveAcpToolView(events, options.renderContext ?? metaOnlyContext());
	// The fact-audience delivery ledger must agree with every receipt the
	// reducer itself issued — any mismatch means a consumer received an
	// update the reducer never accounted for, or vice versa.
	expect(run.deliveryViolations).toEqual([]);
	return { events, result, updates: run.updates, receipts: run.receipts, legacyUpdates };
}

function deliveredBytes(updates: readonly SessionUpdate[]): string {
	let text = "";
	for (const update of updates) {
		const meta = (update as { _meta?: { terminal_output?: { data?: unknown } } })._meta;
		if (typeof meta?.terminal_output?.data === "string") text += meta.terminal_output.data;
	}
	return text;
}

function appendEvents(
	events: readonly ToolPresentationEvent[],
): Extract<ToolPresentationEvent, { type: "terminal_append" }>[] {
	return events.filter(
		(event): event is Extract<ToolPresentationEvent, { type: "terminal_append" }> => event.type === "terminal_append",
	);
}

describe("bash presentation protocol — route selection", () => {
	it("selects local foreground, local PTY, and explicit async-job routes", async () => {
		const tool = new BashTool(makeSession());
		expect(tool.presentation.selects.call(tool, executionToolArguments({ command: "echo hi" }), undefined)).toBe(
			true,
		);
		// PTY is a local, exclusive route. It receives a producer only when the
		// interactive UI is actually available; this context is the one the dispatcher
		// gives `selects` and later `execute`.
		const pty = await createPtyUiHarness();
		const ptyContext = { hasUI: true, ui: pty.ui } as AgentToolContext;
		expect(
			tool.presentation.selects.call(tool, executionToolArguments({ command: "echo hi", pty: true }), ptyContext),
		).toBe(true);
		expect(
			tool.presentation.selects.call(tool, executionToolArguments({ command: "echo hi", async: true }), ptyContext),
		).toBe(true);
	});

	it("claims a pty request that this environment cannot honour", () => {
		// With no interactive UI the PTY route is unavailable and `execute` runs the
		// local foreground executor anyway (it appends the "pty requested but
		// unavailable" notice). Route and protocol come from one function, so this call is
		// migrated rather than being stranded on legacy by a second, coarser predicate.
		const tool = new BashTool(makeSession());
		expect(
			tool.presentation.selects.call(tool, executionToolArguments({ command: "echo hi", pty: true }), undefined),
		).toBe(true);
	});

	it("selects the presentation protocol for explicit async jobs", () => {
		const tool = new BashTool(makeSession({ asyncEnabled: true }));
		expect(
			tool.presentation.selects.call(tool, executionToolArguments({ command: "echo hi", async: true }), undefined),
		).toBe(true);
	});

	it("selects the presentation protocol when auto-background could take the call", () => {
		const tool = new BashTool(
			Object.assign(makeSession({ autoBackground: true }), {
				asyncJobManager: { atCapacity: false },
			}) as ToolSession,
		);
		expect(tool.presentation.selects.call(tool, executionToolArguments({ command: "echo hi" }), undefined)).toBe(
			true,
		);
	});

	it("selects the typed route when the client owns a real terminal", () => {
		const session = makeSession();
		const tool = new BashTool(
			Object.assign(session, {
				getClientBridge: () => ({ capabilities: { terminal: true }, createTerminal: () => undefined }),
			}) as ToolSession,
		);
		expect(tool.presentation.selects.call(tool, executionToolArguments({ command: "echo hi" }), undefined)).toEqual({
			kind: "presentation_events",
			routing: "client_terminal",
		});
	});

	it("carries only the transformed route witness into the public descriptor when pty flips", () => {
		const session = makeSession();
		const tool = new BashTool(
			Object.assign(session, {
				getClientBridge: () => ({ capabilities: { terminal: true }, createTerminal: () => undefined }),
			}) as ToolSession,
		);
		const descriptor = (
			toolCallId: string,
			publicArgs: { command: string; pty: boolean },
			executionArgs: { command: string; pty: boolean },
		): ToolCallPresentation => {
			const selection = tool.presentation.selects.call(tool, executionToolArguments(executionArgs), undefined);
			if (selection === false) throw new Error("expected a migrated execution route");
			return tool.presentation.start.call(
				tool,
				toolCallId,
				publicToolArguments(publicArgs),
				typeof selection === "object" ? selection.routing : undefined,
			);
		};

		// The model asked for PTY, but the host transform chose a client terminal.
		const clientTerminal = descriptor(
			"flip-to-client",
			{ command: "echo hi", pty: true },
			{ command: "echo hi", pty: false },
		);
		expect(clientTerminal.awaitsLiveTerminal).toBe(true);

		// The inverse transform must not inherit the prior call's terminal marker:
		// with no UI, execution falls back to local foreground and keeps the existing
		// display-only meta-terminal literal frame.
		const local = descriptor("flip-to-local", { command: "echo hi", pty: false }, { command: "echo hi", pty: true });
		expect(local.awaitsLiveTerminal).toBeUndefined();
		const step = reduceAcpToolView(INITIAL_ACP_TOOL_VIEW, { type: "started", call: local }, realTerminalContext());
		const [checked] = encodeToolFrames("session-1", step.frames);
		if (checked === undefined) throw new Error("expected local display-only frame");
		expect((checkedNotificationPayload(checked).update as { content?: unknown[] }).content).toEqual([
			{ type: "terminal", terminalId: "flip-to-local" },
		]);
	});

	it("preserves the display-only start frame for non-client-terminal routes on a real-terminal client", () => {
		const tool = new BashTool(makeSession());
		const call = tool.presentation.start.call(tool, "local-call", publicToolArguments({ command: "echo local" }));
		expect(call.awaitsLiveTerminal).toBeUndefined();

		const step = reduceAcpToolView(INITIAL_ACP_TOOL_VIEW, { type: "started", call }, realTerminalContext());
		const [checked] = encodeToolFrames("session-1", step.frames);
		if (checked === undefined) throw new Error("expected a start frame");
		const update = checkedNotificationPayload(checked).update as unknown as {
			content: unknown[];
			_meta: { terminal_info: { terminal_id: string; cwd?: string } };
		};
		expect(update.content).toEqual([{ type: "terminal", terminalId: "local-call" }]);
		expect(update._meta.terminal_info).toEqual({ terminal_id: "local-call", cwd: "/tmp" });
	});
});

describe("bash presentation protocol — byte delivery", () => {
	it("keeps a fast auto-background command on one typed stream and suppresses its manager delivery", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		try {
			const tool = new BashTool(
				makeSession({ autoBackground: true, autoBackgroundThresholdMs: 2_000, asyncJobManager: manager }),
			);
			const run = await runSpike(tool, { command: "printf 'AUTO-FAST-UTF8-hé→😀\\n'" });

			expect(run.legacyUpdates).toBe(0);
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			expect(run.events.at(-1)?.type).toBe("settled");
			expect(
				appendEvents(run.events)
					.map(event => event.data)
					.join(""),
			).toBe("AUTO-FAST-UTF8-hé→😀\n");
			let cursor = 0;
			for (const event of appendEvents(run.events)) {
				expect(Number(event.startByte)).toBe(cursor);
				cursor += Buffer.byteLength(event.data, "utf-8");
			}
			expect(cursor).toBe(Buffer.byteLength("AUTO-FAST-UTF8-hé→😀\n", "utf-8"));
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 100 });
			expect(deliveries).toEqual([]);
		} finally {
			await manager.dispose();
		}
	});

	it("detaches a threshold-backgrounded command before freezing the typed stream and delivers one manager follow-up", async () => {
		const deliveries: string[] = [];
		const chronology: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (_jobId, text) => {
				chronology.push("manager_delivery");
				expect(chronology).toContain("settled");
				deliveries.push(text);
			},
		});
		try {
			const tool = new BashTool(
				makeSession({ autoBackground: true, autoBackgroundThresholdMs: 25, asyncJobManager: manager }),
			);
			const run = await runSpike(
				tool,
				{
					command: "printf 'AUTO-EARLY-0001\\n'; sleep 0.1; printf 'AUTO-LATE-0002\\n'",
				},
				{
					onPresentationEvent: event => chronology.push(event.type),
				},
			);

			expect(run.legacyUpdates).toBe(0);
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			expect(
				appendEvents(run.events)
					.map(event => event.data)
					.join(""),
			).toBe("AUTO-EARLY-0001\n");
			expect(deliveredBytes(run.updates)).toContain("Backgrounded as job bg_1");
			expect(deliveredBytes(run.updates).split("AUTO-EARLY-0001\n")).toHaveLength(2);
			expect(deliveredBytes(run.updates)).not.toContain("AUTO-LATE-0002");
			const start = run.updates[0] as unknown as { content: unknown[] };
			expect(start.content).toEqual([{ type: "terminal", terminalId: "bash-call" }]);
			const final = run.updates.at(-1) as unknown as {
				status: string;
				_meta: { terminal_exit: { exit_code: number | null } };
			};
			expect(final.status).toBe("completed");
			expect(final._meta.terminal_exit.exit_code).toBe(0);
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2_000 });
			expect(chronology.indexOf("manager_delivery")).toBeGreaterThan(chronology.indexOf("settled"));
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toContain("AUTO-EARLY-0001");
			expect(deliveries[0]).toContain("AUTO-LATE-0002");
		} finally {
			await manager.dispose();
		}
	});

	it("emits an immediate typed launch card without a manager snapshot", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		try {
			const tool = new BashTool(
				makeSession({ autoBackground: true, autoBackgroundThresholdMs: 0, asyncJobManager: manager }),
			);
			const run = await runSpike(tool, { command: "sleep 0.05; printf 'AUTO-IMMEDIATE-0001\\n'" });

			expect(run.legacyUpdates).toBe(0);
			expect(appendEvents(run.events)).toEqual([]);
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			expect(deliveredBytes(run.updates)).toContain("Backgrounded as job bg_1");
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2_000 });
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toContain("AUTO-IMMEDIATE-0001");
		} finally {
			await manager.dispose();
		}
	});

	it("hands a steering-backgrounded typed call to one manager delivery after its settled launch card", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		const steering = new AbortController();
		steering.abort();
		try {
			const tool = new BashTool(
				makeSession({ autoBackground: true, autoBackgroundThresholdMs: 60_000, asyncJobManager: manager }),
			);
			const run = await runSpike(
				tool,
				{ command: "printf 'AUTO-STEER-0001\\n'; sleep 0.05; printf 'AUTO-STEER-0002\\n'" },
				{ steeringSignal: steering.signal },
			);

			expect(run.legacyUpdates).toBe(0);
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			expect(deliveredBytes(run.updates)).toContain("Backgrounded early to handle an incoming message");
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2_000 });
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toContain("AUTO-STEER-0001");
			expect(deliveries[0]).toContain("AUTO-STEER-0002");
		} finally {
			await manager.dispose();
		}
	});

	it("settles a cancelled auto-background presentation call once and leaves no manager delivery", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		const controller = new AbortController();
		controller.abort();
		try {
			const tool = new BashTool(
				makeSession({ autoBackground: true, autoBackgroundThresholdMs: 60_000, asyncJobManager: manager }),
			);
			const run = await runSpike(tool, { command: "sleep 5" }, { signal: controller.signal });

			expect(run.legacyUpdates).toBe(0);
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			await manager.waitForAll();
			expect(manager.getJob("bg_1")?.status).toBe("cancelled");
			await manager.drainDeliveries({ timeoutMs: 100 });
			expect(deliveries).toEqual([]);
		} finally {
			await manager.dispose();
		}
	});

	it("flushes two chunks buffered inside one throttle window before auto-background cancellation settles", async () => {
		const deliveries: string[] = [];
		const managerRunFinalization = Promise.withResolvers<void>();
		let managedRunReturned = false;
		let managerFinalized = false;
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		const register = manager.register.bind(manager);
		vi.spyOn(manager, "register").mockImplementation((type, label, run, options) =>
			register(
				type,
				label,
				async context => {
					try {
						return await run(context);
					} finally {
						managedRunReturned = true;
						await managerRunFinalization.promise;
						managerFinalized = true;
					}
				},
				options,
			),
		);
		const controller = new AbortController();
		try {
			const tool = new BashTool(
				makeSession({ autoBackground: true, autoBackgroundThresholdMs: 60_000, asyncJobManager: manager }),
			);
			setTimeout(() => controller.abort(), 75);
			const run = await runSpike(
				tool,
				{
					command: "printf 'AUTO-CANCEL-FLUSH-0001\\n'; sleep 0.02; printf 'AUTO-CANCEL-FLUSH-0002\\n'; sleep 5",
				},
				{ signal: controller.signal },
			);

			const appendIndex = run.events.findIndex(event => event.type === "terminal_append");
			const settledIndex = run.events.findIndex(event => event.type === "settled");
			expect(appendIndex).toBeGreaterThanOrEqual(0);
			expect(appendIndex).toBeLessThan(settledIndex);
			expect(
				appendEvents(run.events)
					.map(event => event.data)
					.join(""),
			).toBe("AUTO-CANCEL-FLUSH-0001\nAUTO-CANCEL-FLUSH-0002\n");
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			// Cancellation marks manager status synchronously, so status is not a
			// completion barrier. The tool must await its private job.completion
			// instead: it may settle the presentation only after the runner returns,
			// while the manager's terminal bookkeeping is still deliberately held.
			expect(managedRunReturned).toBe(true);
			expect(managerFinalized).toBe(false);
			managerRunFinalization.resolve();
			await manager.waitForAll();
			expect(managerFinalized).toBe(true);
			expect(manager.getJob("bg_1")?.status).toBe("cancelled");
			await manager.drainDeliveries({ timeoutMs: 100 });
			expect(deliveries).toEqual([]);
		} finally {
			managerRunFinalization.resolve();
			await manager.dispose();
		}
	}, 20_000);

	it("keeps a timed-out auto-background command out of the settled typed stream and delivers one failed follow-up", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		try {
			const tool = new BashTool(
				makeSession({ autoBackground: true, autoBackgroundThresholdMs: 0, asyncJobManager: manager }),
			);
			const run = await runSpike(tool, { command: "printf 'AUTO-TIMEOUT-0001\\n'; sleep 5", timeout: 1 });

			expect(run.legacyUpdates).toBe(0);
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			expect(appendEvents(run.events)).toEqual([]);
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2_000 });
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toContain("Command timed out");
		} finally {
			await manager.dispose();
		}
	}, 20_000);

	it("settles an explicit async launch card with launch facts only and no process bytes", async () => {
		const manager = new AsyncJobManager({ retentionMs: 0 });
		try {
			const tool = new BashTool(makeSession({ asyncEnabled: true, asyncJobManager: manager }));
			const run = await runSpike(tool, { command: "printf 'ASYNC-BYTES-0001\\n'", async: true });

			expect(run.legacyUpdates).toBe(0);
			expect(run.events[0]?.type).toBe("started");
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			expect(run.events.at(-1)?.type).toBe("settled");
			const notice = "Backgrounded as job bg_1; result will be delivered automatically.";
			// Launch-and-return mirrors auto-background: the launch card carries the
			// background notice fact, never live process bytes — completion reaches
			// the model later as the manager's owner-routed follow-up.
			expect(appendEvents(run.events)).toEqual([]);
			expect(deliveredBytes(run.updates)).not.toContain("ASYNC-BYTES-0001");
			expect(deliveredBytes(run.updates)).toContain(`\n${notice}`);
			expect(run.result.content).toEqual([{ type: "text", text: notice }]);
			await manager.waitForAll();
		} finally {
			await manager.dispose();
		}
	});

	it("resolves execute() while an explicit async job is still running", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		try {
			const tool = new BashTool(makeSession({ asyncEnabled: true, asyncJobManager: manager }));
			const run = await runSpike(tool, { command: "printf 'ASYNC-LIVE-0001\\n'; sleep 1", async: true });

			// execute() returned while the process was still running.
			expect(manager.getJob("bg_1")?.status).toBe("running");
			// The settled launch card shows launch facts, not live bytes.
			expect(appendEvents(run.events)).toEqual([]);
			expect(deliveredBytes(run.updates)).not.toContain("ASYNC-LIVE-0001");
			// The manager's owner-routed completion still delivers exactly once.
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2_000 });
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toContain("ASYNC-LIVE-0001");
		} finally {
			await manager.dispose();
		}
	}, 20_000);

	it("keeps an explicit async job running when the launching call aborts after launch", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const controller = new AbortController();
		try {
			const tool = new BashTool(
				makeSession({ asyncEnabled: true, asyncJobManager: manager, agentId: "async-owner" }),
			);
			// Launch-and-return: execute() settled the launch card before returning,
			// so the abort lands strictly after launch — the manager solely owns
			// execution and the launching call's signal must not cancel the job.
			const run = await runSpike(
				tool,
				{ command: "printf 'ASYNC-CANCEL-0001\\n'; sleep 0.2", async: true },
				{ signal: controller.signal },
			);
			expect(run.legacyUpdates).toBe(0);
			expect(run.events.findIndex(event => event.type === "settled")).toBeGreaterThanOrEqual(0);
			controller.abort();
			// waitForAll resolves only when the job settles on its own; an early
			// return with status "cancelled" would mean the abort leaked into the job.
			await manager.waitForAll();
			expect(manager.getJob("bg_1")?.status).toBe("completed");
		} finally {
			await manager.dispose();
		}
	}, 20_000);

	it("launches an explicit async job even when abort landed during pre-job setup", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const controller = new AbortController();
		const originalStat = fs.promises.stat;
		const statEntered = Promise.withResolvers<void>();
		const releaseStat = Promise.withResolvers<void>();
		let holdFirstStat = true;
		vi.spyOn(fs.promises, "stat").mockImplementation((async (...args: Parameters<typeof fs.promises.stat>) => {
			if (holdFirstStat) {
				holdFirstStat = false;
				statEntered.resolve();
				await releaseStat.promise;
			}
			return originalStat(...args);
		}) as never);
		try {
			const tool = new BashTool(
				makeSession({ asyncEnabled: true, asyncJobManager: manager, agentId: "early-abort-owner" }),
			);
			const runPromise = runSpike(
				tool,
				{ command: "printf 'ASYNC-EARLY-ABORT-0001\\n'; sleep 1", async: true },
				{ signal: controller.signal },
			);

			await statEntered.promise;
			controller.abort();
			releaseStat.resolve();
			const run = await runPromise;

			expect(run.legacyUpdates).toBe(0);
			// Launch-and-return: a pre-latched abort no longer cancels the job; the
			// call still settles as a launch card and the manager owns execution.
			const notice = "Backgrounded as job bg_1; result will be delivered automatically.";
			expect(run.result.content).toEqual([{ type: "text", text: notice }]);
			expect(manager.getJob("bg_1")?.status).toBe("running");
			expect(run.events.some(event => event.type === "fact" && event.fact.kind === "stop_annotation")).toBe(false);
			expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
			expect(run.events.at(-1)?.type).toBe("settled");
			manager.cancel("bg_1", { ownerId: "early-abort-owner" });
			await manager.waitForAll();
		} finally {
			releaseStat.resolve();
			await manager.dispose();
		}
	}, 20_000);

	it("streams local PTY bytes through typed events and encodes literal terminal frames", async () => {
		const tool = new BashTool(makeSession());
		const pty = await installPtyRunnerFake(["PTY-UTF8-hé", "→😀\r\n"], {
			exitCode: 0,
			cancelled: false,
			timedOut: false,
		});
		const marker = "PTY-UTF8-hé→😀";
		const run = await runSpike(tool, { command: `printf '${marker}\\n'`, pty: true }, { ptyUi: pty });

		const appends = appendEvents(run.events);
		const produced = appends.map(event => event.data).join("");
		expect(produced).toContain(marker);
		expect(produced).not.toContain("�");
		let cursor = 0;
		for (const event of appends) {
			expect(Number(event.startByte)).toBe(cursor);
			cursor += Buffer.byteLength(event.data, "utf-8");
		}
		// The presentation arm never calls a legacy callback, even when one is supplied
		// as a tripwire by this harness.
		expect(run.legacyUpdates).toBe(0);

		const settledIndex = run.events.findIndex(event => event.type === "settled");
		expect(settledIndex).toBeGreaterThan(0);
		expect(run.events.slice(0, settledIndex).some(event => event.type === "terminal_append")).toBe(true);
		expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);

		// Literal reducer/encoder evidence: a display-only PTY call is announced as a
		// terminal-only tool call, its producer bytes use terminal_output, and settlement
		// carries status with terminal_exit in the same final update.
		const start = run.updates[0] as unknown as {
			content: unknown[];
			_meta: { terminal_info: { terminal_id: string; cwd?: string } };
		};
		expect(start.content).toEqual([{ type: "terminal", terminalId: "bash-call" }]);
		expect(start._meta.terminal_info).toEqual({ terminal_id: "bash-call", cwd: "/tmp" });
		expect(deliveredBytes(run.updates)).toContain(marker);
		const final = run.updates.at(-1) as unknown as {
			status: string;
			_meta: { terminal_exit: { exit_code: number | null } };
		};
		expect(final.status).toBe("completed");
		expect(final._meta.terminal_exit.exit_code).toBe(0);
		expect(pty.disposed()).toBe(true);
		expect(pty.killCalls()).toBe(1);
		expect(pty.startOptions).toHaveLength(1);
		expect(pty.startOptions[0]).toMatchObject({ command: `printf '${marker}\\n'`, timeoutMs: 300_000 });
	});

	it("binds a client-owned terminal through typed events without replaying its bytes through meta", async () => {
		const marker = "CLIENT-OWNED-OUTPUT-0001\\n";
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "client-term-1",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: marker, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const tool = new BashTool(makeSession({ bridge }));

		const run = await runSpike(
			tool,
			{ command: "printf CLIENT-OWNED-OUTPUT-0001" },
			{ renderContext: realTerminalContext() },
		);

		const attached = run.events.findIndex(event => event.type === "live_terminal_attached");
		const settled = run.events.findIndex(event => event.type === "settled");
		const started = run.events[0];
		expect(started?.type === "started" && started.call.awaitsLiveTerminal).toBe(true);
		expect(attached).toBeGreaterThan(0);
		expect(attached).toBeLessThan(settled);
		expect(run.events.some(event => event.type === "terminal_append")).toBe(false);
		expect(run.legacyUpdates).toBe(0);
		expect(run.result.content.find(block => block.type === "text")?.text).toContain(marker.trim());

		// Literal ACP frames: the client terminal is attached in FIFO order after its
		// call announcement, has no display-only terminal_info frame, and gets only
		// synthesized facts/settlement through terminal meta. Its process bytes are
		// rendered by the client-owned terminal itself, never replayed by the agent.
		const terminalUpdate = run.updates.find(update =>
			(update as { content?: unknown[] }).content?.some(
				item =>
					(item as { type?: string; terminalId?: string }).type === "terminal" &&
					(item as { terminalId?: string }).terminalId === handle.terminalId,
			),
		);
		expect((terminalUpdate as { content?: unknown[] } | undefined)?.content).toEqual([
			{ type: "terminal", terminalId: handle.terminalId },
		]);
		expect(run.updates.some(update => (update as { _meta?: { terminal_info?: unknown } })._meta?.terminal_info)).toBe(
			false,
		);
		expect(deliveredBytes(run.updates)).not.toContain(marker);
		const final = run.updates.at(-1) as unknown as {
			status: string;
			_meta: { terminal_exit: { terminal_id: string; exit_code: number | null; signal?: string | null } };
		};
		expect(final.status).toBe("completed");
		expect(final._meta.terminal_exit).toEqual({ terminal_id: handle.terminalId, exit_code: 0, signal: null });
	});

	it("settles a cancelled client terminal once after its binding and typed stop fact", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const controller = new AbortController();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "client-term-cancelled",
			waitForExit: () => pendingExit.promise,
			currentOutput: async () => {
				controller.abort();
				return { output: "CLIENT-CANCELLED-OUTPUT-0001\\n", truncated: false };
			},
			kill: async () => {},
			release: async () => {},
		};
		const tool = new BashTool(
			makeSession({
				bridge: { capabilities: { terminal: true }, createTerminal: async () => handle },
			}),
		);

		const run = await runSpike(
			tool,
			{ command: "sleep 60" },
			{ renderContext: realTerminalContext(), signal: controller.signal },
		);

		expect(run.events.filter(event => event.type === "live_terminal_attached")).toHaveLength(1);
		expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
		expect(run.events.some(event => event.type === "terminal_append")).toBe(false);
		expect(
			run.events.some(
				event =>
					event.type === "fact" &&
					event.fact.kind === "stop_annotation" &&
					event.fact.text === "[Command aborted]",
			),
		).toBe(true);
		const final = run.updates.at(-1) as unknown as {
			status: string;
			_meta: { terminal_exit: { terminal_id: string; exit_code: number | null; signal?: string | null } };
		};
		expect(final.status).toBe("failed");
		expect(final._meta.terminal_exit).toEqual({ terminal_id: handle.terminalId, exit_code: null, signal: null });
	});

	it("delivers every produced byte exactly once with no overlap inference", async () => {
		const tool = new BashTool(makeSession());
		const run = await runSpike(tool, { command: "printf 'alpha\\nbeta\\ngamma\\n'" });

		const produced = appendEvents(run.events)
			.map(event => event.data)
			.join("");
		expect(produced).toBe("alpha\nbeta\ngamma\n");
		// The terminal received the stream plus fact lines; the stream part is exact.
		expect(deliveredBytes(run.updates).startsWith("alpha\nbeta\ngamma\n")).toBe(true);
		// Offsets are contiguous from zero — the property that makes duplication and
		// loss observable even when content repeats.
		let cursor = 0;
		for (const event of appendEvents(run.events)) {
			expect(Number(event.startByte)).toBe(cursor);
			cursor += Buffer.byteLength(event.data, "utf-8");
		}
	});

	it("delivers repeated identical lines once each", async () => {
		const tool = new BashTool(makeSession());
		// The adversarial case for any overlap/watermark scheme.
		const run = await runSpike(tool, { command: "printf 'SAME-LINE-0001\\n%.0s' 1 2 3" });
		const produced = appendEvents(run.events)
			.map(event => event.data)
			.join("");
		expect(produced).toBe("SAME-LINE-0001\nSAME-LINE-0001\nSAME-LINE-0001\n");
		expect(deliveredBytes(run.updates).startsWith(produced)).toBe(true);
	});

	it("counts UTF-8 bytes for multi-byte output", async () => {
		const tool = new BashTool(makeSession());
		const run = await runSpike(tool, { command: "printf 'h\\303\\251llo \\342\\206\\222 \\360\\237\\230\\200\\n'" });
		const appends = appendEvents(run.events);
		const total = appends.reduce((sum, event) => sum + Buffer.byteLength(event.data, "utf-8"), 0);
		expect(Number(appends[0]?.startByte)).toBe(0);
		expect(total).toBe(Buffer.byteLength(appends.map(event => event.data).join(""), "utf-8"));
		expect(deliveredBytes(run.updates)).toContain("héllo → 😀");
	});

	it("emits no terminal_gap when the retained model window rolls", async () => {
		const tool = new BashTool(makeSession());
		// ~110 KB through a 50 KB retained window: the retained record is elided, but
		// the live stream stays continuous. A gap here would be the false-discontinuity
		// bug in new clothes.
		const run = await runSpike(tool, { command: "seq 1 20000" });
		expect(run.events.some(event => event.type === "terminal_gap")).toBe(false);
		expect(run.receipts.some(receipt => receipt.kind === "stream_gap")).toBe(false);

		const produced = appendEvents(run.events)
			.map(event => event.data)
			.join("");
		// The full pre-retention stream reached the wire: first line, a mid-window line
		// the retained body no longer holds, and the last line.
		expect(produced.startsWith("1\n")).toBe(true);
		expect(produced).toContain("\n10000\n");
		expect(produced.endsWith("\n20000\n")).toBe(true);
		// ...while the model-facing retained body is legitimately truncated.
		const modelText = run.result.content.find(block => block.type === "text");
		expect(modelText?.type === "text" && modelText.text.length < produced.length).toBe(true);
		// The loss is declared as a truncation fact plus its artifact pointer, not
		// inferred from a text diff — and those facts are human-audience, so they never
		// appear in the model body either.
		const facts = run.events.flatMap(event => (event.type === "fact" ? [event.fact] : []));
		expect(facts.map(fact => fact.kind)).toContain("truncation");
		expect(facts.map(fact => fact.kind)).toContain("artifact");
		expect(modelText?.type === "text" && modelText.text.includes("[raw output: artifact://")).toBe(false);
	});
});

/**
 * Regression coverage: `transformToolCallArguments` (the host hook `sdk.ts`
 * uses to deobfuscate secret placeholders before execution) runs before
 * route/protocol selection. `adapter.selects`/`execute` must see the
 * transformed command; `adapter.start()` — and therefore `title`/`rawInput`
 * on the literal ACP wire — must never see it. Uses the real
 * {@link SecretObfuscator}, not a hand-rolled placeholder string, so the
 * fixture matches what `sdk.ts` actually produces.
 */
describe("bash presentation protocol — secret redaction at the adapter boundary", () => {
	it("keeps the deobfuscated command out of the started call's title and rawInput", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "s3cr3t-plaintext-token", friendlyName: "test-secret" },
		]);
		expect(obfuscator.hasSecrets()).toBe(true);

		// What the model actually wrote: a placeholder, never the real token.
		const placeholderCommand = obfuscator.obfuscate("echo s3cr3t-plaintext-token");
		expect(placeholderCommand).not.toContain("s3cr3t-plaintext-token");
		const modelArgs = { command: placeholderCommand };

		// What `sdk.ts#transformToolCallArguments` hands to `execute`/`selects`: the
		// placeholder restored to plaintext.
		const executionArgs = deobfuscateToolArguments(obfuscator, modelArgs) as { command: string };
		expect(executionArgs.command).toBe("echo s3cr3t-plaintext-token");

		const tool = new BashTool(makeSession());
		// Route selection judges the execution-time command, matching the agent loop.
		expect(tool.presentation.selects.call(tool, executionToolArguments(executionArgs), undefined)).toBe(true);
		// The descriptor is built from the model's own pre-transform arguments.
		const call = tool.presentation.start.call(tool, "secret-call", publicToolArguments(modelArgs));

		expect(call.title).toBe(placeholderCommand);
		expect(call.rawInput).toEqual({ command: placeholderCommand });

		// Reduce and encode exactly like the ACP layer, then inspect the literal frame.
		const context: AcpRenderContext = { phase: "live", terminal: { kind: "none" }, cwd: "/tmp", fence: true };
		const step = reduceAcpToolView(INITIAL_ACP_TOOL_VIEW, { type: "started", call }, context);
		const [checked] = encodeToolFrames("session-1", step.frames);
		if (checked === undefined) throw new Error("expected an announcement frame");
		const frameJson = JSON.stringify(checkedNotificationPayload(checked));

		expect(frameJson).toContain(placeholderCommand);
		expect(frameJson).not.toContain("s3cr3t-plaintext-token");
	});
});

describe("bash presentation protocol — settlement", () => {
	it("settles a timed-out local PTY once after its output and UI cleanup", async () => {
		const tool = new BashTool(makeSession());
		const pty = await installPtyRunnerFake(["PTY-TIMEOUT-0001\r\n"], {
			exitCode: undefined,
			cancelled: true,
			timedOut: true,
		});
		const run = await runSpike(
			tool,
			{ command: "printf 'PTY-TIMEOUT-0001\\n'; sleep 30", pty: true, timeout: 1 },
			{ ptyUi: pty },
		);

		expect(run.result.isError).toBe(true);
		expect(run.result.details?.timedOut).toBe(true);
		expect(run.legacyUpdates).toBe(0);
		expect(
			appendEvents(run.events)
				.map(event => event.data)
				.join(""),
		).toContain("PTY-TIMEOUT-0001");
		const settledIndex = run.events.findIndex(event => event.type === "settled");
		expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
		expect(run.events.findIndex(event => event.type === "terminal_append")).toBeLessThan(settledIndex);
		const final = run.updates.at(-1) as unknown as {
			status: string;
			_meta: { terminal_exit: { exit_code: number | null } };
		};
		expect(final.status).toBe("failed");
		expect(final._meta.terminal_exit.exit_code).toBeNull();
		expect(pty.disposed()).toBe(true);
		expect(pty.killCalls()).toBe(1);
		expect(pty.startOptions[0]).toMatchObject({ timeoutMs: 1_000 });
	});

	it("settles a cancelled local PTY once after output is frozen and the overlay disposes", async () => {
		const tool = new BashTool(makeSession());
		const controller = new AbortController();
		controller.abort();
		const pty = await installPtyRunnerFake(["PTY-CANCELLED-0001\r\n"], {
			exitCode: undefined,
			cancelled: true,
			timedOut: false,
		});
		const run = await runSpike(
			tool,
			{ command: "printf 'PTY-CANCELLED-0001\\n'; sleep 30", pty: true },
			{ ptyUi: pty, signal: controller.signal },
		);

		expect(run.legacyUpdates).toBe(0);
		expect(
			appendEvents(run.events)
				.map(event => event.data)
				.join(""),
		).toContain("PTY-CANCELLED-0001");
		const appendIndex = run.events.findIndex(event => event.type === "terminal_append");
		const settledIndex = run.events.findIndex(event => event.type === "settled");
		expect(appendIndex).toBeGreaterThanOrEqual(0);
		expect(appendIndex).toBeLessThan(settledIndex);
		expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
		expect(pty.disposed()).toBe(true);
		expect(pty.killCalls()).toBe(1);
		expect(pty.startOptions[0]?.signal).toBe(controller.signal);
	});

	it("settles exactly once with a computed completed status and exit 0", async () => {
		const tool = new BashTool(makeSession());
		const run = await runSpike(tool, { command: "echo hi" });
		expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);

		const last = run.updates.at(-1) as unknown as {
			status: string;
			_meta: { terminal_exit: { exit_code: number | null } };
		};
		expect(last.status).toBe("completed");
		expect(last._meta.terminal_exit.exit_code).toBe(0);
	});

	it("computes failed status and the real exit code for a nonzero exit", async () => {
		const tool = new BashTool(makeSession());
		const run = await runSpike(tool, { command: "sh -c 'echo out; exit 3'" });
		const last = run.updates.at(-1) as unknown as {
			status: string;
			_meta: { terminal_exit: { exit_code: number | null } };
		};
		expect(last.status).toBe("failed");
		expect(last._meta.terminal_exit.exit_code).toBe(3);
		expect(deliveredBytes(run.updates)).toContain("Command exited with code 3");
	});

	it("classifies a timeout as failed with no exit code and a declared reason", async () => {
		const tool = new BashTool(makeSession());
		const run = await runSpike(tool, { command: "printf 'working\\n'; sleep 30", timeout: 1 });
		const outcome = run.events.find(event => event.type === "settled");
		if (outcome?.type !== "settled") throw new Error("expected a settlement");
		expect(outcome.outcome.kind).toBe("failed");

		const last = run.updates.at(-1) as unknown as {
			status: string;
			_meta: { terminal_exit: { exit_code: number | null } };
		};
		expect(last.status).toBe("failed");
		expect(last._meta.terminal_exit.exit_code).toBeNull();
		// The reason a command stopped is not in the process byte stream, so it has to
		// be a declared fact — the class that used to vanish on terminal-rendering
		// clients.
		expect(deliveredBytes(run.updates)).toContain("Command timed out");
	}, 20_000);

	it("delivers a final annotation without resending the stream", async () => {
		const tool = new BashTool(makeSession());
		const run = await runSpike(tool, { command: "printf 'once\\n'" });
		const delivered = deliveredBytes(run.updates);
		// "once\n" appears exactly one time on the whole append-only channel.
		expect(delivered.split("once\n")).toHaveLength(2);
		expect(delivered).toContain("Wall time:");
	});

	it("never emits a legacy snapshot beside the presentation events", async () => {
		const tool = new BashTool(makeSession());
		// The harness supplies an onUpdate tripwire, and producer execution must never
		// call it beside its presentation events.
		const run = await runSpike(tool, { command: "echo hi" });
		expect(run.events.every(event => event.type !== "terminal_gap")).toBe(true);
		expect(run.result.content.some(block => block.type === "text")).toBe(true);
		expect(run.legacyUpdates).toBe(0);
	});
});

describe("bash presentation protocol — freeze barrier", () => {
	it("detach flushes the second of two OutputSink chunks before removing its producer flusher", async () => {
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId("buffered-detach"), event => events.push(event));
		const sink = new OutputSink({ chunkThrottleMs: 10_000, presentation: producer });

		// The first push emits immediately and the second is forced into the same
		// throttle window. `detachPresentation()` must flush that buffered second
		// chunk through the producer before it clears the producer/flusher pair.
		sink.push("BUFFERED-ONE\n");
		sink.push("BUFFERED-TWO\n");
		sink.detachPresentation();
		await producer.freeze();

		expect(
			appendEvents(events)
				.map(event => event.data)
				.join(""),
		).toBe("BUFFERED-ONE\nBUFFERED-TWO\n");
	});

	it("flushes a throttled chunk before settlement", async () => {
		const tool = new BashTool(makeSession());
		// The sink throttles `onChunk`/appends at 50 ms; a command that finishes well
		// inside one window leaves its bytes pending, so only the freeze barrier can
		// get them out. Without the registration this delivers nothing.
		const run = await runSpike(tool, { command: "printf 'FLUSH-ME-0001\\n'" });
		const appends = appendEvents(run.events);
		expect(appends.map(event => event.data).join("")).toBe("FLUSH-ME-0001\n");
		// And the flush landed before the settlement event, not after it.
		const appendIndex = run.events.findIndex(event => event.type === "terminal_append");
		const settledIndex = run.events.findIndex(event => event.type === "settled");
		expect(appendIndex).toBeGreaterThanOrEqual(0);
		expect(appendIndex).toBeLessThan(settledIndex);
	});

	it("flushes buffered bytes when the command is aborted", async () => {
		const tool = new BashTool(makeSession());
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const run = await runSpike(
			tool,
			{ command: "printf 'ABORT-ME-0001\\n'; sleep 5" },
			{ signal: controller.signal },
		);
		// An abort throws out of `execute`, so the only thing that can still deliver
		// the pending chunk is the loop-owned barrier.
		expect(
			appendEvents(run.events)
				.map(event => event.data)
				.join(""),
		).toContain("ABORT-ME-0001");
		expect(run.events.filter(event => event.type === "settled")).toHaveLength(1);
	}, 20_000);
});

describe("bash presentation protocol — multibyte content across real boundaries", () => {
	it("reconstructs multibyte output that crosses executor, read and throttle boundaries", async () => {
		const tool = new BashTool(makeSession());
		// Three ~90 KB batches of a 3-byte character, separated by sleeps longer than the
		// sink's 50 ms throttle window. That forces both kinds of boundary the offsets
		// have to survive: pipe reads split *inside* a character (90 KB per batch is far
		// past a 64 KB read), and the throttle coalesces across batches — so the content
		// cannot possibly stay inside one flush window the way a short fixture does.
		const chunkChar = "\u2192"; // → , 3 UTF-8 bytes
		const perBatch = 30_000;
		const batches = 3;
		const run = await runSpike(tool, {
			command: `for i in 1 2 3; do awk 'BEGIN{for(j=0;j<${perBatch};j++) printf "${chunkChar}"; print ""}'; sleep 0.06; done`,
		});

		const appends = appendEvents(run.events);
		// A single append would mean the test never exercised a boundary at all. A live run
		// produces five here, with byte lengths like 16383/73618/90001/65535/24466 — note
		// 16383 and 65535 are one byte short of a 16 KB/64 KB read, which is the decoder
		// holding back the partial → that straddled the read. That is the boundary this
		// test exists to cross.
		expect(appends.length).toBeGreaterThanOrEqual(3);

		const expected = `${chunkChar.repeat(perBatch)}\n`.repeat(batches);
		const reconstructed = appends.map(event => event.data).join("");
		// No character was mangled at any boundary.
		expect(reconstructed).not.toContain("\ufffd");
		expect(reconstructed).toBe(expected);
		expect(Buffer.byteLength(reconstructed, "utf-8")).toBe(batches * (perBatch * 3 + 1));

		// Byte offsets are absolute, contiguous, and counted in UTF-8 bytes.
		let cursor = 0;
		for (const event of appends) {
			expect(Number(event.startByte)).toBe(cursor);
			cursor += Buffer.byteLength(event.data, "utf-8");
			// No chunk may end inside a surrogate pair, which is what makes the next
			// chunk's offset honest.
			const last = event.data.charCodeAt(event.data.length - 1);
			expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
		}
		expect(cursor).toBe(Buffer.byteLength(expected, "utf-8"));

		// Zero false gaps. The retained body is narrower than the stream — these are
		// single 90 KB lines, so the *column* cap is what cut it — and that loss is
		// declared as a `limit` fact rather than inferred from a text diff. A retention
		// rollover would likewise be a `truncation` fact; neither is ever a live gap.
		expect(run.events.some(event => event.type === "terminal_gap")).toBe(false);
		expect(run.receipts.some(receipt => receipt.kind === "stream_gap")).toBe(false);
		const facts = run.events.flatMap(event => (event.type === "fact" ? [event.fact] : []));
		expect(facts.map(fact => fact.kind)).toContain("limit");

		// The wire received every byte the process produced, in one continuous run.
		expect(deliveredBytes(run.updates).startsWith(expected)).toBe(true);
	}, 30_000);
});
