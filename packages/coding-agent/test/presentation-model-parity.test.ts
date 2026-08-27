import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
	ByteOffset,
	StreamId,
	ToolFact,
	ToolOutcome,
	ToolPresentationEvent,
} from "@oh-my-pi/pi-agent-core/presentation";
import {
	byteLengthOf,
	byteOffset,
	PRESENTATION_VERSION,
	streamId,
	ToolPresentationStream,
} from "@oh-my-pi/pi-agent-core/presentation";
import { Settings } from "../src/config/settings";
import type { ToolPresentationView } from "../src/presentation/projections";
import { renderModelContent } from "../src/presentation/projections";
import type { ToolSession } from "../src/tools";
import { BashTool, type BashToolDetails, bashOutcome } from "../src/tools/bash";

/**
 * Model-content parity against the **real producer**.
 *
 * The goldens in `presentation-model-goldens.test.ts` lock bytes; this suite proves
 * those bytes are the ones bash actually sends the model today. It runs the live
 * tool on the migrated presentation route, builds the presentation view out of the
 * events the tool emitted, and asserts `renderModelContent` reproduces the tool's own
 * `content[]` **byte for byte**.
 *
 * That is the check that makes the corpus authoritative rather than self-referential:
 * a golden regenerated from the formatter agrees with the formatter by construction,
 * while this test disagrees with it the moment the projection invents, moves or drops
 * a line. It is what catches the two divergences the review found — the stop
 * annotation moving from the body's head to its tail, and truncation/artifact notices
 * appearing in model content that never had them.
 *
 * Scope: scenarios where the retained body equals the emitted stream, so the view can
 * be built from the events alone. Column-capped and retention-rolled bodies differ from the
 * raw stream by construction (the sink appends pre-cap chunks and retains a narrowed
 * window), so their exact bytes are locked as goldens instead.
 */

const cleanupRoots: string[] = [];

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

function makeSession(): ToolSession {
	const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-model-parity-"));
	cleanupRoots.push(artifactDir);
	let nextArtifactId = 0;
	return {
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
			getBashInterceptorRules: () => [],
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
}

interface ProducerRun {
	/** The exact text the tool put in front of the model. */
	readonly modelText: string;
	readonly view: ToolPresentationView;
}

/** Run bash on the presentation protocol exactly as the dispatcher does. */
async function runBash(
	command: string,
	options: { readonly timeout?: number; readonly abortAfterMs?: number; readonly pty?: boolean } = {},
): Promise<ProducerRun> {
	const tool = new BashTool(makeSession());
	const toolCallId = "parity-call";
	const events: ToolPresentationEvent[] = [];
	const producer = new ToolPresentationStream(streamId(toolCallId), event => events.push(event));
	const args = {
		command,
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		...(options.pty === undefined ? {} : { pty: options.pty }),
	};
	const controller = new AbortController();
	if (options.abortAfterMs !== undefined) {
		setTimeout(() => controller.abort("User interrupted the run"), options.abortAfterMs);
	}

	let result: AgentToolResult<BashToolDetails> | undefined;
	let thrown: unknown;
	try {
		result = await tool.execute(
			toolCallId,
			args as never,
			options.abortAfterMs === undefined ? undefined : controller.signal,
			undefined,
			{
				toolCall: {
					batchId: "b",
					index: 0,
					total: 1,
					toolCalls: [{ id: toolCallId, name: "bash" }],
					progress: { kind: "presentation_events", presentation: producer },
				},
			} as unknown as AgentToolContext,
		);
	} catch (error) {
		thrown = error;
	}
	await producer.freeze();

	// The model-facing text: the result's text block, or the thrown message — which is
	// what the agent loop turns into the result content on a throw.
	const textBlock = result?.content.find(block => block.type === "text");
	const modelText =
		thrown !== undefined
			? thrown instanceof Error
				? thrown.message
				: String(thrown)
			: textBlock?.type === "text"
				? textBlock.text
				: "";

	const facts: ToolFact[] = events.flatMap(event => (event.type === "fact" ? [event.fact] : []));
	const streamText = events
		.filter(
			(event): event is Extract<ToolPresentationEvent, { type: "terminal_append" }> =>
				event.type === "terminal_append",
		)
		.map(event => event.data)
		.join("");
	const outcome: ToolOutcome =
		thrown !== undefined
			? { kind: "interrupted", reason: "User interrupted the run" }
			: result === undefined
				? { kind: "failed", failure: { reason: "internal", message: "no result" } }
				: bashOutcome(result);

	return {
		modelText,
		view: {
			call: { toolCallId, toolName: "bash", title: command, kind: "execute", cwd: "/tmp" },
			outcome,
			presentation: {
				version: PRESENTATION_VERSION,
				stream: {
					streamId: streamId(toolCallId) as StreamId,
					startByte: byteOffset(0) as ByteOffset,
					endByte: byteOffset(byteLengthOf(streamText)) as ByteOffset,
					text: streamText,
					gaps: [],
				},
				facts,
				attachments: [],
			},
		},
	};
}

/** The projection's single text block, for byte comparison against the producer. */
function projectedText(run: ProducerRun): string {
	const blocks = renderModelContent(run.view);
	const text = blocks.find(block => block.type === "text");
	return text?.type === "text" ? text.text : "";
}

describe("model projection parity with the live bash producer", () => {
	it("reproduces a successful run byte for byte", async () => {
		const run = await runBash("printf 'PARITY-LINE-0001\\n'");
		expect(run.modelText).toContain("PARITY-LINE-0001");
		expect(projectedText(run)).toBe(run.modelText);
	});

	it("reproduces an empty-output run byte for byte", async () => {
		const run = await runBash("true");
		expect(run.modelText.startsWith("(no output)")).toBe(true);
		expect(projectedText(run)).toBe(run.modelText);
	});

	it("reproduces a nonzero exit byte for byte, including the exit line", async () => {
		const run = await runBash("sh -c 'printf \"PARITY-LINE-0002\\n\"; exit 3'");
		expect(run.modelText).toContain("Command exited with code 3");
		expect(projectedText(run)).toBe(run.modelText);
	});

	it("keeps the timeout annotation at the head of the body, where the producer put it", async () => {
		// The first of the two divergences the review named. `OutputSink.dump(notice)`
		// returns `"[notice]\n" + body`, so the annotation is the body's first line;
		// projecting it as a trailing notice changed the model's bytes.
		const run = await runBash("printf 'PARITY-LINE-0003\\n'; sleep 30", { timeout: 1 });
		expect(run.modelText.startsWith("[Command timed out after 1 seconds]\n")).toBe(true);
		expect(projectedText(run)).toBe(run.modelText);
	}, 20_000);

	it("preserves the cancellation annotation exactly once", async () => {
		// The bash fact publisher used to be bypassed entirely on abort, so the
		// cancellation reason reached neither the terminal nor the projection.
		const run = await runBash("printf 'PARITY-LINE-0004\\n'; sleep 5", { abortAfterMs: 300 });
		expect(run.modelText.startsWith("[Command cancelled]")).toBe(true);
		expect(projectedText(run)).toBe(run.modelText);
		const annotations = run.view.presentation.facts.filter(fact => fact.kind === "stop_annotation");
		expect(annotations).toHaveLength(1);
		// ...and it is not also duplicated as an ordinary trailing notice.
		expect(run.view.presentation.facts.filter(fact => fact.kind === "notice")).toHaveLength(0);
	}, 20_000);

	it("adds no truncation or artifact line the producer's model text does not have", async () => {
		// The second named divergence. The retained body carries the sink's own
		// middle-elision marker; `[Showing lines …]` and `[raw output: artifact://N]`
		// are not in today's model content, so the model audience must not receive them.
		const run = await runBash("seq 1 20000");
		const facts = run.view.presentation.facts.map(fact => fact.kind);
		// The facts *are* declared — they ride the human channels.
		expect(facts).toContain("truncation");
		expect(facts).toContain("artifact");
		const projected = projectedText(run);
		expect(projected).not.toContain("[Showing lines");
		expect(projected).not.toContain("[raw output: artifact://");
		expect(run.modelText).not.toContain("[raw output: artifact://");
		// The producer's own retained body is narrower than the stream, so this run is
		// not byte-comparable end to end; the trailing block still must be.
		expect(projected.endsWith(run.modelText.slice(run.modelText.lastIndexOf("\n\nWall time:")))).toBe(true);
	}, 30_000);

	it("keeps a cancelled pty:true run's projection byte-identical to what the model actually saw", async () => {
		// P2: without an interactive UI, `pty: true` runs the local foreground executor
		// (with a "pty requested but unavailable" notice) rather than a real terminal.
		// On a normal completion that notice is baked into the composed body, so the
		// model text and the projection agree. On cancellation the thrown message never
		// included it — but `publishBashFacts` used to declare it as a generic `"all"`
		// audience `notice` fact anyway, so the *projection* grew a line the model was
		// never shown. The fix declares it as the human-only `unreported_annotation`
		// kind on this path instead, so it is correctly absent from the model
		// projection here while still reaching a terminal-rendering client.
		const run = await runBash("printf 'PTY-PARITY-LINE-0001\\n'; sleep 5", { pty: true, abortAfterMs: 300 });
		expect(run.modelText.startsWith("[Command cancelled]")).toBe(true);
		expect(run.modelText).not.toContain("pty requested");
		expect(projectedText(run)).toBe(run.modelText);
		// The information is not lost — it rides the human-only channel instead.
		expect(run.view.presentation.facts.map(fact => fact.kind)).toContain("unreported_annotation");
		expect(run.view.presentation.facts.filter(fact => fact.kind === "notice")).toHaveLength(0);
		expect(run.view.presentation.facts.filter(fact => fact.kind === "capability_notice")).toHaveLength(0);
	}, 20_000);

	it("reproduces a successful pty:true fallback run byte for byte, notice included", async () => {
		// The other half of the P2 finding: on a path whose result body *does* carry
		// the fallback notice, the model must see it too — `capability_notice` is
		// `"all"` audience, not human-only, so this is the mirror of the cancellation
		// case above rather than a duplicate of it.
		const run = await runBash("printf 'PTY-PARITY-LINE-0005\\n'", { pty: true });
		expect(run.modelText).toContain("pty requested but unavailable in this environment; ran without a terminal");
		expect(projectedText(run)).toBe(run.modelText);
		expect(run.view.presentation.facts.map(fact => fact.kind)).toContain("capability_notice");
		expect(run.view.presentation.facts.filter(fact => fact.kind === "unreported_annotation")).toHaveLength(0);
	});

	it("reproduces a timed-out pty:true fallback run byte for byte, notice included", async () => {
		const run = await runBash("printf 'PTY-PARITY-LINE-0006\\n'; sleep 30", { pty: true, timeout: 1 });
		expect(run.modelText).toContain("pty requested but unavailable in this environment; ran without a terminal");
		expect(projectedText(run)).toBe(run.modelText);
		expect(run.view.presentation.facts.map(fact => fact.kind)).toContain("capability_notice");
		expect(run.view.presentation.facts.filter(fact => fact.kind === "unreported_annotation")).toHaveLength(0);
	}, 20_000);

	it("drops a cancelled run's clamp notice from the model projection, matching the thrown text", async () => {
		// The same representation defect as the pty case, for the generic notice path:
		// a clamped timeout produces a `notice`-worthy string, but the thrown
		// cancellation message never carries `pendingNotices` at all. Before the fix,
		// `publishBashFacts` declared it `"all"`-audience regardless of path, so the
		// projection grew a line — the timeout-clamp notice — that the model was never
		// actually shown.
		const run = await runBash("printf 'PARITY-LINE-0007\\n'; sleep 5", {
			timeout: 999_999,
			abortAfterMs: 300,
		});
		expect(run.modelText.startsWith("[Command cancelled]")).toBe(true);
		expect(run.modelText).not.toContain("Timeout clamped");
		expect(projectedText(run)).toBe(run.modelText);
		expect(run.view.presentation.facts.map(fact => fact.kind)).toContain("unreported_annotation");
		expect(run.view.presentation.facts.filter(fact => fact.kind === "notice")).toHaveLength(0);
	}, 20_000);
});
