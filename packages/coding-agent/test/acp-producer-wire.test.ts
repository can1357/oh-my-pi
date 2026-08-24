import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import { executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonRpcResult } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import {
	mapAgentSessionEventToAcpSessionUpdates,
	wantsMetaTerminal,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import { checkAcpUpdateInvariants } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-update-invariants";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { executeLaunch } from "@oh-my-pi/pi-coding-agent/tools/hub/launch";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { frameTexts, missingFinalBodyLines, producerFacts, producerFinalBodyText } from "./helpers/acp-producer-facts";

/**
 * Crosses the seam every other ACP test skips: the mapper suite fabricates
 * `details` by hand, so nothing there can ask whether a real producer actually
 * populates the field the mapper reads. Several bugs lived in that gap (the
 * spilled-artifact pointer, a failing eval's status and exit code, …), each
 * found by a reviewer rather than by a test.
 *
 * So the coverage here is a matrix, not a case per bug: every ACP-relevant
 * producer outcome runs through its real tool (wrapped exactly as production
 * wraps it, `wrapToolWithMetaNotice`), into the mapper, in both capability
 * modes, and every case gets the same three generic assertions —
 *
 *   1. the frame's `status`/`terminal_exit.exit_code` match the outcome
 *      declared in the table (declared by hand from what the command did, so
 *      the assertion can't restate the mapper's own derivation);
 *   2. no fact the producer recorded structurally (`details.notices`,
 *      `details.notice`, `details.meta`'s rendered notice) is missing from the
 *      frame — the general form of the artifact-pointer loss, which no
 *      per-frame shape check could see;
 *   3. `checkAcpUpdateInvariants` passes, the same chokepoint check
 *      `AcpAgent#sendUpdate` runs.
 *
 * Adding a producer outcome is one table row, so the next producer with a
 * details-only fact is covered before a reviewer has to find it.
 */

const cleanupRoots: string[] = [];

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSpillingSession(): { session: ToolSession; artifactDir: string } {
	const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-producer-wire-"));
	cleanupRoots.push(artifactDir);
	let nextArtifactId = 0;
	const session = {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			// Real resolution: the client-terminal path wraps the command line
			// through it (`wrapShellLineForClientTerminal`).
			getShellConfig: () => Settings.isolated().getShellConfig(),
		},
		getClientBridge: () => undefined,
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
	return { session, artifactDir };
}

/**
 * `seq 1 20000` is deterministic and portable (unlike `python3`/`printf
 * '%0.s'`, which vary or error across shells), and its ~110KB of output
 * comfortably exceeds the default 50KB `tools.artifactSpillThreshold`, so
 * `OutputSink` spills and elides before `BashTool` ever applies its own
 * final-defense inline cap — the common path, not the timeout/edge path.
 */
const SPILLING_COMMAND = "seq 1 20000";

/**
 * 3000 fixed-width 64-byte lines (~192 KB), each carrying its own index so no
 * two windows of the stream are byte-identical (self-similar filler would make
 * the append-only probe below fire on legitimate deliveries). The width matters: bash streams
 * through a `TailBuffer(DEFAULT_MAX_BYTES)` that trims to a line boundary, and
 * 51,200 / 64 is exact, so the last streamed snapshot lands *exactly* on the
 * 50 KB rollover floor every run instead of a line-width-dependent byte or two
 * under it — the difference between reliably reproducing the bug and passing
 * by luck. The final result is then `OutputSink`'s middle-elided head+tail
 * summary, which starts with the run's original head (zero overlap with the
 * streamed tail) and is longer than the watermark once its elision marker and
 * notices are appended.
 */
const WIDE_LINE_COMMAND = `awk 'BEGIN{for(i=0;i<3000;i++) printf "%063d\\n", i}'`;

async function runSpillingBash(): Promise<{
	result: AgentToolResult<BashToolDetails>;
	artifactDir: string;
}> {
	const { session, artifactDir } = makeSpillingSession();
	const tool = wrapToolWithMetaNotice(new BashTool(session));
	const result = await tool.execute("call-spill", { command: SPILLING_COMMAND });
	return { result, artifactDir };
}

/**
 * A real `EvalTool.execute()` whose backend exits nonzero. The backend is
 * stubbed (deterministic, no interpreter dependency) but the result builder
 * under test is the real one — and it is the producer half of this seam: it
 * records the failure in both the authoritative result-level `isError` and
 * the eval-specific `details.isError`/`details.cells[].exitCode` fields.
 */
async function runFailingEval(toolCallId: string): Promise<{
	result: AgentToolResult<EvalToolDetails | undefined>;
	args: Record<string, unknown>;
}> {
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () => ({
		output: "boom\n",
		exitCode: 1,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 1,
		totalBytes: 5,
		outputLines: 1,
		outputBytes: 5,
		displayOutputs: [],
	})) as never);
	const session = {
		cwd: "/tmp/eval-acp-wire",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
	const args = { language: "js", code: "process.exit(1)" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(session));
	const result = (await tool.execute(toolCallId, args)) as AgentToolResult<EvalToolDetails | undefined>;
	return { result, args };
}

describe("ACP producer-to-wire crossing", () => {
	it("a real spilled BashTool result carries an artifact pointer the mapper can recover", async () => {
		const { result } = await runSpillingBash();
		// Precondition: this run must actually cross the spill threshold
		// (`meta.truncation.artifactId`) — otherwise a config change on the
		// test machine would turn this into a vacuous pass instead of a clear
		// failure.
		const meta = (result.details as { meta?: { truncation?: { artifactId?: string } } } | undefined)?.meta;
		expect(meta?.truncation?.artifactId).toBeDefined();
		// And the gap this test exists to catch: bash's own `details.notices`
		// does NOT carry the pointer (that's the whole bug).
		const notices = (result.details as { notices?: string[] } | undefined)?.notices ?? [];
		expect(notices.some(n => n.includes("artifact://"))).toBe(false);
	});

	it("delivers the spilled artifact pointer to a meta-capable ACP client with no invariant violation", async () => {
		const { result } = await runSpillingBash();
		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call-spill",
			toolName: "bash",
			isError: result.isError === true,
			result: { ...result, details: { ...result.details, terminalId: "term-spill-wire" } },
		} as AgentSessionEvent;
		const options = { terminalMetaCapable: true, realTerminalCapable: true };
		const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", options);

		expect(updates).toHaveLength(1);
		const context = { terminalMetaCapable: true };
		for (const update of updates) {
			expect(checkAcpUpdateInvariants(update, context)).toEqual([]);
		}
		const update = updates[0]!.update as { _meta?: { terminal_output?: { data: string } } };
		expect(update._meta?.terminal_output?.data).toContain("artifact://");
	});

	it("delivers the spilled artifact pointer as sibling content to a non-meta-capable ACP client with no invariant violation", async () => {
		const { result } = await runSpillingBash();
		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call-spill",
			toolName: "bash",
			isError: result.isError === true,
			result: { ...result, details: { ...result.details, terminalId: "term-spill-wire-2" } },
		} as AgentSessionEvent;
		const options = { terminalMetaCapable: false };
		const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", options);

		expect(updates).toHaveLength(1);
		const context = { terminalMetaCapable: false };
		for (const update of updates) {
			expect(checkAcpUpdateInvariants(update, context)).toEqual([]);
		}
		const update = updates[0]!.update as {
			content?: { type: string; content?: { type: string; text?: string } }[];
		};
		const textItem = update.content?.find(item => item.type === "content" && item.content?.type === "text");
		expect(textItem?.content?.text).toContain("artifact://");
	});

	it("a real failing EvalTool result records its failure at the result boundary", async () => {
		const { result } = await runFailingEval("call-eval-fail");
		expect(result.isError).toBe(true);
		expect(result.details?.isError).toBe(true);
		expect(result.details?.cells?.[0]?.exitCode).toBe(1);
		expect(result.content.map(c => (c.type === "text" ? c.text : "")).join("\n")).toContain(
			"Command exited with code 1",
		);
	});

	it("reports a real failing eval as failed with its true exit code to a meta-capable ACP client", async () => {
		const { result, args } = await runFailingEval("call-eval-fail-wire");
		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call-eval-fail-wire",
			toolName: "eval",
			args,
			isError: result.isError === true,
			result,
		} as AgentSessionEvent;
		const options = { terminalMetaCapable: true };
		const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", options);

		expect(updates).toHaveLength(1);
		const context = { terminalMetaCapable: true };
		for (const update of updates) {
			expect(checkAcpUpdateInvariants(update, context)).toEqual([]);
		}
		const update = updates[0]!.update as {
			status?: string;
			_meta?: { terminal_exit?: { exit_code?: number | null }; terminal_output?: { data: string } };
		};
		// The terminal body says the command failed, so the terminal's own exit
		// status and the card's status must say so too.
		expect(update._meta?.terminal_output?.data).toContain("Command exited with code 1");
		expect(update._meta?.terminal_exit?.exit_code).toBe(1);
		expect(update.status).toBe("failed");
	});
});

// =============================================================================
// Producer matrix
// =============================================================================

interface ProducerOutcome {
	toolName: string;
	args: Record<string, unknown>;
	result: AgentToolResult<unknown>;
	/**
	 * Every partial result the producer pushed through `onUpdate`, in order.
	 * Replaying these through the mapper before the final result is what makes
	 * the delta/watermark machinery observable: a matrix that only feeds
	 * `tool_execution_end` leaves `getMetaTerminalSent` empty, so every frame
	 * takes the first-send path and no incremental state is ever exercised.
	 */
	updates: AgentToolResult<unknown>[];
}

/**
 * The rendering worlds a producer's result can land in. `meta` is the
 * display-only terminal convention for a client that understands
 * `_meta.terminal_output` but hosts no real terminal (Zed during
 * `session/load` replay, any bash/exec call with `pty: true`, every `eval`) —
 * the only world where the incremental delta/watermark code runs, and the one
 * the matrix originally had no mode for.
 */
const MODES = {
	zed: { terminalMetaCapable: true, realTerminalCapable: true },
	meta: { terminalMetaCapable: true, realTerminalCapable: false },
	"real-terminal-only": { terminalMetaCapable: false, realTerminalCapable: true },
	plain: { terminalMetaCapable: false, realTerminalCapable: false },
} as const;

type ModeName = keyof typeof MODES;

interface ProducerCase {
	name: string;
	run: (toolCallId: string) => Promise<ProducerOutcome>;
	/**
	 * Declared by hand from what the command actually did — never derived from
	 * the result, so the assertion can't restate the mapper's own logic.
	 */
	status: "completed" | "failed";
	/** `undefined` = the frame must not claim an exit code it cannot know. */
	exitCode?: number;
	/** The call created a client-owned terminal the frame must still reference. */
	terminalId?: string;
	/**
	 * How many times the producer's own tail buffer genuinely rolled between
	 * two `onUpdate` snapshots, losing bytes before the mapper ever saw them.
	 * Default 0 — a claim of dropped bytes on a fully-replayed stream is a
	 * fabrication.
	 *
	 * This describes the *producer*, so it is one number for the row. How many
	 * `[terminal output discontinuity]` notices may then appear on the wire is
	 * derived from the mode, not declared: only a display-only meta terminal
	 * has a mapper-owned buffer to lose its place in, so every other mode must
	 * carry exactly zero. Asserted for equality, not as a ceiling — an
	 * allowance that stops being needed is one that will hide the next
	 * regression, and an exact number is what caught this matrix's own stale
	 * `discontinuities: 1` on a row that never rolled at all.
	 *
	 * `{ upTo, because }` is the one escape hatch, for a stream whose snapshot
	 * boundaries the test genuinely cannot pin (pipe read sizes decide whether
	 * a single delta exceeds the producer's window). It must say so out loud;
	 * a row that can be made deterministic must be, not described as if it
	 * couldn't.
	 */
	discontinuities?: number | { upTo: number; because: string };
	/**
	 * Why this producer's own buffering destroys part of its final body before
	 * the mapper ever receives it — a middle-elided summary, a rolled tail
	 * window. Check #6 cannot apply to such a row in any mode: no rendered
	 * channel can deliver bytes nobody handed to the mapper, and the loss is
	 * already acknowledged by the producer's own elision notice (check #2) and
	 * bounded by check #4.
	 *
	 * Separate from `discontinuities`, which counts what the *wire* may claim.
	 * They came apart the moment the wire budget became mode-derived: a row
	 * whose producer really did drop bytes still carries zero claims in a mode
	 * with no mapper-owned buffer, and folding the two together silently
	 * un-exempted exactly those cells.
	 */
	producerDroppedBytes?: string;
	/**
	 * Substrings the *producer* must have recorded structurally, asserted
	 * against `producerFacts(result)` before the mapper runs at all.
	 *
	 * Check #2 ("no declared fact is missing from the frame") is vacuous on an
	 * axis the producer left empty — it compares the frame against nothing and
	 * passes. That is how a bash timeout reached the wire with no statement of
	 * why it stopped: the mirror into `details.notices` was gated on the same
	 * condition that suppresses the text echo, so exactly the path that needed
	 * it skipped it, and every check downstream had nothing to miss. Pinning
	 * the producer half makes the axis non-vacuous for this row specifically,
	 * rather than trusting the matrix-wide guard that only asks whether *some*
	 * row populates *some* axis.
	 */
	expectProducerFacts?: readonly string[];
	/**
	 * How many non-blank lines of the producer's own final body text
	 * (`producerFinalBodyText`) legitimately never reach the client on any
	 * rendered channel. Declared per row, default 0 — a real omission (an
	 * eval-annotation regression) is never an allowance to grant, only a
	 * `plain` mode's own `ACP_TEXT_LIMIT` head truncation on a body that
	 * exceeds it legitimately earns one. Asserted for equality, same reason
	 * as `discontinuities`.
	 */
	allowUndeliveredFinalLines?: number | Partial<Record<ModeName, number>>;
	/**
	 * Modes this row does *not* run in, each with the reason no such
	 * combination exists. Every row runs in all four modes otherwise: a mode
	 * a row silently never entered is a hole nothing reports, which is how
	 * `bash × timeout × meta` — the delta/watermark world, where the densest
	 * findings in this subsystem live — went uncovered while a `zed`-only
	 * timeout row looked like coverage.
	 */
	modeSkips?: Partial<Record<ModeName, string>>;
}

function makeEvalSession(): ToolSession {
	return {
		cwd: "/tmp/eval-acp-wire",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function stubJsBackend(overrides: Record<string, unknown>): void {
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () => ({
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [],
		...overrides,
	})) as never);
}

async function runEval(toolCallId: string, backend: Record<string, unknown>): Promise<ProducerOutcome> {
	stubJsBackend(backend);
	const args = { language: "js", code: "print('x')" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(makeEvalSession()));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "eval", args: { ...args }, result, updates };
}

/**
 * A real `EvalTool.execute()` whose backend streams `chunks` through `onChunk`
 * before returning, so the mapper sees a genuine multi-update sequence and the
 * watermark/delta path is exercised the way a long-running cell exercises it.
 * `total` bytes past eval's own `TailBuffer(DEFAULT_MAX_BYTES * 2)` window make
 * its final result a re-rendered summary rather than a continuation.
 */
async function runStreamingEval(toolCallId: string, lines: number): Promise<ProducerOutcome> {
	const chunks: string[] = [];
	for (let i = 0; i < lines; i++) chunks.push(`${String(i).padStart(63, "0")}\n`);
	const output = chunks.join("");
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: { onChunk?: (chunk: string) => void },
	) => {
		for (const chunk of chunks) options.onChunk?.(chunk);
		return {
			output,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			artifactId: undefined,
			totalLines: lines,
			totalBytes: output.length,
			outputLines: lines,
			outputBytes: output.length,
			displayOutputs: [],
		};
	}) as never);
	const args = { language: "js", code: "for (const l of lines) print(l)" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(makeEvalSession()));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "eval", args: { ...args }, result, updates };
}

/**
 * A real `EvalTool.execute()` through the Python backend's *actual* kernel
 * seam (`executePythonWithKernel`, `executor-base.ts`), not the JS backend
 * stub every other row uses. This is the seam that produces the bug:
 * `OutputSink.dump(notice)` bakes
 * a kernel-timeout/stdin-requested annotation into the returned `output`
 * text but never calls `onChunk` with it, so a matrix confined to the JS
 * backend (which instead calls `push(annotation)` before `dump()`, streaming
 * it live) could never observe the asymmetry. `chunks` stream through the
 * fake kernel's own `onChunk` before it reports the outcome, so the frame
 * sequence has real prior deliveries to diff the final annotation-bearing
 * snapshot against — exactly how the bug manifested (a short annotation
 * prefixed onto already-streamed text, zero overlap, classified as a
 * re-render, and dropped).
 */
async function runEvalPythonKernel(
	toolCallId: string,
	chunks: readonly string[],
	outcome: { cancelled?: boolean; timedOut?: boolean; stdinRequested?: boolean; status?: "ok" | "error" },
): Promise<ProducerOutcome> {
	vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockImplementation((async () => true) as never);
	vi.spyOn(evalIndex.pythonBackend, "execute").mockImplementation((async (
		code: string,
		options: Record<string, unknown>,
	) => {
		const kernel = {
			execute: async (_code: string, opts: { onChunk?: (text: string) => void }) => {
				for (const chunk of chunks) opts.onChunk?.(chunk);
				return {
					status: outcome.status ?? "error",
					cancelled: outcome.cancelled ?? false,
					timedOut: outcome.timedOut ?? false,
					stdinRequested: outcome.stdinRequested ?? false,
					kernelKilled: false,
				};
			},
		};
		return await executePythonWithKernel(kernel as never, code, options as never);
	}) as never);
	const args = { language: "py", code: "print('streamed'); input()" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(makeEvalSession()));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "eval", args: { ...args }, result, updates };
}

/**
 * The abort/cancellation row streamed through a real cancellation (not just a
 * hand-fabricated `cancelled: true` final result): `chunks` deliver through
 * `onChunk` first, so `getMetaTerminalSent` is non-empty when the mapper
 * reaches `tool_execution_end` and the grow/re-render classifier in
 * `buildFinalMetaTerminalDelta` actually runs on a *failure* row, not only on
 * the success-only streaming row above it (`runStreamingEval`). Before this,
 * every streamed row in this matrix ended in success; a matrix that never
 * feeds the delta classifier a failing final snapshot can't catch a class of
 * bug that only shows up there (this exact one: an annotation-prefixed final
 * snapshot after real streamed output).
 */
async function runStreamingEvalAborted(toolCallId: string, chunks: readonly string[]): Promise<ProducerOutcome> {
	const streamed = chunks.join("");
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: { onChunk?: (chunk: string) => void },
	) => {
		for (const chunk of chunks) options.onChunk?.(chunk);
		return {
			output: `${streamed}\nCommand aborted`,
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			artifactId: undefined,
			totalLines: chunks.length,
			totalBytes: streamed.length,
			outputLines: chunks.length,
			outputBytes: streamed.length,
			displayOutputs: [],
		};
	}) as never);
	const args = { language: "js", code: "for (const l of lines) print(l)" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(makeEvalSession()));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "eval", args: { ...args }, result, updates };
}

async function runBash(toolCallId: string, args: Record<string, unknown>): Promise<ProducerOutcome> {
	const { session } = makeSpillingSession();
	const tool = wrapToolWithMetaNotice(new BashTool(session));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args as { command: string }, undefined, update =>
		updates.push(update),
	);
	return { toolName: "bash", args, result, updates };
}

/**
 * A minimal 1x1 PNG, deterministic and tiny — the actual pixel content is
 * irrelevant, only that `EvalTool`'s image path (`resizeImage`/`images.push`)
 * accepts it and the mapper's image-fallback branch fires.
 */
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/**
 * A real `EvalTool.execute()` whose backend produces a display image, so the
 * meta-terminal image fallback (`tool_execution_end`'s `images.length > 0`
 * branch) — previously exercised by no matrix row at all — runs through a
 * real producer instead of only the mapper suite's hand-fabricated fixtures.
 */
async function runEvalImage(toolCallId: string): Promise<ProducerOutcome> {
	stubJsBackend({ output: "", displayOutputs: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }] });
	const args = { language: "js", code: "display(plot)" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(makeEvalSession()));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "eval", args: { ...args }, result, updates };
}

/**
 * A real `EvalTool.execute()` via its `proxyExecutor` constructor option
 * (`eval.ts`'s `#proxyExecutor` branch, an existing production seam for
 * MCP-proxied eval-shaped tools) returning `details.notice` — the only
 * honest way to populate that field through a real producer entrypoint,
 * since `ResolvedBackend.notice` (the ordinary cell-resolution path's
 * writer) has no caller anywhere in `src/`.
 *
 * Deliberately does *not* also return an image: `EvalProxyExecutor`'s own
 * declared return type (`EvalToolResult`) restricts `content` to
 * `{type:"text"}` — no typed production entrypoint can combine an image
 * with a proxy-sourced notice, confirmed by `tsgo` rejecting the combined
 * shape outright. That combination is real and fixed (see the mapper-level
 * regression tests in `acp-event-mapper.test.ts`), just not reachable
 * through any
 * single typed producer this matrix can construct — this row instead
 * covers the `details.notice` axis on its own, honestly.
 */
async function runEvalProxyNotice(toolCallId: string): Promise<ProducerOutcome> {
	const args = { language: "js", code: "someFallbackApi()" } as const;
	const tool = wrapToolWithMetaNotice(
		new EvalTool(null, {
			proxyExecutor: async () => ({
				content: [{ type: "text", text: "ok" }],
				details: { notice: "Fell back to the js backend." },
			}),
		}),
	);
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "eval", args: { ...args }, result, updates };
}

/**
 * A client-owned terminal that never exits, so the tool's own timeout fires
 * while the terminal is live — the one bash path that used to throw instead of
 * returning a result, discarding `details.terminalId` and every notice with it.
 */
const HUNG_TERMINAL_ID = "producer-wire-term-1";

async function runTimingOutBridgeBash(toolCallId: string): Promise<ProducerOutcome> {
	const { session } = makeSpillingSession();
	const bridge = {
		capabilities: { terminal: true },
		createTerminal: async () => ({
			terminalId: HUNG_TERMINAL_ID,
			waitForExit: () => new Promise<never>(() => {}),
			currentOutput: async () => ({ output: "still working\n", truncated: false }),
			kill: async () => {},
			release: async () => {},
		}),
	};
	(session as { getClientBridge: () => unknown }).getClientBridge = () => bridge;
	const args = { command: "sleep 30", timeout: 1 };
	const tool = wrapToolWithMetaNotice(new BashTool(session));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "bash", args, result, updates };
}

/**
 * The same timeout through the *local* executor — no client bridge, so
 * `executeBash` owns the process and `sink.dump("Command timed out after N
 * seconds")` bakes the annotation into `output` without streaming it through
 * `onChunk` (`bash-executor.ts`). This is the row the matrix never had: the
 * bridge row above only ran in modes with a real terminal, so no bash timeout
 * ever reached the display-only meta-terminal path where the delta/watermark
 * classifier decides what a re-rendered final body still owes the client.
 * The command prints first so the
 * watermark is non-empty when the annotation-prefixed final snapshot arrives —
 * an empty watermark takes the first-send path and proves nothing.
 */
async function runTimingOutLocalBash(toolCallId: string): Promise<ProducerOutcome> {
	const { session } = makeSpillingSession();
	const args = { command: "printf 'working\\n'; sleep 30", timeout: 1 };
	const tool = wrapToolWithMetaNotice(new BashTool(session));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "bash", args, result, updates };
}

/**
 * `hub start` against a daemon the broker reports as `failed`. The op records
 * that only in `details.daemon.state`, which the TUI card reads and the ACP
 * mapper cannot — so the producer marks the result-level flag now.
 */
async function runLaunch(op: "start" | "describe", state: string): Promise<ProducerOutcome> {
	const projectDir = process.cwd();
	const daemon = {
		name: "web",
		state,
		pid: 4242,
		exitReason: state === "failed" ? "exited with code 1 during startup" : undefined,
	};
	const rpcResult = (op === "start"
		? { op: "start", daemon, readyTimedOut: false }
		: {
				op: "describe",
				daemon,
				spec: {
					application: "bun",
					args: ["run", "dev"],
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			}) as unknown as DaemonRpcResult;
	vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue({
		projectDir,
		request: async () => rpcResult,
		close() {},
	} as DaemonBrokerClient);
	const args = op === "start" ? { op, name: "web", application: "bun", args: ["run", "dev"] } : { op, name: "web" };
	const result = await executeLaunch({ cwd: projectDir } as ToolSession, args as never);
	return { toolName: "hub", args, result, updates: [] };
}

/** A real multi-file `apply_patch` where the second file does not exist. */
async function runPartiallyFailingEdit(toolCallId: string): Promise<ProducerOutcome> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-producer-wire-edit-"));
	cleanupRoots.push(root);
	fs.writeFileSync(path.join(root, "a.txt"), "one\n");
	const session = {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
	const args = {
		input: [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-one",
			"+two",
			"*** Update File: missing.txt",
			"@@",
			"-nope",
			"+never",
			"*** End Patch",
			"",
		].join("\n"),
	};
	const tool = wrapToolWithMetaNotice(new EditTool(session));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args as never, undefined, update => updates.push(update));
	return { toolName: "edit", args, result, updates };
}

const PRODUCER_CASES: readonly ProducerCase[] = [
	{
		name: "bash, exit 0",
		run: id => runBash(id, { command: "echo hi" }),
		status: "completed",
		exitCode: 0,
	},
	{
		name: "bash, nonzero exit",
		run: id => runBash(id, { command: "sh -c 'echo hi; exit 3'" }),
		status: "failed",
		exitCode: 3,
	},
	{
		name: "bash, output spilled to an artifact",
		run: id => runBash(id, { command: SPILLING_COMMAND }),
		status: "completed",
		exitCode: 0,
		// `seq 1 20000` is ~110 KB of variable-width lines through a 50 KB tail
		// buffer. Whether the mapper ever sees a snapshot gap wider than that
		// window depends on pipe read sizes, so 0 and 1 are both honest for
		// this stream and pinning either one would be a coin flip dressed as an
		// assertion. Two is not: that is the final re-rendered summary being
		// misread as a rollover on top of a genuine one. The deterministic
		// counterpart lives in the fixed-width row below, which pins 1 exactly.
		discontinuities: {
			upTo: 1,
			because: "pipe read sizes decide whether one delta exceeds the 50 KB window; both 0 and 1 are honest here",
		},
		producerDroppedBytes:
			"OutputSink elides the middle of a 110 KB run into a head+tail summary; the elided lines exist only in artifact://<id>",
	},
	{
		name: "bash, middle-elided summary after a rolled tail window",
		run: id => runBash(id, { command: WIDE_LINE_COMMAND }),
		status: "completed",
		exitCode: 0,
		// The producer's own 50 KB window rolls between the two snapshots it
		// emits for a 192 KB run, so one honest discontinuity is expected. The
		// second one the mapper used to add — for the final elided summary,
		// which is a re-render of what already streamed, not a continuation of
		// it — came with a duplicate copy of the whole summary.
		discontinuities: 1,
		producerDroppedBytes:
			"the 50 KB tail window rolls twice across a 192 KB run, so the final summary's middle never reached the mapper",
	},
	{
		name: "bash, timeout with a live client terminal",
		run: runTimingOutBridgeBash,
		status: "failed",
		terminalId: HUNG_TERMINAL_ID,
		// The client's terminal only ever received process bytes; the timeout
		// annotation is not one, so `details.notices` is the only channel that
		// can tell the user why the command stopped.
		expectProducerFacts: ["Command timed out"],
	},
	{
		name: "bash, timeout on the local executor",
		run: runTimingOutLocalBash,
		status: "failed",
		// `sink.dump(notice)` composes this into the body without streaming it,
		// so the structural mirror has to exist independently of the text.
		expectProducerFacts: ["Command timed out"],
	},
	{
		name: "eval, exit 0",
		run: id => runEval(id, { output: "ok\n" }),
		status: "completed",
		exitCode: 0,
	},
	{
		name: "eval, nonzero exit",
		run: id => runEval(id, { output: "boom\n", exitCode: 1 }),
		status: "failed",
		exitCode: 1,
	},
	{
		name: "eval, aborted mid-cell",
		// Streamed through a real cancellation (not a hand-fabricated final
		// result): the aggregate `output` grows past the watermark with
		// "\nCommand aborted" appended, so this row also exercises
		// `buildFinalMetaTerminalDelta`'s grow/re-render classifier on a
		// *failure*, which no row did before this (every other streamed row
		// ends in success).
		run: id => runStreamingEvalAborted(id, ["aborted-cell-line-1\n", "aborted-cell-line-2\n"]),
		status: "failed",
	},
	{
		name: "eval via python kernel, kernel timeout mid-stream",
		// The seam behind this row:
		// `executeWithKernelBase`'s cancelled/timed-out branch calls
		// `sink.dump(annotation)`, which bakes the annotation into `output`
		// without ever streaming it through `onChunk` — unlike the JS backend
		// stub every other eval row here uses, which calls `push()` before
		// `dump()`. Chunks stream first so the annotation-bearing final
		// snapshot has real prior deliveries to diff against.
		run: id =>
			runEvalPythonKernel(id, ["streamed-py-line-1\n", "streamed-py-line-2\n"], {
				cancelled: true,
				timedOut: true,
			}),
		status: "failed",
	},
	{
		name: "eval via python kernel, stdin requested",
		// Same seam, the other `dump(notice)` call site
		// (`executor-base.ts`'s `stdinRequested` branch, `exitCode: 1`).
		run: id => runEvalPythonKernel(id, ["streamed-py-stdin-1\n"], { stdinRequested: true, status: "ok" }),
		status: "failed",
		exitCode: 1,
	},
	{
		name: "eval, streamed past its own tail-buffer window",
		run: id => runStreamingEval(id, 2500),
		status: "completed",
		exitCode: 0,
		// 160 KB through eval's 100 KB window, but the producer emits an
		// `onUpdate` per chunk, so consecutive snapshots always overlap and the
		// mapper never loses its place: zero honest discontinuities. The row
		// declared 1 under a `toBeLessThanOrEqual` budget, so the declaration
		// was never checked against what actually happens — the exact-equality
		// assertion is what surfaced it.
		producerDroppedBytes:
			"160 KB through eval's own TailBuffer(100 KB): the middle of the final summary was evicted before the mapper saw it",
	},
	{
		name: "eval, image display output",
		run: runEvalImage,
		status: "completed",
		exitCode: 0,
	},
	{
		name: "eval via proxyExecutor, details.notice",
		run: runEvalProxyNotice,
		status: "completed",
		exitCode: 0,
	},
	{
		name: "hub start, daemon reported failed",
		run: () => runLaunch("start", "failed"),
		status: "failed",
	},
	{
		name: "hub describe of an already-failed daemon",
		run: () => runLaunch("describe", "failed"),
		status: "completed",
	},
	{
		name: "edit, multi-file patch with one missing file",
		run: runPartiallyFailingEdit,
		status: "failed",
		// The succeeded file's own "Files already applied: a.txt." ack is
		// intentionally suppressed once its diff is already shown below it —
		// stated PR intent ("succeeded files' ack text is no longer repeated
		// below their diffs"), not an omission this check should flag.
		allowUndeliveredFinalLines: 1,
	},
];

/**
 * The cross-product this matrix claims to cover, written down so a hole is a
 * failure instead of an absence nobody can see.
 *
 * Every finding in this review's ACP rounds lived in a cell no row occupied,
 * and the matrix could not say so: rows accumulated one per bug, modes were an
 * opt-in allowlist, and "the matrix covers it" was unfalsifiable. A cell is
 * either the name of a row that exercises it or an explicit `{ none: reason }`
 * saying why no real producer can reach it — and the assertions below reject a
 * cell that names a row which doesn't exist, a row no cell names, and a
 * `none` reason that isn't a reason.
 */
type OutcomeName =
	| "success"
	| "nonzero exit"
	| "timeout"
	| "abort"
	| "artifact spill"
	| "tail-window rollover"
	| "image"
	| "stdin request"
	| "details-only notice"
	| "partial failure"
	| "duplicate per-file notice";

type CoverageCell = string | { none: string };

const COVERAGE: Record<string, Record<OutcomeName, CoverageCell>> = {
	bash: {
		success: "bash, exit 0",
		"nonzero exit": "bash, nonzero exit",
		timeout: "bash, timeout on the local executor",
		abort: {
			none: "an abort throws rather than returning a result (bash.ts's `#throwIfUnfinished`, deliberate: an abort is not a completed command), so there is no producer result to feed the mapper",
		},
		"artifact spill": "bash, output spilled to an artifact",
		"tail-window rollover": "bash, middle-elided summary after a rolled tail window",
		image: { none: "bash returns text only; no code path produces an image result" },
		"stdin request": { none: "bash never asks for stdin; the eval kernels do" },
		"details-only notice": {
			none: "bash always mirrors its notices into `details.notices`; the details-only axis belongs to eval's `details.notice`",
		},
		"partial failure": { none: "a single command either ran or did not; no per-item breakdown exists" },
		"duplicate per-file notice": {
			none: "bash has one details.notices list, not per-path text; there is no second file to collide with",
		},
	},
	"bash (client terminal)": {
		success: {
			none: "a successful bridge command's body streams over the `terminal/output` RPC only; the frame carries the terminal reference, which the timeout row already pins",
		},
		"nonzero exit": { none: "same channel as success, above" },
		timeout: "bash, timeout with a live client terminal",
		abort: { none: "throws, as in the local-executor row above" },
		"artifact spill": { none: "the client owns the buffer; the sink's spill path is the local executor's" },
		"tail-window rollover": { none: "the client owns the buffer, so no mapper-side window rolls" },
		image: { none: "bash returns text only" },
		"stdin request": { none: "bash never asks for stdin" },
		"details-only notice": { none: "as in the local-executor row above" },
		"partial failure": { none: "as in the local-executor row above" },
		"duplicate per-file notice": { none: "as in the local-executor row above" },
	},
	eval: {
		success: "eval, exit 0",
		"nonzero exit": "eval, nonzero exit",
		timeout: "eval via python kernel, kernel timeout mid-stream",
		abort: "eval, aborted mid-cell",
		"artifact spill": {
			none: "eval bounds its own output with a `TailBuffer` instead of the sink's artifact spill; the rollover row covers the loss it can suffer",
		},
		"tail-window rollover": "eval, streamed past its own tail-buffer window",
		image: "eval, image display output",
		"stdin request": "eval via python kernel, stdin requested",
		"details-only notice": "eval via proxyExecutor, details.notice",
		"partial failure": {
			none: "`EvalTool.execute()`'s public entrypoint always builds a single cell (`evalCellCommonFields`), so no cell can fail beside a sibling that succeeded",
		},
		"duplicate per-file notice": {
			none: "eval has no per-file breakdown at all (see the partial-failure cell above), so no two-file notice collision axis exists",
		},
	},
	hub: {
		success: "hub describe of an already-failed daemon",
		"nonzero exit": "hub start, daemon reported failed",
		timeout: { none: "a readiness timeout is reported as a failed daemon state, which the nonzero-exit row covers" },
		abort: { none: "the op is an RPC round trip with nothing to abort mid-stream" },
		"artifact spill": { none: "hub op results are small structured payloads, never streamed output" },
		"tail-window rollover": { none: "no streamed output, so no window" },
		image: { none: "hub returns text only" },
		"stdin request": { none: "no interactive input path" },
		"details-only notice": { none: "hub records its facts in `details.daemon`, covered by the two rows above" },
		"partial failure": { none: "one op addresses one daemon" },
		"duplicate per-file notice": { none: "hub addresses one daemon per op; no per-file text axis exists" },
	},
	edit: {
		success: {
			none: "a fully successful edit renders as diffs alone, covered by `acp-event-mapper.test.ts`'s diff branches",
		},
		"nonzero exit": { none: "an edit has no process and therefore no exit code" },
		timeout: { none: "no process to time out" },
		abort: { none: "an aborted edit throws; see bash's abort cell" },
		"artifact spill": { none: "edit results are diffs, bounded by the snapshot budget rather than the output sink" },
		"tail-window rollover": { none: "no streamed output, so no window" },
		image: { none: "edit returns diffs and text only" },
		"stdin request": { none: "no interactive input path" },
		"details-only notice": { none: "edit's notices ride in `details.meta`, exercised by the partial-failure row" },
		"partial failure": "edit, multi-file patch with one missing file",
		"duplicate per-file notice": {
			none: "edit's only per-file `meta` axis is LSP diagnostics, and `formatDiagnostic` (`lsp/utils.ts`) always bakes the file's own relative path into every message, so two distinct real files can never render a byte-identical notice string before the mapper's own path prefix is added — the bug this axis names cannot occur through any live edit producer. The class it guards against — a producer's per-file `meta` carrying no per-file-identifying text — is exercised directly by `acp-event-mapper.test.ts`'s `preserves file attribution when diagnostics text is identical` regression test, with a hand-built shared `meta` object standing in for that producer shape.",
		},
	},
};

describe("ACP producer matrix coverage", () => {
	const rowNames = new Set(PRODUCER_CASES.map(producerCase => producerCase.name));
	const namedRows = new Set<string>();

	for (const [producer, outcomes] of Object.entries(COVERAGE)) {
		for (const [outcome, cell] of Object.entries(outcomes)) {
			it(`declares ${producer} × ${outcome}`, () => {
				if (typeof cell === "string") {
					expect(rowNames.has(cell), `no producer row named ${JSON.stringify(cell)}`).toBe(true);
					namedRows.add(cell);
					return;
				}
				// A hole is allowed; an unexplained hole is not. The reason has
				// to name what the producer structurally cannot do, which is
				// what makes it reviewable against the source instead of being
				// a way to keep the table green.
				expect(cell.none.length).toBeGreaterThan(20);
			});
		}
	}

	it("names every producer row in the table", () => {
		for (const cell of Object.values(COVERAGE).flatMap(outcomes => Object.values(outcomes))) {
			if (typeof cell === "string") namedRows.add(cell);
		}
		expect([...rowNames].filter(name => !namedRows.has(name))).toEqual([]);
	});

	it("gives every skipped mode a reason", () => {
		for (const producerCase of PRODUCER_CASES) {
			for (const [mode, reason] of Object.entries(producerCase.modeSkips ?? {})) {
				expect(MODE_NAMES.includes(mode as ModeName), `unknown mode ${mode}`).toBe(true);
				expect(reason.length, `${producerCase.name} → ${mode}`).toBeGreaterThan(20);
			}
		}
	});

	it("gives every non-exact allowance a reason", () => {
		// An exemption is only defensible if it names what the producer or the
		// client is structurally incapable of. Requiring the prose is what
		// stops the next red row from being turned green with a number.
		for (const producerCase of PRODUCER_CASES) {
			const rolls = producerCase.discontinuities;
			if (typeof rolls === "object") {
				expect(rolls.because.length, `${producerCase.name} discontinuities`).toBeGreaterThan(20);
			}
			if (producerCase.producerDroppedBytes !== undefined) {
				expect(producerCase.producerDroppedBytes.length, `${producerCase.name} dropped bytes`).toBeGreaterThan(20);
			}
		}
	});
});

/**
 * Bytes a client would append to the display-only terminal, in delivery order.
 * `AcpAgent` keeps the watermark per tool call across the whole sequence
 * (`metaTerminalSent`), so the replay below has to as well or the incremental
 * path is never entered.
 */
function replayThroughMapper(
	toolCallId: string,
	outcome: ProducerOutcome,
	mode: (typeof MODES)[ModeName],
): { frames: SessionNotification[]; terminalChunks: string[]; allDeliveredTexts: string[] } {
	const watermarks = new Map<string, string>();
	const options = {
		...mode,
		getToolArgs: () => outcome.args,
		getMetaTerminalSent: (id: string) => watermarks.get(id),
		setMetaTerminalSent: (id: string, value: string) => {
			watermarks.set(id, value);
		},
	};
	const frames: SessionNotification[] = [];
	for (const partialResult of outcome.updates) {
		frames.push(
			...mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_update",
					toolCallId,
					toolName: outcome.toolName,
					args: outcome.args,
					partialResult,
				} as AgentSessionEvent,
				"session-1",
				options,
			),
		);
	}
	const endFrames = mapAgentSessionEventToAcpSessionUpdates(
		{
			type: "tool_execution_end",
			toolCallId,
			toolName: outcome.toolName,
			args: outcome.args,
			isError: outcome.result.isError === true,
			result: outcome.result,
		} as AgentSessionEvent,
		"session-1",
		options,
	);
	frames.push(...endFrames);
	const terminalChunks: string[] = [];
	// Every rendered channel across the *whole* sequence, not just the last
	// frame: a line delivered on an earlier `tool_execution_update` and never
	// repeated on the final frame is not missing (`missingFinalBodyLines`
	// reads this, not just the end frame's own texts).
	const allDeliveredTexts: string[] = [];
	for (const frame of frames) {
		const meta = (frame.update as { _meta?: { terminal_output?: { data?: unknown } } })._meta;
		if (typeof meta?.terminal_output?.data === "string") {
			terminalChunks.push(meta.terminal_output.data);
			allDeliveredTexts.push(meta.terminal_output.data);
		}
		allDeliveredTexts.push(...frameTexts(frame.update as unknown as Record<string, unknown>));
	}
	return { frames: endFrames, terminalChunks, allDeliveredTexts };
}

const DISCONTINUITY_MARKER = "terminal output discontinuity";

/**
 * A terminal buffer is append-only: a client concatenates every
 * `terminal_output.data` it receives. Re-sending a body it already holds
 * duplicates what the user sees, so no chunk may repeat a substantial run of
 * already-delivered bytes. The 256-byte probe skips notice-sized chunks (whose
 * repetition is bounded and legible) while catching a re-sent output body.
 */
function expectAppendOnly(chunks: readonly string[]): void {
	let delivered = "";
	for (const chunk of chunks) {
		const body = chunk.replaceAll(/\n?\[[^\]]*terminal output discontinuity[^\]]*\]\n?/g, "");
		if (body.length >= 256) {
			expect(delivered.includes(body.slice(0, 256))).toBe(false);
		}
		delivered += chunk;
	}
}

const MODE_NAMES = Object.keys(MODES) as readonly ModeName[];

describe("ACP producer matrix", () => {
	for (const producerCase of PRODUCER_CASES) {
		for (const modeName of MODE_NAMES) {
			const skipReason = producerCase.modeSkips?.[modeName];
			const run = skipReason ? it.skip : it;
			run(`${producerCase.name} → ${modeName}${skipReason ? ` (skipped: ${skipReason})` : ""}`, async () => {
				const toolCallId = `matrix-${producerCase.name.replace(/[^a-z0-9]+/gi, "-")}-${modeName}`;
				const outcome = await producerCase.run(toolCallId);
				const mode = MODES[modeName];
				const { frames, terminalChunks, allDeliveredTexts } = replayThroughMapper(toolCallId, outcome, mode);
				expect(frames).toHaveLength(1);
				const update = frames[0]!.update as unknown as Record<string, unknown>;

				// 1. Declared outcome.
				expect(update.status).toBe(producerCase.status);
				const exit = (update._meta as { terminal_exit?: { exit_code?: number } } | undefined)?.terminal_exit;
				if (exit) {
					expect(exit.exit_code).toBe(producerCase.exitCode);
				}
				// Whether the frame actually hands the user off to a real,
				// client-owned terminal — derived from the frame, never declared,
				// because it is mode-dependent: the same producer that created a
				// client terminal renders through the display-only convention in
				// `meta` mode, where its body is the mapper's job again. Declaring
				// it per row is what exempted `bash × timeout` from check #6 in
				// every mode, including the one where the check applies.
				const rendersClientTerminal =
					producerCase.terminalId !== undefined &&
					(update.content as Array<{ type: string; terminalId?: string }> | undefined)?.some(
						item => item.type === "terminal" && item.terminalId === producerCase.terminalId,
					) === true;
				if (producerCase.terminalId && mode.realTerminalCapable) {
					expect(rendersClientTerminal).toBe(true);
				}

				// 2. No structurally-recorded producer fact silently dropped —
				// and, for a row that names them, the producer really did record
				// them, so the comparison isn't against an empty set.
				const declared = producerFacts(outcome.result);
				for (const expected of producerCase.expectProducerFacts ?? []) {
					expect(declared.join("\n"), "producer recorded no such fact").toContain(expected);
				}
				const texts = [...frameTexts(update), ...terminalChunks].join("\n");
				for (const fact of declared) {
					expect(texts).toContain(fact);
				}

				// 3. Append-only terminal stream: nothing delivered twice.
				expectAppendOnly(terminalChunks);

				// 4. No fabricated data loss. The replay feeds the mapper every
				// snapshot the producer emitted, so it may only claim dropped
				// bytes when the producer's own tail buffer rolled between two of
				// them. The producer-side count is declared per row; the wire
				// budget is derived, because only a display-only meta terminal
				// has a mapper-owned buffer to lose its place in — every other
				// mode must carry exactly zero, and asserting equality means a
				// stale allowance fails instead of hiding a fabrication.
				const claimed = terminalChunks.filter(chunk => chunk.includes(DISCONTINUITY_MARKER)).length;
				const usesMetaTerminal = wantsMetaTerminal(outcome.toolName, outcome.args, mode);
				const declaredRolls = producerCase.discontinuities ?? 0;
				if (!usesMetaTerminal) {
					expect(claimed).toBe(0);
				} else if (typeof declaredRolls === "number") {
					expect(claimed).toBe(declaredRolls);
				} else {
					expect(claimed).toBeLessThanOrEqual(declaredRolls.upTo);
				}

				// 5. Wire invariants, same check `AcpAgent#sendUpdate` runs.
				expect(checkAcpUpdateInvariants(frames[0]!, { terminalMetaCapable: mode.terminalMetaCapable })).toEqual([]);

				// 6. No line of the producer's own final body text vanished on
				// every rendered channel across the sequence. Unlike check #2,
				// this needs no axis declared first — it reads the same
				// authoritative text a plain-content client would show, so a
				// fact synthesized straight into that text (never declared as a
				// separate structural field) still has to survive somewhere.
				//
				// Two exemptions, both structural rather than convenient: a frame
				// that renders a real client-owned terminal delivers its body
				// out-of-band over the `terminal/output` RPC a client polls
				// independently of `session/update`, invisible to an in-process
				// replay by construction; and a producer that destroyed part of
				// its own body before handing it over (`producerDroppedBytes`)
				// leaves nothing any channel could deliver — that loss is
				// acknowledged by its own elision notice (check #2) and bounded
				// by check #4, at a granularity a line diff against a
				// thousands-of-lines summary cannot express.
				if (!rendersClientTerminal && !producerCase.producerDroppedBytes) {
					const allowed =
						typeof producerCase.allowUndeliveredFinalLines === "object"
							? (producerCase.allowUndeliveredFinalLines[modeName] ?? 0)
							: (producerCase.allowUndeliveredFinalLines ?? 0);
					const finalBodyText = producerFinalBodyText(outcome.result);
					const missing = missingFinalBodyLines(finalBodyText, allDeliveredTexts);
					expect(missing.length, `undelivered final-body lines: ${JSON.stringify(missing)}`).toBe(allowed);
				}
			});
		}
	}
});

/**
 * The failure mode this guards against: `producerFacts` declares three
 * axes (`details.notices`, `details.notice`, `details.meta`), but check #2
 * above is vacuous on any axis no row's *real* result populates — exactly
 * how `details.notice` shipped uncovered for the whole life of this matrix:
 * the axis was declared, the
 * check read it, and nothing ever failed because no row's producer ever set
 * it. Asserting non-vacuity here, once, is cheaper than re-discovering it
 * from a missed bug every time a new axis is declared.
 *
 * The top-level `errorMessage`/`message`/`text` (`directText`) axis is
 * deliberately not required here: within this matrix's scope (a single
 * `AgentTool.execute()` result), no producer sets it — the one real
 * instance, "Permission request cancelled", is synthesized a layer above
 * `tool.execute()` (the agent loop's permission-cancellation catch,
 * `cursor.ts`/`session-tools.ts`), never inside a tool result the matrix
 * can construct by calling a tool directly. That axis is covered instead by
 * `acp-event-mapper.test.ts`'s hand-fabricated fixtures, which is the
 * correct place for a framework-level fact no tool producer emits.
 */
describe("ACP producer matrix vacuity guard", () => {
	it("every declared details-fact axis is populated by at least one row's real result", async () => {
		let sawNotices = false;
		let sawNotice = false;
		let sawMeta = false;
		for (const producerCase of PRODUCER_CASES) {
			const outcome = await producerCase.run(`vacuity-${producerCase.name.replace(/[^a-z0-9]+/gi, "-")}`);
			const details = outcome.result.details;
			if (typeof details !== "object" || details === null) continue;
			if ("notices" in details && Array.isArray((details as { notices?: unknown }).notices)) {
				const notices = (details as { notices?: unknown[] }).notices ?? [];
				if (notices.length > 0) sawNotices = true;
			}
			if (typeof (details as { notice?: unknown }).notice === "string") sawNotice = true;
			if ((details as { meta?: unknown }).meta) sawMeta = true;
		}
		expect({ sawNotices, sawNotice, sawMeta }).toEqual({ sawNotices: true, sawNotice: true, sawMeta: true });
	});
});

/**
 * `asEditDetails`/`extractToolCallContent` narrow a real producer's
 * `details` by hand (see `AcpEditFields`'s comment in the mapper): every
 * leaf field the validators inspect is a place a malformed or degenerate
 * value — from an extension, an MCP-proxied edit-shaped tool, or a
 * corrupted `session/load` replay record — can reach the mapper instead of
 * `EditToolPerFileResult`'s own type guarantees. Several specific mutations
 * found by review each closed one gap here; this
 * walks every leaf of a *real* producer's `details` and mutates it six
 * ways, so the next one is found here instead.
 */
describe("ACP mapper survives mutated real edit details", () => {
	/** Every leaf path of a JSON-shaped value, dot/bracket-free — `["a", 0, "b"]` for `{a: [{b: 1}]}`. */
	function leafPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
		if (Array.isArray(value)) {
			return value.flatMap((item, i) => leafPaths(item, [...prefix, i]));
		}
		if (value !== null && typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>);
			if (entries.length === 0) return prefix.length > 0 ? [prefix] : [];
			return entries.flatMap(([key, v]) => leafPaths(v, [...prefix, key]));
		}
		return prefix.length > 0 ? [prefix] : [];
	}

	/** Deep-clone `root`, apply `mutate` at `path`, deleting the key if `mutate` returns the sentinel. */
	const DELETE_KEY = Symbol("delete");
	function withMutation(root: unknown, path: (string | number)[], mutate: (leaf: unknown) => unknown): unknown {
		const clone = structuredClone(root as Record<string, unknown>);
		let parent: Record<string, unknown> | unknown[] = clone as Record<string, unknown>;
		for (let i = 0; i < path.length - 1; i++) {
			parent = (parent as Record<string | number, unknown>)[path[i]!] as Record<string, unknown> | unknown[];
		}
		const key = path[path.length - 1]!;
		const container = parent as Record<string | number, unknown>;
		const replacement = mutate(container[key]);
		if (replacement === DELETE_KEY) {
			if (Array.isArray(container)) container.splice(key as number, 1);
			else delete container[key as string];
		} else {
			container[key] = replacement;
		}
		return clone;
	}

	const MUTATIONS: { name: string; apply: (leaf: unknown) => unknown }[] = [
		{ name: "delete", apply: () => DELETE_KEY },
		{ name: "null", apply: () => null },
		{ name: "number", apply: () => 42 },
		{ name: "string", apply: () => "mutated" },
		{ name: "object", apply: () => ({}) },
		{ name: "array", apply: () => [] },
	];

	interface MinimalToolCallUpdate {
		sessionUpdate?: string;
		content?: unknown[];
		_meta?: Record<string, unknown>;
	}

	it("never throws and always emits one well-formed frame for a mutated real edit result", async () => {
		const { result } = await runPartiallyFailingEdit("mutation-base");
		const details: unknown = result.details;
		expect(typeof details).toBe("object");
		const paths = leafPaths(details);
		expect(paths.length).toBeGreaterThan(5); // guards against a degenerate fixture with nothing to mutate

		const failures: string[] = [];
		for (const path of paths) {
			for (const mutation of MUTATIONS) {
				const original = path.reduce<unknown>((v, key) => (v as Record<string | number, unknown>)[key], details);
				// Skip a no-op mutation (e.g. "string" on a field already a string
				// with the same value) — it proves nothing about malformed input.
				if (mutation.name === "string" && original === "mutated") continue;
				const mutatedDetails = withMutation(details, path, mutation.apply);
				const label = `${path.join(".")} → ${mutation.name}`;
				for (const [modeName, mode] of Object.entries(MODES)) {
					const event = {
						type: "tool_execution_end",
						toolCallId: `mutation-${label}-${modeName}`,
						toolName: "edit",
						isError: result.isError === true,
						result: { content: result.content, details: mutatedDetails },
					} as unknown as AgentSessionEvent;
					try {
						const notifications = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", mode);
						const updateNotifications = notifications.filter(
							n => (n.update as MinimalToolCallUpdate).sessionUpdate === "tool_call_update",
						);
						if (updateNotifications.length !== 1) {
							failures.push(
								`${label} [${modeName}]: expected exactly 1 tool_call_update, got ${updateNotifications.length}`,
							);
							continue;
						}
						const violations = checkAcpUpdateInvariants(updateNotifications[0]!, {
							terminalMetaCapable: mode.terminalMetaCapable,
						});
						if (violations.length > 0) failures.push(`${label} [${modeName}]: ${violations.join("; ")}`);
						const update = updateNotifications[0]!.update as MinimalToolCallUpdate;
						const nonEmpty =
							(update.content !== undefined && update.content.length > 0) || update._meta !== undefined;
						if (!nonEmpty) failures.push(`${label} [${modeName}]: emitted an empty frame`);
					} catch (error) {
						failures.push(`${label} [${modeName}]: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
