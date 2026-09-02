import { describe, expect, spyOn, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockContent, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { complete, completeSimple, stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	GEMINI_HEADER_RUNAWAY_THRESHOLD,
	GeminiHeaderRunDetector,
	isLoopGuardedModel,
	isReasoningSummaryHeader,
	THINKING_LOOP_ERROR_MARKER,
	ThinkingLoopDetector,
	withThinkingLoopGuard,
} from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { isRetryableError } from "@oh-my-pi/pi-utils";

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] };
}

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

/** A degenerate near-duplicate reasoning loop: the same paragraph intent with
 *  cosmetic wording drift, blank-line separated (the gemini-3.5-flash shape). */
function nearDuplicateLoop(paragraphs: number): string {
	const variants = [
		"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
		"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
		"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
	];
	const out: string[] = [];
	for (let i = 0; i < paragraphs; i++) {
		out.push(`**Confirming Safety ${i}**\n\n${variants[i % variants.length]}`);
	}
	return out.join("\n\n\n");
}

/** The exact 311-character cycle observed from Kiro gpt-5-6-sol on 2026-08-14.
 * The persisted assistant message repeated this cycle 58 times before abort. */
const OBSERVED_KIRO_CYCLE =
	"% shipped. 100% delivered. 100% verified. 100% validated. 100% approved. 100% accepted. 100% merged. 100% deployed. 100% live. 100% operational. 100% successful. 100% excellent. 100% perfect. 100% final. 100% absolute. 100% total. 100% whole. 100% full. 100% entire. 100% complete. 100% done. 100% finished. 100";

/** Genuinely distinct reasoning paragraphs — must never trip the detector. */
function distinctReasoning(): string {
	return [
		"First I read the agent loop to understand how the stream wrapper commits the final assistant message.",
		"Next I traced the retry classifier to see which error shapes are treated as transient by the session.",
		"The Vertex transport needs ADC, so its credential path differs from the OpenRouter completions route entirely.",
		"I should add a regression covering the empty-content terminal so the auto-retry gate stays satisfied later.",
		"The tokenizer counts code points, which matters for the wide-emoji case in the truncation helper above here.",
		"Compaction journals are per-request, so they never persist into the on-disk session transcript at all ever.",
		"The mock provider emits one delta per block, so streaming nuances need a direct detector unit test instead.",
		"Finally I will run the focused package suite and the type checker before touching the changelog entries now.",
		"Telemetry spans wrap each provider call, so failing one must still close its span in the catch branch too.",
		"A device default of CPU keeps the tiny model worker from crashing Bun on teardown across every platform now.",
	].join("\n\n\n");
}

/** Stream `text` through a fresh detector in small chunks, then flush — mirrors
 *  how the guard feeds thinking deltas per turn. Returns the first loop reason. */
function feed(text: string, step = 17): string | null {
	const detector = new ThinkingLoopDetector();
	let detail: string | null = null;
	for (let i = 0; i < text.length && !detail; i += step) detail = detector.push(text.slice(i, i + step));
	return detail ?? detector.flush();
}

/** The reported reasoning-summarizer loop: bold-titled "thoughts" that reshuffle
 *  the same motivational filler ("just doing it, pushing ahead, maintaining
 *  momentum") with no new vocabulary and no concrete reference. Trigrams never
 *  match (word order keeps changing); the stall shows up only as recycled
 *  vocabulary. The titles are summarizer formatting the detector must strip —
 *  left in, their ever-changing wording would inflate novelty and hide the loop. */
function progressLexiconLoop(): string {
	const paras: [string, string][] = [
		[
			"Commencing Forward Movement",
			"I'm now moving forward, proceeding with the task. I'm focusing my attention on moving ahead, and executing. I am not dwelling, but taking action and moving onward. My focus is on doing what needs to be done.",
		],
		[
			"Accelerating Execution Rhythm",
			"I'm now in a state of rapid execution, focused entirely on maintaining this rapid momentum. I'm channeling the energy to keep going, and am focused on executing this task.",
		],
		[
			"Maintaining Momentum",
			"I'm completely locked in, and focused on proceeding. I'm relentlessly pushing forward, dedicated to this task. I'm maintaining momentum, and ensuring continued rapid execution. I'm just doing it, pushing ahead and proceeding!",
		],
		[
			"Executing Task Forward",
			"I'm completely dedicated to pushing forward with this task, focused only on proceeding. I'm relentless in my focus, and driven to just do it. I am focused on the task, and just proceeding with it!",
		],
		[
			"Continuing Forward Progress",
			"I'm focused on moving this forward, and just doing it! I am relentless and driven, dedicated to doing what needs to be done. I'm proceeding, and just executing what is needed to advance. I'm moving forward now, focused on just doing it, and proceeding.",
		],
		[
			"Sustaining Task Focus",
			"I'm laser-focused on moving ahead; dedicated and driven, I am just relentlessly pushing forward. I'm maintaining momentum, and ensuring continued rapid execution, and am proceeding.",
		],
		[
			"Continuing Forward Task",
			"I'm focused on just doing it, pushing ahead relentlessly. Proceeding forward with singular focus, dedicated to execution. I'm maintaining momentum, committed to continued forward progress!",
		],
		[
			"Persevering Forward Action",
			"I'm focused entirely on moving ahead now, and just doing the task. I'm relentless in my focus, just pushing forward and proceeding. I am dedicated to executing what needs to be done. I'm moving forward, focused only on proceeding. I'm not stopping!",
		],
		[
			"Advancing Through Task",
			"I'm focused on the task at hand and dedicated to seeing it through. I'm proceeding relentlessly, and am completely dedicated to maintaining this forward momentum. I am now just doing it, pushing ahead with singular focus and just proceeding.",
		],
		[
			"Executing Task Again",
			"I'm focused on moving this forward, I'm dedicated to the task. I am relentless in my focus, and driven to just do it. I am focused on the task, and am just proceeding with it! I am just doing it, pushing ahead, and proceeding!",
		],
		[
			"Commencing Further Action",
			"I'm now fully engaged, and focused on proceeding. I'm relentless in my focus, and driven to just do it. I am focused on the task, and just proceeding with it! I am just doing it, pushing ahead, and proceeding!",
		],
		[
			"Initiating Focused Execution",
			"I'm now fully immersed in the process, relentlessly focused on proceeding with the task. The plan is to continue this trajectory and to just execute! I am now just doing it, pushing ahead, and proceeding! This is not stopping!",
		],
	];
	return paras.map(([title, body]) => `**${title}**\n\n${body}`).join("\n\n\n");
}

/** A sustained stall that fixates on ONE unchanging reference: each paragraph
 *  permutes the same fixed lexicon (near-zero novelty, low trigram overlap) and
 *  repeats `src/memory.rs`, which after the first mention is never a NEW anchor —
 *  so the run is not reset and the lexical path catches it. Contrast
 *  `perFileTemplates`, where a fresh anchor per paragraph keeps the run from
 *  building. The permuted lexicon keeps per-segment novelty at zero so the run
 *  length is deterministic regardless of streaming chunk boundaries. */
function fixedAnchorStall(paragraphs: number): string {
	const lex = [
		"just",
		"doing",
		"it",
		"proceeding",
		"pushing",
		"ahead",
		"forward",
		"focused",
		"keeping",
		"momentum",
		"relentless",
		"dedicated",
		"driven",
		"moving",
		"executing",
		"onward",
		"staying",
		"locked",
		"committed",
		"grinding",
	];
	return Array.from({ length: paragraphs }, (_, i) => {
		const rotated = [...lex.slice(i % lex.length), ...lex.slice(0, i % lex.length)];
		return `Working src/memory.rs ${rotated.join(" ")} src/memory.rs and again.`;
	}).join("\n\n\n");
}

/** A tight, near-verbatim paragraph loop (high trigram overlap): caught by the
 *  trigram path, distinct from the reshuffled-wording lexical stall above. */
function tightDuplicateLoop(paragraphs: number): string {
	return Array.from(
		{ length: paragraphs },
		(_, i) =>
			`Confirming the change is safe and the whole suite is green; pass number ${i} of the final review sweep.`,
	).join("\n\n\n");
}

/** Focused single-FILE debugging: the same path appears every paragraph, but each
 *  makes a genuinely new observation (high novelty) — must NOT trip. Guards the
 *  new-anchor rule against flagging legitimate fixation on one file. */
const FOCUSED_SINGLE_FILE = [
	"Reading src/memory.rs I see the AsRawFd import was dropped during the last edit near the top of the file.",
	"The mmap call in src/memory.rs passes MAP_PRIVATE, so the page cache stays per process rather than shared.",
	"Down in src/memory.rs the unmap path forgets to check the length argument before calling munmap on it.",
	"A second look at src/memory.rs shows the guard page is allocated but never released on the error branch.",
	"The fault handler referenced from src/memory.rs assumes a tiny page, which breaks on the larger Apple platform.",
	"Tracing ownership through src/memory.rs reveals the Arc is cloned twice but only dropped once on shutdown.",
	"The harness around src/memory.rs maps a zero length region, which the freshly added assertion now rejects.",
	"Finally src/memory.rs needs the volatile read restored or the optimiser elides the probe under release builds.",
].join("\n\n\n");

/** Anchor-free, single-topic deliberation: no code identifiers at all, yet each
 *  sentence advances the argument (high novelty). Exercises the novelty gate in
 *  isolation (no anchor to lean on) — must NOT trip. */
const ANCHOR_FREE_DELIBERATION = [
	"First I think about how the retry path should behave when the model returns nothing useful at all.",
	"The summariser tends to repeat encouragement instead of describing any concrete next move it will take.",
	"A genuine plan keeps introducing fresh nouns because each paragraph advances toward a different sub goal.",
	"When the writer is stuck it recycles the same handful of motivational words over and over without progress.",
	"Distinguishing the two cases matters because discarding good reasoning would waste an entire sampled turn.",
	"The novelty measure should stay high whenever the author keeps naming new ideas rather than rephrasing one.",
	"Conversely a stall shows up as many paragraphs that together introduce almost no words the reader had seen.",
	"I want the guard to remain quiet during long but legitimate deliberation about a single hard design issue.",
	"Finally the threshold has to leave a wide margin so ordinary focused thinking never trips the detector ever.",
].join("\n\n\n");

/** Realistic per-file refactor assignments: heavy boilerplate (low novelty) but
 *  each names a distinct file + symbol — a NEW anchor every segment — so neither
 *  the trigram cluster nor the lexical-stall run ever reaches its threshold. */
function perFileTemplates(): string {
	const targets: [string, string][] = [
		["approval-mode.test.ts", "AgentSession"],
		["gh.test.ts", "TempDir"],
		["todo.test.ts", "renderResult"],
		["hook-editor.test.ts", "requestRender"],
		["mcp-client.test.ts", "McpSession"],
		["lsp-pool.test.ts", "LspWorker"],
		["dap-session.test.ts", "DapBridge"],
		["stats-sync.test.ts", "SyncWorker"],
	];
	return targets
		.map(
			([file, sym], i) =>
				`${i + 1}. Subagent Refactor${i}:\n  - target: packages/coding-agent/test/${file}\n  - assignment: Replace the ReturnType annotation in packages/coding-agent/test/${file} with the explicit type ${sym}. Verify where ${sym} is imported from, then run biome check write unsafe on the file.`,
		)
		.join("\n\n");
}

describe("ThinkingLoopDetector", () => {
	test("trips on a tight near-duplicate paragraph loop via the trigram path", () => {
		// High word-trigram overlap: the cluster check claims it before the lexical
		// path, so the reason names near-identical segments.
		expect(feed(tightDuplicateLoop(12))).toContain("near-identical segments");
	});

	test("trips on a reworded progress-lexicon stall with varied bold titles", () => {
		// The reported reasoning-summarizer loop. Word order keeps changing (trigrams
		// never cluster); only the recycled vocabulary betrays the stall. The bold
		// titles must be stripped — left in, their fresh wording would inflate
		// novelty and hide the loop.
		expect(feed(progressLexiconLoop())).toContain("low-information");
	});

	test("trips on a sustained stall fixated on one unchanging reference", () => {
		// Repeating one path every paragraph is not progress: a fixed anchor is never
		// a NEW anchor, so the run is not reset.
		expect(feed(fixedAnchorStall(12))).toContain("low-information");
	});

	test("trips on verbatim back-to-back repetition", () => {
		const detector = new ThinkingLoopDetector();
		const detail = detector.push("🌊 ".repeat(120));
		expect(detail).toContain("back-to-back");
	});

	test("does not trip on genuinely distinct reasoning paragraphs", () => {
		const detector = new ThinkingLoopDetector();
		let detail: string | null = null;
		const text = distinctReasoning();
		for (let i = 0; i < text.length && !detail; i += 23) {
			detail = detector.push(text.slice(i, i + 23));
		}
		// flush the trailing paragraph too
		detail ??= detector.flush();
		expect(detail).toBeNull();
	});

	test("does not collapse distinct per-file assignment templates into a loop", () => {
		// Eight near-identical templated assignments: heavy boilerplate (low novelty)
		// but each names a distinct file + symbol — a NEW anchor every segment — so
		// neither the trigram cluster nor the lexical-stall run reaches its threshold.
		expect(feed(perFileTemplates(), 37)).toBeNull();
	});

	test("does not trip on focused single-file debugging that keeps advancing", () => {
		// The same path appears in every paragraph, but each makes a genuinely new
		// observation, so novelty stays high and the stall run never builds.
		expect(feed(FOCUSED_SINGLE_FILE, 23)).toBeNull();
	});

	test("does not trip on anchor-free single-topic deliberation", () => {
		// No code identifiers at all: the novelty gate alone must keep real,
		// advancing reasoning from tripping.
		expect(feed(ANCHOR_FREE_DELIBERATION, 23)).toBeNull();
	});

	test("flush() catches a final unterminated duplicate paragraph", () => {
		const detector = new ThinkingLoopDetector();
		// Seven blank-line-separated dupes leave the eighth (cluster-completing)
		// paragraph in the buffer with no trailing blank line.
		const block = `${nearDuplicateLoop(7)}\n\n\nI am now verifying the test module to guarantee there are no compile errors and the code is completely safe.`;
		expect(detector.push(block)).toBeNull();
		expect(detector.flush()).toContain("near-identical segments");
	});

	test("does not trip on legitimate repetitive numeric output", () => {
		// A zero-page hexdump is highly repetitive but legitimate: a unit with no
		// letter or pictograph must never count as a loop.
		const detector = new ThinkingLoopDetector();
		expect(detector.push("00 ".repeat(200))).toBeNull();
	});

	test("does not trip on short requested repetitive text", () => {
		// Below the repeated-char floor: a brief on-purpose repeat is not a loop.
		const detector = new ThinkingLoopDetector();
		expect(detector.push("🌊 ".repeat(26))).toBeNull();
	});
});

describe("thinking-loop guard (stream wrapper)", () => {
	function loopingThinkingResponse(): { content: MockContent[] } {
		return { content: [{ type: "thinking", thinking: nearDuplicateLoop(12) }] };
	}

	for (const { label, provider, id } of [
		{ label: "Gemini", provider: "openrouter", id: "google/gemini-3.5-flash" },
		{ label: "Grok 4.6", provider: "xai", id: "grok-4-6" },
	]) {
		test(`terminates a ${label} loop with a retryable empty-content error`, async () => {
			registerMockApi();
			try {
				const mock = createMockModel({ provider, id });
				mock.push(loopingThinkingResponse());

				const result = await stream(mock.model, context()).result();

				expect(result.stopReason).toBe("error");
				expect(result.content).toEqual([]);
				expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
				expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
				// Empty content + transient phrasing is what makes the turn auto-retry.
				expect(result.errorMessage).toContain("stream stall");
				expect(isRetryableError(new Error(result.errorMessage))).toBe(true);
			} finally {
				clearCustomApis();
			}
		});
	}

	test("drops the failed attempt from the terminal after a loop is detected", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			mock.push(loopingThinkingResponse());

			const events = await collect(stream(mock.model, context()));
			const terminal = events.at(-1);
			expect(terminal?.type).toBe("error");
			// A prefix can stream before detection, but the failed terminal must not
			// carry replayable content or forward the normal completion boundary.
			expect(events.some(e => e.type === "thinking_end")).toBe(false);
			expect(events.some(e => e.type === "done")).toBe(false);
			if (terminal?.type === "error") expect(terminal.error.content).toEqual([]);
		} finally {
			clearCustomApis();
		}
	});

	test("passes a non-gemini model through untouched even when it loops", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openai", id: "gpt-5.5" });
			mock.push(loopingThinkingResponse());

			const result = await stream(mock.model, context()).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content.some(b => b.type === "thinking")).toBe(true);
		} finally {
			clearCustomApis();
		}
	});

	test("terminates the observed long-cycle Kiro text runaway", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "kiro", id: "gpt-5-6-sol" });
			mock.push({ content: [`Healthy lead sentence. ${OBSERVED_KIRO_CYCLE.repeat(6)}`] });

			const result = await stream(mock.model, context()).result();

			expect(result.stopReason).toBe("error");
			expect(result.content).toEqual([]);
			expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
			expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		} finally {
			clearCustomApis();
		}
	});

	test("detects the Kiro cycle across token-sized synthetic-provider deltas", async () => {
		const model = {
			api: "openai-completions",
			provider: "synthetic",
			id: "gpt-5-6-sol",
			name: "GPT 5.6 Sol",
			baseUrl: "https://unused.example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		} as Model<"openai-completions">;
		const text = `Healthy lead sentence. ${OBSERVED_KIRO_CYCLE.repeat(6)}`;
		const fetch = async (): Promise<Response> => {
			const events: string[] = [];
			for (let i = 0; i < text.length; i += 23) {
				events.push(
					JSON.stringify({
						id: "cycle",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: { content: text.slice(i, i + 23) } }],
					}),
				);
			}
			events.push(
				JSON.stringify({
					id: "cycle",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				}),
				"[DONE]",
			);
			return new Response(`${events.map(event => `data: ${event}`).join("\n\n")}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		};

		const events = await collect(streamSimple(model, context(), { apiKey: "test", fetch }));
		const terminal = events.at(-1);

		expect(events.some(event => event.type === "text_delta")).toBe(true);
		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") throw new Error("expected loop error terminal");
		expect(terminal.error.content).toEqual([]);
		expect(AIError.is(terminal.error.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
	});

	test("does not trip on a healthy gemini turn that reasons then answers", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			mock.push({ content: [{ type: "thinking", thinking: distinctReasoning() }, "Here is the final answer."] });

			const result = await stream(mock.model, context()).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content.some(b => b.type === "text")).toBe(true);
		} finally {
			clearCustomApis();
		}
	});

	test("does not retry once a loop re-emerges after visible answer text (armed latch)", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			// Healthy reasoning, then visible answer text, then a runaway loop re-emitted
			// as cumulative reasoning after `</think>` (the openai-completions shape).
			mock.push({
				content: [
					{ type: "thinking", thinking: distinctReasoning() },
					"Here is the final answer.",
					{ type: "thinking", thinking: nearDuplicateLoop(12) },
				],
			});

			const result = await stream(mock.model, context()).result();

			// Visible text already streamed, so the loop must NOT hijack the turn.
			expect(result.stopReason).toBe("stop");
			expect(result.content.some(b => b.type === "text")).toBe(true);
		} finally {
			clearCustomApis();
		}
	});

	test("guards the streamSimple custom-api path (agent default entrypoint)", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			mock.push(loopingThinkingResponse());

			const result = await streamSimple(mock.model, context()).result();

			expect(result.stopReason).toBe("error");
			expect(result.content).toEqual([]);
			expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
			expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
			expect(isRetryableError(new Error(result.errorMessage))).toBe(true);
		} finally {
			clearCustomApis();
		}
	});
});

describe("withThinkingLoopGuard (Vertex transport)", () => {
	test("emits a retryable empty-content error for a looping Vertex Gemini stream", async () => {
		const model = {
			api: "google-vertex",
			provider: "google-vertex",
			id: "gemini-2.5-pro",
			identity: classifyModel("google-vertex", "gemini-2.5-pro"),
		} as unknown as Model<Api>;
		const partial = { role: "assistant", content: [] } as unknown as AssistantMessage;

		const guarded = withThinkingLoopGuard(model, undefined, () => {
			const inner = new AssistantMessageEventStream();
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial },
				{ type: "thinking_start", contentIndex: 0, partial },
				{ type: "thinking_delta", contentIndex: 0, delta: nearDuplicateLoop(12), partial },
				{ type: "thinking_end", contentIndex: 0, content: "", partial },
				{ type: "done", reason: "stop", message: partial },
			];
			for (const event of events) inner.push(event);
			return inner;
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(result.content.length).toBe(0);
		expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
		expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(isRetryableError(new Error(result.errorMessage))).toBe(true);
	});
});

describe("withThinkingLoopGuard (thinking after toolcall)", () => {
	test("trips on a thinking loop that continues after toolcall_start", async () => {
		const model = {
			api: "openai-responses",
			provider: "xai-oauth",
			id: "grok-4.6",
			identity: classifyModel("xai-oauth", "grok-4.6"),
		} as unknown as Model<Api>;
		const partial = { role: "assistant", content: [] } as unknown as AssistantMessage;

		const guarded = withThinkingLoopGuard(model, undefined, () => {
			const inner = new AssistantMessageEventStream();
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial },
				{ type: "thinking_start", contentIndex: 0, partial },
				{ type: "thinking_delta", contentIndex: 0, delta: "I'll search the cargo gate next.\n\n", partial },
				{ type: "toolcall_start", contentIndex: 1, partial },
				{ type: "thinking_delta", contentIndex: 0, delta: nearDuplicateLoop(12), partial },
				{ type: "thinking_end", contentIndex: 0, content: "", partial },
				{ type: "done", reason: "stop", message: partial },
			];
			for (const event of events) inner.push(event);
			inner.end({ ...partial, stopReason: "stop" });
			return inner;
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
		expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
	});

	test("re-arms thinking after thinking_end when more reasoning arrives after a tool call", async () => {
		const model = {
			api: "openai-responses",
			provider: "xai-oauth",
			id: "grok-4.6",
			identity: classifyModel("xai-oauth", "grok-4.6"),
		} as unknown as Model<Api>;
		const partial = { role: "assistant", content: [] } as unknown as AssistantMessage;

		const guarded = withThinkingLoopGuard(model, undefined, () => {
			const inner = new AssistantMessageEventStream();
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial },
				{ type: "thinking_start", contentIndex: 0, partial },
				{ type: "thinking_delta", contentIndex: 0, delta: "I'll read the thumper cargo function.\n\n", partial },
				{ type: "thinking_end", contentIndex: 0, content: "", partial },
				{ type: "toolcall_start", contentIndex: 1, partial },
				{ type: "thinking_start", contentIndex: 2, partial },
				{ type: "thinking_delta", contentIndex: 2, delta: nearDuplicateLoop(12), partial },
				{ type: "thinking_end", contentIndex: 2, content: "", partial },
				{ type: "done", reason: "stop", message: partial },
			];
			for (const event of events) inner.push(event);
			inner.end({ ...partial, stopReason: "stop" });
			return inner;
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
	});

	test("does not re-arm thinking after visible answer text even if a tool call already started", async () => {
		const model = {
			api: "openai-responses",
			provider: "xai-oauth",
			id: "grok-4.6",
			identity: classifyModel("xai-oauth", "grok-4.6"),
		} as unknown as Model<Api>;
		const partial = { role: "assistant", content: [] } as unknown as AssistantMessage;

		const guarded = withThinkingLoopGuard(model, undefined, () => {
			const inner = new AssistantMessageEventStream();
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial },
				{ type: "toolcall_start", contentIndex: 0, partial },
				{ type: "text_start", contentIndex: 1, partial },
				{ type: "text_delta", contentIndex: 1, delta: "Here is the final answer.", partial },
				{ type: "thinking_start", contentIndex: 2, partial },
				{ type: "thinking_delta", contentIndex: 2, delta: nearDuplicateLoop(12), partial },
				{ type: "thinking_end", contentIndex: 2, content: "", partial },
				{ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } },
			];
			for (const event of events) inner.push(event);
			inner.end({ ...partial, stopReason: "stop" });
			return inner;
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("stop");
	});

	test("does not latch thinking off on text_start before any visible answer text", async () => {
		const model = {
			api: "openai-responses",
			provider: "xai-oauth",
			id: "grok-4.6",
			identity: classifyModel("xai-oauth", "grok-4.6"),
		} as unknown as Model<Api>;
		const partial = { role: "assistant", content: [] } as unknown as AssistantMessage;

		const guarded = withThinkingLoopGuard(model, undefined, () => {
			const inner = new AssistantMessageEventStream();
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial },
				{ type: "toolcall_start", contentIndex: 0, partial },
				{ type: "text_start", contentIndex: 1, partial },
				{ type: "thinking_start", contentIndex: 2, partial },
				{ type: "thinking_delta", contentIndex: 2, delta: nearDuplicateLoop(12), partial },
				{ type: "thinking_end", contentIndex: 2, content: "", partial },
				{ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } },
			];
			for (const event of events) inner.push(event);
			inner.end({ ...partial, stopReason: "stop" });
			return inner;
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
		expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
	});
});

describe("isLoopGuardedModel", () => {
	test("guards models with Gemini, DeepSeek, and xAI structured identity", () => {
		const gemini = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" }).model;
		const deepseek = createMockModel({ provider: "deepseek", id: "deepseek-reasoner" }).model;
		const grok46 = createMockModel({ provider: "venice", id: "grok-4-6" }).model;
		const cursorGrok46 = createMockModel({ provider: "cursor", id: "cursor-grok-4.6-high" }).model;
		const grok460 = createMockModel({ provider: "venice", id: "grok-4.60" }).model;
		const grok45 = createMockModel({ provider: "cursor", id: "cursor-grok-4.5-high" }).model;
		const opaqueDeepseek = createMockModel({ provider: "deepseek", id: "opaque-model" }).model;
		const other = createMockModel({ provider: "openai", id: "gpt-4o" }).model;
		const openaiNamespacedGemini = createMockModel({ provider: "custom", id: "openai/gemini-pro" }).model;
		const openaiNamespacedDeepseek = createMockModel({ provider: "custom", id: "openai/deepseek-r1" }).model;
		const openaiNamespacedGrok = createMockModel({ provider: "custom", id: "openai/grok-4.6" }).model;

		expect(isLoopGuardedModel(gemini)).toBe(true);
		expect(isLoopGuardedModel(deepseek)).toBe(true);
		expect(isLoopGuardedModel(grok46)).toBe(true);
		// Cursor's wrapped per-tier Grok ids carry structured xai identity
		// (`taxonomy/xai.kdl` cursor-grok- prefix), so the guard applies.
		expect(isLoopGuardedModel(cursorGrok46)).toBe(true);
		expect(isLoopGuardedModel(grok460)).toBe(true);
		expect(isLoopGuardedModel(grok45)).toBe(true);
		expect(isLoopGuardedModel(opaqueDeepseek)).toBe(false);
		expect(isLoopGuardedModel(other)).toBe(false);

		expect(isLoopGuardedModel(openaiNamespacedGemini)).toBe(true);
		expect(isLoopGuardedModel(openaiNamespacedDeepseek)).toBe(true);
		expect(isLoopGuardedModel(openaiNamespacedGrok)).toBe(true);
		// enabled: false disables every guarded family.
		expect(isLoopGuardedModel(gemini, { loopGuard: { enabled: false } })).toBe(false);
		expect(isLoopGuardedModel(deepseek, { loopGuard: { enabled: false } })).toBe(false);
		expect(isLoopGuardedModel(grok45, { loopGuard: { enabled: false } })).toBe(false);

		// enabled: true does not opt unrelated models into the guard.
		expect(isLoopGuardedModel(other, { loopGuard: { enabled: true } })).toBe(false);
	});
});

describe("loop guard assistant prose/text loops", () => {
	test("trips on assistant text/prose loop when checkAssistantContent is enabled", async () => {
		const model = {
			api: "openai-completions",
			provider: "deepseek",
			id: "deepseek-reasoner",
			identity: classifyModel("deepseek", "deepseek-reasoner"),
		} as unknown as Model<Api>;
		const partial = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;
		const options = { loopGuard: { checkAssistantContent: true } };

		const guarded = withThinkingLoopGuard(model, options, () => {
			const inner = new AssistantMessageEventStream();
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial },
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "text_delta", contentIndex: 0, delta: "First healthy text sentence. ", partial },
				{ type: "text_delta", contentIndex: 0, delta: nearDuplicateLoop(12), partial },
				{ type: "done", reason: "stop", message: partial },
			];
			for (const event of events) inner.push(event);
			inner.end({ ...partial, stopReason: "stop" });
			return inner;
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		// Loop-guard output is replay garbage even when it came through text_delta:
		// drop it so AgentSession can retry with a clean assistant turn.
		expect(result.content).toEqual([]);
		expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
		expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(result.errorMessage).toContain("stream stall");
		expect(isRetryableError(new Error(result.errorMessage))).toBe(true);
	});

	test("does not trip on assistant text loop when checkAssistantContent is false", async () => {
		const model = {
			api: "openai-completions",
			provider: "deepseek",
			id: "deepseek-reasoner",
			identity: classifyModel("deepseek", "deepseek-reasoner"),
		} as unknown as Model<Api>;
		const partial = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;
		const options = { loopGuard: { checkAssistantContent: false } };

		const guarded = withThinkingLoopGuard(model, options, () => {
			const inner = new AssistantMessageEventStream();
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial },
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "text_delta", contentIndex: 0, delta: nearDuplicateLoop(12), partial },
				{ type: "done", reason: "stop", message: partial },
			];
			for (const event of events) inner.push(event);
			inner.end({ ...partial, stopReason: "stop" });
			return inner;
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("stop");
	});
});

/** Stream `text` through a fresh header detector in small chunks; returns true if
 *  the consecutive-header run tripped the runaway threshold. */
function feedHeaders(text: string, step = 13): boolean {
	const detector = new GeminiHeaderRunDetector();
	for (let i = 0; i < text.length; i += step) {
		if (detector.push(text.slice(i, i + step))) return true;
	}
	return false;
}

/** A genuinely-distinct planning runaway: each thought summary introduces a new
 *  title + a paragraph naming fresh code anchors, so it never trips the
 *  similarity/lexicon loop guard — only the header-count guard catches it. */
function distinctPlanningRunaway(headers: number): string {
	const out: string[] = [];
	for (let i = 0; i < headers; i++) {
		out.push(
			`**Refining Stage ${i}**\n\nI am now reworking module_${i} so that handler_${i} routes Stage${i}Result through render_${i}.`,
		);
	}
	return out.join("\n\n");
}

describe("isReasoningSummaryHeader", () => {
	test("matches markdown and whole-line bold titles", () => {
		expect(isReasoningSummaryHeader("## Examining Result Handling")).toBe(true);
		expect(isReasoningSummaryHeader("### Refining Grammar Expansion")).toBe(true);
		expect(isReasoningSummaryHeader("**Defining ApplyResult Details**")).toBe(true);
		expect(isReasoningSummaryHeader("***Adapting Renderer***")).toBe(true);
	});

	test("rejects prose, inline emphasis, and bare markers", () => {
		expect(isReasoningSummaryHeader("I'm now incorporating **targetPath** into the result.")).toBe(false);
		expect(isReasoningSummaryHeader("**bold start** but the rest is prose")).toBe(false);
		expect(isReasoningSummaryHeader("*single asterisk italic*")).toBe(false);
		expect(isReasoningSummaryHeader("#hashtag-not-a-heading")).toBe(false);
		expect(isReasoningSummaryHeader("plain reasoning line")).toBe(false);
	});
});

describe("GeminiHeaderRunDetector", () => {
	test("trips on a distinct planning runaway the loop guard misses", () => {
		const runaway = distinctPlanningRunaway(GEMINI_HEADER_RUNAWAY_THRESHOLD + 2);
		// The existing similarity/lexicon guard does NOT fire on distinct progress...
		expect(feed(runaway)).toBeNull();
		// ...but the header-count guard does.
		expect(feedHeaders(runaway)).toBe(true);
	});

	test("does not trip on a legitimate 10-header debugging block (regression)", () => {
		// A real, productive debugging stretch emitted 10 distinct progressing headers; never interrupt that.
		expect(feedHeaders(distinctPlanningRunaway(10))).toBe(false);
		expect(feedHeaders(distinctPlanningRunaway(24))).toBe(true);
	});

	test("counts headers across intervening paragraphs (one summary = one header)", () => {
		const detector = new GeminiHeaderRunDetector();
		let tripped = false;
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD; i++) {
			tripped = detector.push(`**Summary ${i}**\n`) || detector.push("Some distinct reasoning paragraph here.\n\n");
			if (tripped) break;
		}
		expect(tripped).toBe(true);
		expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);
	});

	test("does not trip below the threshold", () => {
		expect(feedHeaders(distinctPlanningRunaway(GEMINI_HEADER_RUNAWAY_THRESHOLD - 1))).toBe(false);
	});

	test("does not count plain reasoning paragraphs as headers", () => {
		expect(feedHeaders(distinctReasoning())).toBe(false);
	});

	test("fires once per run then stays quiet until reset re-arms it", () => {
		const detector = new GeminiHeaderRunDetector();
		const runaway = distinctPlanningRunaway(GEMINI_HEADER_RUNAWAY_THRESHOLD);
		expect(detector.push(runaway)).toBe(true);
		// Latched: more headers on the same run do not re-fire.
		expect(detector.push("**Another Header**\n")).toBe(false);
		// A new reasoning block re-arms the detector.
		detector.reset();
		expect(detector.count).toBe(0);
		expect(detector.push(runaway)).toBe(true);
	});
});

describe("thinking-loop retry budget (result path)", () => {
	function loopResponse(): { content: MockContent[] } {
		return { content: [{ type: "thinking", thinking: nearDuplicateLoop(12) }] };
	}

	test("completeSimple fails closed after three guarded attempts", async () => {
		registerMockApi();
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			for (let i = 0; i < 4; i++) mock.push(loopResponse());
			const attempts: AssistantMessage[] = [];

			const result = await completeSimple(mock.model, context(), { onAttempt: message => attempts.push(message) });

			expect(mock.calls).toHaveLength(3);
			expect(attempts).toHaveLength(3);
			expect(result.stopReason).toBe("error");
			expect(result.content).toEqual([]);
			expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
			expect(mock.calls.every(call => call.options?.loopGuard?.enabled !== false)).toBe(true);
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});

	test("complete (non-simple) also fails closed after three guarded attempts", async () => {
		registerMockApi();
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			for (let i = 0; i < 4; i++) mock.push(loopResponse());

			const result = await complete(mock.model, context());

			expect(mock.calls).toHaveLength(3);
			expect(result.stopReason).toBe("error");
			expect(result.content).toEqual([]);
			expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
			expect(mock.calls.every(call => call.options?.loopGuard?.enabled !== false)).toBe(true);
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});

	test("a caller abort during backoff rejects instead of returning the stall", async () => {
		registerMockApi();
		const controller = new AbortController();
		const waitSpy = spyOn(scheduler, "wait").mockImplementation(async (_delay, opts) => {
			controller.abort(new Error("user cancelled"));
			opts?.signal?.throwIfAborted();
		});
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			mock.push(loopResponse());

			await expect(completeSimple(mock.model, context(), { signal: controller.signal })).rejects.toThrow(
				"user cancelled",
			);
			// Only the first guarded attempt ran; the abort pre-empted re-sampling.
			expect(mock.calls).toHaveLength(1);
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});

	test("a caller abort after the third guarded result supersedes the loop error", async () => {
		registerMockApi();
		const controller = new AbortController();
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			let attempts = 0;
			const mock = createMockModel({
				provider: "openrouter",
				id: "google/gemini-3.5-flash",
				handler: () => {
					if (++attempts === 3) controller.abort(new Error("cancelled after final result"));
					return loopResponse();
				},
			});

			await expect(completeSimple(mock.model, context(), { signal: controller.signal })).rejects.toThrow(
				"cancelled after final result",
			);
			expect(mock.calls).toHaveLength(3);
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});

	test("does not retry a contentful ThinkingLoop error (replay-unsafe output)", async () => {
		const api = "contentful-loop-test";
		let calls = 0;
		const model = {
			api,
			provider: "test",
			id: "test-model",
			name: "Test model",
			baseUrl: "test://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000,
			maxTokens: 100,
		} as unknown as Model<Api>;
		registerCustomApi(api, () => {
			calls++;
			const inner = new AssistantMessageEventStream();
			const error: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Looping visible reasoning garbage." }],
				api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: `${THINKING_LOOP_ERROR_MARKER}: already streamed, non-retryable`,
				errorId: AIError.create(AIError.Flag.ThinkingLoop),
				timestamp: Date.now(),
			};
			inner.push({ type: "error", reason: "error", error });
			return inner;
		});
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const result = await completeSimple(model, context());

			expect(calls).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.content).toHaveLength(1);
			expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});
});
