import type {
	ByteOffset,
	RetainedStreamView,
	StreamId,
	ToolAttachment,
	ToolCallPresentation,
	ToolFact,
	ToolFactBody,
	ToolOutcome,
	ToolPresentationRecord,
} from "@oh-my-pi/pi-agent-core/presentation";
import {
	byteLengthOf,
	byteOffset,
	factId,
	nonZeroExitCode,
	PRESENTATION_VERSION,
	streamId,
} from "@oh-my-pi/pi-agent-core/presentation";
import type { ToolPresentationView } from "../../src/presentation/projections";

/**
 * The model-content golden corpus.
 *
 * One fixture per occupied cell of `acp-producer-wire.test.ts`'s `COVERAGE`
 * matrix, plus the notice-heavy variants worth covering explicitly (truncation +
 * artifact spill, LSP diagnostics, timeout, nonzero exit, multi-file partial edit
 * failure, eval-with-image, column truncation).
 *
 * These are **structured** fixtures, deliberately: the golden locks the bytes of
 * the *projection*, not of a live producer run. That makes it deterministic (no
 * wall-clock, no artifact-id allocation, no pipe-read-size luck — the properties
 * `docs/acp-development.md` rule 7 warns about) and it makes the phase-3 flip,
 * where the projection becomes the authority for model content, a reviewable diff
 * against these files rather than an invisible behaviour change.
 *
 * TUI and ACP projections deliberately get receipt/encoder semantic tests instead
 * of byte goldens — their contracts differ from the model's and forcing them to be
 * byte-identical would encode a coupling the design rejects.
 */

let factCounter = 0;

/** Deterministic fact ids: goldens must not depend on allocation order across files. */
function fact(body: ToolFactBody): ToolFact {
	return { id: factId(`golden:f${factCounter++}`), ...body } as ToolFact;
}

/** Reset the fact counter so a fixture's ids are stable regardless of test order. */
function resetFacts(): void {
	factCounter = 0;
}

function stream(text: string, options: { readonly totalBytes?: number } = {}): RetainedStreamView {
	const retained = byteLengthOf(text);
	return {
		streamId: streamId("golden-stream") as StreamId,
		startByte: byteOffset(0) as ByteOffset,
		endByte: byteOffset(options.totalBytes ?? retained) as ByteOffset,
		text,
		gaps: [],
	};
}

function record(parts: {
	readonly stream?: RetainedStreamView;
	readonly facts?: readonly ToolFact[];
	readonly attachments?: readonly ToolAttachment[];
}): ToolPresentationRecord {
	return {
		version: PRESENTATION_VERSION,
		...(parts.stream === undefined ? {} : { stream: parts.stream }),
		facts: parts.facts ?? [],
		attachments: parts.attachments ?? [],
	};
}

function bashCall(title: string): ToolCallPresentation {
	return { toolCallId: "golden-call", toolName: "bash", title, kind: "execute", cwd: "/repo" };
}

function evalCall(title: string, sourceEcho: string): ToolCallPresentation {
	return { toolCallId: "golden-call", toolName: "eval", title, kind: "execute", sourceEcho, cwd: "/repo" };
}

function editCall(title: string): ToolCallPresentation {
	return { toolCallId: "golden-call", toolName: "edit", title, kind: "edit", cwd: "/repo" };
}

const SUCCEEDED: ToolOutcome = { kind: "succeeded", process: { kind: "exited", code: 0 } };

function exited(code: number): ToolOutcome {
	return {
		kind: "failed",
		failure: { reason: "process", message: `Command exited with code ${code}` },
		process: { kind: "exited", code: nonZeroExitCode(code) },
	};
}

function timedOut(timeoutMs: number): ToolOutcome {
	return {
		kind: "failed",
		failure: { reason: "process", message: `Command timed out after ${timeoutMs / 1000} seconds` },
		process: { kind: "timed_out", timeoutMs },
	};
}

/** One golden fixture, tagged with the `COVERAGE` cell it stands in for. */
export interface ModelGoldenFixture {
	/** File name under `test/__goldens__/model-content/`. */
	readonly slug: string;
	/** `<producer> × <outcome>` — mirrors the `COVERAGE` axes in `acp-producer-wire.test.ts`. */
	readonly covers: string;
	readonly view: ToolPresentationView;
}

/** Build the corpus. Call once per suite so fact ids are deterministic. */
export function buildModelGoldenCorpus(): readonly ModelGoldenFixture[] {
	resetFacts();
	return [
		{
			slug: "bash-success",
			covers: "bash × success",
			view: {
				call: bashCall("echo hi"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream("hi\n"),
					facts: [fact({ kind: "wall_time", ms: 12 })],
				}),
			},
		},
		{
			slug: "bash-no-output",
			covers: "bash × success (empty stream)",
			view: {
				call: bashCall("true"),
				outcome: SUCCEEDED,
				presentation: record({ facts: [fact({ kind: "wall_time", ms: 4 })] }),
			},
		},
		{
			slug: "bash-nonzero-exit",
			covers: "bash × nonzero exit",
			view: {
				call: bashCall("sh -c 'echo hi; exit 3'"),
				outcome: exited(3),
				presentation: record({
					stream: stream("hi\n"),
					facts: [fact({ kind: "wall_time", ms: 9 })],
				}),
			},
		},
		{
			slug: "bash-timeout-local",
			covers: "bash × timeout",
			view: {
				call: bashCall("printf 'working\\n'; sleep 30"),
				outcome: timedOut(1000),
				presentation: record({
					stream: stream("working\n"),
					facts: [
						fact({ kind: "wall_time", ms: 1004 }),
						// The local executor's `OutputSink.dump(notice)` composes this onto the
						// *head* of the retained body, which is why it is a `stop_annotation` and
						// not a trailing notice. Verified against a live run in
						// `presentation-model-parity.test.ts`.
						fact({ kind: "stop_annotation", text: "[Command timed out after 1 seconds]" }),
					],
				}),
			},
		},
		{
			slug: "bash-timeout-client-terminal",
			covers: "bash (client terminal) × timeout",
			view: {
				call: bashCall("sleep 30"),
				outcome: timedOut(1000),
				presentation: record({
					stream: stream(""),
					// A client-owned terminal has no local sink, so nothing prepends the
					// annotation to a body: `#buildCompletedResult` appends it after a blank line
					// instead (`outputLines.push("", annotation)`). Same fact family, different
					// placement, and the placement is a property of the producer's composition —
					// which is exactly why `stop_annotation` and `notice` are separate kinds.
					facts: [fact({ kind: "notice", text: "[Command timed out after 1 seconds]" })],
				}),
			},
		},
		{
			slug: "bash-artifact-spill",
			covers: "bash × artifact spill",
			view: {
				call: bashCall("seq 1 20000"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream("19998\n19999\n20000\n", { totalBytes: 112_890 }),
					facts: [
						fact({ kind: "wall_time", ms: 240 }),
						fact({
							kind: "truncation",
							meta: {
								direction: "tail",
								totalBytes: 112_890,
								retainedBytes: 18,
								totalLines: 20_000,
								retainedLines: 3,
							},
						}),
						fact({ kind: "artifact", artifactId: "4" }),
					],
				}),
			},
		},
		{
			slug: "bash-tail-window-rollover",
			covers: "bash × tail-window rollover",
			view: {
				call: bashCall("awk 'BEGIN{for(i=0;i<3000;i++) printf \"%063d\\n\", i}'"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream(
						"000000000000000000000000000000000000000000000000000000000000000\n…\n000000000000000000000000000000000000000000000000000000000002999\n",
						{
							totalBytes: 192_000,
						},
					),
					facts: [
						fact({ kind: "wall_time", ms: 310 }),
						fact({
							kind: "truncation",
							meta: {
								direction: "middle",
								totalBytes: 192_000,
								retainedBytes: 51_200,
								totalLines: 3_000,
								retainedLines: 800,
								elidedBytes: 140_800,
								elidedLines: 2_200,
							},
						}),
						fact({ kind: "artifact", artifactId: "5" }),
					],
				}),
			},
		},
		{
			slug: "bash-column-truncation",
			covers: "bash × column truncation",
			view: {
				call: bashCall("cat wide.txt"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream("aaaaaaaa…\n"),
					facts: [
						fact({ kind: "wall_time", ms: 7 }),
						fact({ kind: "limit", meta: { limit: "column", value: 512, droppedBytes: 4_096, affectedLines: 3 } }),
					],
				}),
			},
		},
		{
			slug: "bash-interrupted",
			covers: "bash × abort (synthetic settlement)",
			view: {
				call: bashCall("sleep 60"),
				outcome: { kind: "interrupted", reason: "User interrupted the run" },
				// The cancellation annotation the sink dumped onto the head of the body. Its
				// absence here is what let cancellation text disappear from the projection.
				presentation: record({
					stream: stream("partial\n"),
					facts: [fact({ kind: "stop_annotation", text: "[Command cancelled]" })],
				}),
			},
		},
		{
			slug: "eval-success",
			covers: "eval × success",
			view: {
				call: evalCall("[py] ok", "print('ok')"),
				outcome: SUCCEEDED,
				presentation: record({ stream: stream("ok\n") }),
			},
		},
		{
			slug: "eval-nonzero-exit",
			covers: "eval × nonzero exit",
			view: {
				call: evalCall("[py] boom", "raise SystemExit(1)"),
				outcome: exited(1),
				presentation: record({ stream: stream("boom\n") }),
			},
		},
		{
			slug: "eval-aborted",
			covers: "eval × abort",
			view: {
				call: evalCall("[js] loop", "while (true) {}"),
				outcome: { kind: "interrupted", reason: "Command aborted" },
				presentation: record({ stream: stream("aborted-cell-line-1\naborted-cell-line-2\n") }),
			},
		},
		{
			slug: "eval-kernel-timeout",
			covers: "eval × timeout",
			view: {
				call: evalCall("[py] hang", "time.sleep(99)"),
				outcome: timedOut(2000),
				presentation: record({
					stream: stream("streamed-py-line-1\nstreamed-py-line-2\n"),
					// `executor-base.ts` dumps this through `sink.dump(annotation)` too, so it is
					// head-placed exactly like bash's.
					facts: [fact({ kind: "stop_annotation", text: "[Kernel timed out and was restarted]" })],
				}),
			},
		},
		{
			slug: "eval-stdin-request",
			covers: "eval × stdin request",
			view: {
				call: evalCall("[py] input", "input('name: ')"),
				outcome: exited(1),
				presentation: record({
					stream: stream("streamed-py-stdin-1\n"),
					facts: [
						fact({ kind: "stop_annotation", text: "[Cell requested stdin; interactive input is unavailable]" }),
					],
				}),
			},
		},
		{
			slug: "eval-tail-window-rollover",
			covers: "eval × tail-window rollover",
			view: {
				call: evalCall("[js] chatty", "for (…) console.log(…)"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream("line-2499\nline-2500\n", { totalBytes: 163_840 }),
					facts: [
						fact({
							kind: "truncation",
							meta: {
								direction: "middle",
								totalBytes: 163_840,
								retainedBytes: 102_400,
								totalLines: 2_500,
								retainedLines: 1_600,
								elidedBytes: 61_440,
								elidedLines: 900,
							},
						}),
					],
				}),
			},
		},
		{
			slug: "eval-image",
			covers: "eval × image",
			view: {
				call: evalCall("[py] plot", "plt.show()"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream("<Figure size 640x480>\n"),
					attachments: [{ kind: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
				}),
			},
		},
		{
			slug: "eval-details-notice",
			covers: "eval × details-only notice",
			view: {
				call: evalCall("[js] proxied", "1 + 1"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream("2\n"),
					facts: [fact({ kind: "notice", text: "Fell back to the proxy executor" })],
				}),
			},
		},
		{
			slug: "edit-partial-failure",
			covers: "edit × partial failure",
			view: {
				call: editCall("apply_patch a.txt, missing.txt"),
				outcome: {
					kind: "failed",
					failure: { reason: "tool_reported", message: "1 of 2 files failed" },
				},
				presentation: record({
					stream: stream("Updated a.txt\nFailed missing.txt: file does not exist\n"),
					attachments: [{ kind: "diff", path: "/repo/a.txt", oldText: "one\n", newText: "two\n" }],
				}),
			},
		},
		{
			slug: "edit-lsp-diagnostics",
			covers: "edit × diagnostics",
			view: {
				call: editCall("edit src/index.ts"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream("Updated src/index.ts\n"),
					facts: [
						fact({
							kind: "diagnostics",
							entries: [
								{
									path: "src/index.ts",
									severity: "error",
									message: "Cannot find name 'foo'.",
									line: 12,
									column: 5,
								},
								{
									path: "src/index.ts",
									severity: "warning",
									message: "'bar' is declared but never used.",
									line: 30,
								},
							],
						}),
					],
					attachments: [{ kind: "diff", path: "/repo/src/index.ts", oldText: "a\n", newText: "b\n" }],
				}),
			},
		},
		{
			slug: "hub-start-failed",
			covers: "hub × nonzero exit",
			view: {
				call: { toolCallId: "golden-call", toolName: "hub", title: "hub start web", kind: "other" },
				outcome: { kind: "failed", failure: { reason: "tool_reported", message: "daemon failed" } },
				presentation: record({
					stream: stream("web: failed (exited with code 1 during startup)\n"),
				}),
			},
		},
		{
			slug: "hub-describe-failed-daemon",
			covers: "hub × success",
			view: {
				call: { toolCallId: "golden-call", toolName: "hub", title: "hub describe web", kind: "other" },
				outcome: SUCCEEDED,
				presentation: record({ stream: stream("web: failed\npid 4242\n") }),
			},
		},
		{
			slug: "ttsr-model-guidance",
			covers: "any × model_guidance (TTSR)",
			view: {
				call: bashCall("git commit -m wip"),
				outcome: SUCCEEDED,
				presentation: record({
					stream: stream("[main abc1234] wip\n"),
					facts: [
						fact({
							kind: "model_guidance",
							source: "ttsr",
							text: "<reminder>Run the test bucket you touched.</reminder>",
						}),
						fact({ kind: "wall_time", ms: 88 }),
					],
				}),
			},
		},
	];
}
