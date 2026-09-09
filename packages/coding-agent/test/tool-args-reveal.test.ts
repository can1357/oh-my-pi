import { afterEach, describe, expect, it, vi } from "bun:test";
import { STREAMING_REVEAL_FRAME_MS } from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import {
	decodeStreamedToolArgs,
	streamingStringKeysForTool,
	ToolArgsRevealController,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/tool-args-reveal";
import { STREAMING_JSON_PARSE_MIN_GROWTH } from "@oh-my-pi/pi-utils";

class RecordingArgsComponent {
	frames: Array<Record<string, unknown>> = [];

	updateArgs(args: unknown): void {
		this.frames.push(args as Record<string, unknown>);
	}

	// Component protocol stub — the reveal controller hands the component
	// straight to `requestComponentRender`, which only exercises identity.
	render(): readonly string[] {
		return [];
	}
}

function makeController(options: { smooth?: boolean; requestRender?: () => void } = {}) {
	const component = new RecordingArgsComponent();
	const controller = new ToolArgsRevealController({
		getSmoothStreaming: () => options.smooth ?? true,
		requestRender: options.requestRender ?? (() => {}),
	});
	return { component, controller };
}

function partialOf(frame: Record<string, unknown>): string {
	const partial = frame.__partialJson;
	if (typeof partial !== "string") {
		throw new Error("Expected __partialJson string on revealed frame");
	}
	return partial;
}

function drain(frames: number): void {
	for (let i = 0; i < frames; i++) {
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
	}
}

function jsonTarget(options: { exposeRawPartialJson?: boolean; streamingStringKeys?: readonly string[] } = {}) {
	return {
		rawInput: false,
		exposeRawPartialJson: options.exposeRawPartialJson ?? false,
		streamingStringKeys: options.streamingStringKeys,
	};
}

function rawTarget() {
	return { rawInput: true, exposeRawPartialJson: true };
}

describe("tool args reveal", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("passes the bound component to requestRender on each rendered tick", () => {
		// Each entry's component reference is handed to `requestRender` so the
		// caller scopes the render to that tool block's subtree via
		// `TUI.requestComponentRender` (issue #4377).
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ requestRender });
		const content = "x".repeat(400);
		const target = `{"path":"a.ts","content":"${content}"}`;

		controller.setTarget("call-1", target.slice(0, 12), jsonTarget({ exposeRawPartialJson: true }));
		controller.bind("call-1", component);
		controller.setTarget("call-1", target, jsonTarget({ exposeRawPartialJson: true }));
		drain(80);

		expect(requestRender).toHaveBeenCalled();
		for (const call of requestRender.mock.calls) {
			expect(call[0]).toBe(component);
		}
	});

	it("reveals what already arrived on the first setTarget call", () => {
		const { controller } = makeController();
		const target = `{"path":"a.ts","content":"abc"}`;

		const initial = controller.setTarget("call-1", target, jsonTarget({ exposeRawPartialJson: true }));

		// The provider already delivered a complete partialJson chunk; the
		// controller MUST surface its parsed fields and raw prefix immediately —
		// pacing applies only to subsequent growth, never to bytes already in hand.
		expect(initial.path).toBe("a.ts");
		expect(initial.content).toBe("abc");
		expect(partialOf(initial)).toBe(target);
	});

	it("paces growth across successive setTarget calls for raw-prefix renderers", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const content = "line one\\nline two\\nline three of a streamed write payload";
		const target = `{"path":"a.ts","content":"${content}"}`;
		const seed = target.slice(0, 12);

		const initial = controller.setTarget("call-1", seed, jsonTarget({ exposeRawPartialJson: true }));
		// What arrived is exposed immediately, no empty initial frame.
		expect(partialOf(initial)).toBe(seed);
		controller.bind("call-1", component);

		// More bytes arrive later — the controller now paces the new backlog.
		controller.setTarget("call-1", target, jsonTarget({ exposeRawPartialJson: true }));
		drain(100);

		const partials = component.frames.map(partialOf);
		expect(partials.length).toBeGreaterThan(0);
		expect(partials.at(-1)).toBe(target);
		let previous = seed.length;
		for (const partial of partials) {
			expect(partial.length).toBeGreaterThanOrEqual(previous);
			expect(target.startsWith(partial)).toBe(true);
			previous = partial.length;
		}
	});

	it("throttles JSON re-parses for renderers that do not read raw partial JSON", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ requestRender });
		const target = `{"path":"a.ts","content":"${"x".repeat(1200)}"}`;
		const seed = target.slice(0, 10);

		// Seed: small initial slice, revealed immediately, sets parsedLen=seed.length.
		const initial = controller.setTarget("call-1", seed, jsonTarget());
		expect(partialOf(initial)).toBe(seed);
		controller.bind("call-1", component);

		// Full payload arrives; the controller paces the new growth.
		controller.setTarget("call-1", target, jsonTarget());
		expect(component.frames).toHaveLength(0);

		// First paced tick lands inside the small-prefix window
		// (< STREAMING_JSON_PARSE_MIN_GROWTH), so a re-parse is forced and a
		// frame fires.
		drain(1);
		expect(component.frames).toHaveLength(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
		const firstPartial = partialOf(component.frames[0]);

		// The next tick crosses into the throttled window: growth from the last
		// parse hasn't yet hit STREAMING_JSON_PARSE_MIN_GROWTH, so no frame fires.
		drain(1);
		expect(component.frames).toHaveLength(1);
		expect(requestRender).toHaveBeenCalledTimes(1);

		drain(3);
		expect(component.frames.length).toBeGreaterThan(1);
		const secondPartial = partialOf(component.frames[1]);
		expect(secondPartial.length - firstPartial.length).toBeGreaterThanOrEqual(STREAMING_JSON_PARSE_MIN_GROWTH);
	});

	it("refreshes parsed write content on raw-prefix frames below the JSON parse throttle", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const initialContent = "x".repeat(STREAMING_JSON_PARSE_MIN_GROWTH + 24);
		const appendedJsonContent = "line 1\\nline 2\\n";
		const appendedContent = "line 1\nline 2\n";
		const initial = `{"path":"a.ts","content":"${initialContent}`;
		const next = `${initial}${appendedJsonContent}`;

		const renderArgs = controller.setTarget(
			"call-1",
			initial,
			jsonTarget({ exposeRawPartialJson: true, streamingStringKeys: ["content"] }),
		);
		expect(renderArgs.content).toBe(initialContent);
		controller.bind("call-1", component);

		controller.setTarget(
			"call-1",
			next,
			jsonTarget({ exposeRawPartialJson: true, streamingStringKeys: ["content"] }),
		);
		drain(20);

		const latest = component.frames.at(-1);
		expect(latest).toBeDefined();
		expect(partialOf(latest!)).toBe(next);
		expect(latest!.content).toBe(`${initialContent}${appendedContent}`);
	});

	it("extracts multiple string keys concurrently across throttled JSON parses", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		// Two long fields (edit-style `input`, write-style `content`) inside the
		// same JSON. A sub-throttle append must refresh BOTH decoded values on the
		// next reveal frame — proving the extractor generalizes past `content`.
		const initialInput = "y".repeat(STREAMING_JSON_PARSE_MIN_GROWTH + 8);
		const initialContent = "x".repeat(STREAMING_JSON_PARSE_MIN_GROWTH + 16);
		const initial = `{"input":"${initialInput}","content":"${initialContent}`;
		const appendedContent = "tail";
		const next = `${initial}${appendedContent}`;

		const streamingStringKeys = ["input", "content"];
		const renderArgs = controller.setTarget(
			"call-1",
			initial,
			jsonTarget({ exposeRawPartialJson: true, streamingStringKeys }),
		);
		expect(renderArgs.input).toBe(initialInput);
		expect(renderArgs.content).toBe(initialContent);
		controller.bind("call-1", component);

		controller.setTarget("call-1", next, jsonTarget({ exposeRawPartialJson: true, streamingStringKeys }));
		drain(20);

		const latest = component.frames.at(-1);
		expect(latest).toBeDefined();
		expect(latest!.input).toBe(initialInput);
		expect(latest!.content).toBe(`${initialContent}${appendedContent}`);
	});

	it("ignores streaming string keys nested below the top level", () => {
		vi.useFakeTimers();
		const { controller } = makeController({ smooth: false });
		const streamingStringKeys = ["content"];

		// Prefix ends inside the nested object: the nested "content" key must
		// NOT be captured and injected as a top-level preview arg.
		const nestedOnly = `{"meta":{"content":"NESTED"`;
		const first = controller.setTarget("call-1", nestedOnly, jsonTarget({ streamingStringKeys }));
		expect(first.content).toBeUndefined();

		// Growth past the nested object: the real top-level key must be captured.
		const full = `${nestedOnly}"},"content":"real"}`;
		const second = controller.setTarget("call-1", full, jsonTarget({ streamingStringKeys }));
		expect(second.content).toBe("real");

		// Reverse order: a nested duplicate arriving AFTER the top-level key must
		// not reset/overwrite the captured top-level value. Extractor values are
		// merged over the parsed args, so a depth-blind capture would win here.
		const reversed = `{"content":"real","meta":{"content":"NESTED"}}`;
		const decoded = decodeStreamedToolArgs(reversed, { rawInput: false, streamingStringKeys });
		expect(decoded.content).toBe("real");
		expect(decoded.meta).toEqual({ content: "NESTED" });
	});

	it("decodes the full received buffer, unpaced, when smoothing is disabled", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ smooth: false, requestRender });
		const target = `{"path":"a.ts","content":"abc"}`;

		const renderArgs = controller.setTarget("call-1", target, jsonTarget());
		controller.bind("call-1", component);
		drain(10);

		// Display args come from a fresh decode of the buffer in hand — never a
		// provider-parsed snapshot that may lag the stream — and nothing paces.
		expect(renderArgs).toEqual({ path: "a.ts", content: "abc", __partialJson: target });
		expect(component.frames).toHaveLength(0);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("keeps streamed string fields fresh across sub-throttle growth when smoothing is disabled", () => {
		vi.useFakeTimers();
		const { controller } = makeController({ smooth: false });
		const initialContent = "x".repeat(STREAMING_JSON_PARSE_MIN_GROWTH + 24);
		const seed = `{"path":"a.ts","content":"${initialContent}`;
		// Growth below STREAMING_JSON_PARSE_MIN_GROWTH: a throttled re-parse
		// will not fire, so freshness must come from the string extractor.
		const grown = `${seed}tail`;
		const keys = streamingStringKeysForTool("write", false);

		const first = controller.setTarget("call-1", seed, jsonTarget({ streamingStringKeys: keys }));
		expect(first.content).toBe(initialContent);

		const second = controller.setTarget("call-1", grown, jsonTarget({ streamingStringKeys: keys }));
		expect(second.content).toBe(`${initialContent}tail`);
		expect(partialOf(second)).toBe(grown);
	});

	it("finish drops the reveal so no further frames are pushed", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const target = `{"path":"a.ts","content":"${"x".repeat(400)}"}`;
		const seed = target.slice(0, 5);

		controller.setTarget("call-1", seed, jsonTarget());
		controller.bind("call-1", component);
		// Backlog of new bytes for the reveal loop to advance through.
		controller.setTarget("call-1", target, jsonTarget());
		drain(1);
		const frames = component.frames.length;
		expect(frames).toBeGreaterThan(0);
		controller.finish("call-1");
		drain(10);

		expect(component.frames).toHaveLength(frames);
	});

	it("flushAll snaps live entries to the full received stream", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const target = `{"path":"a.ts","content":"${"x".repeat(500)}"}`;
		const seed = target.slice(0, 5);

		controller.setTarget("call-1", seed, jsonTarget());
		controller.bind("call-1", component);
		controller.setTarget("call-1", target, jsonTarget());
		drain(1);
		expect(partialOf(component.frames.at(-1)!).length).toBeLessThan(target.length);
		controller.flushAll();

		expect(partialOf(component.frames.at(-1)!)).toBe(target);
		const frames = component.frames.length;
		drain(10);
		expect(component.frames).toHaveLength(frames);
	});

	it("never splits a surrogate pair at a frame boundary", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const target = `{"content":"${"😀🎉".repeat(40)}"}`;
		const seed = target.slice(0, 12); // before any surrogate

		controller.setTarget("call-1", seed, jsonTarget({ exposeRawPartialJson: true }));
		controller.bind("call-1", component);
		controller.setTarget("call-1", target, jsonTarget({ exposeRawPartialJson: true }));
		drain(100);

		expect(partialOf(component.frames.at(-1)!)).toBe(target);
		for (const frame of component.frames) {
			expect(partialOf(frame).isWellFormed()).toBe(true);
		}
	});

	it("exposes custom raw-input streams as { input } without JSON parsing", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const target = "*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n*** End Patch";
		const seed = target.slice(0, 5);

		const initial = controller.setTarget("call-1", seed, rawTarget());
		expect(initial.input).toBe(seed);
		expect(partialOf(initial)).toBe(seed);
		controller.bind("call-1", component);
		controller.setTarget("call-1", target, rawTarget());
		drain(100);

		expect(component.frames.length).toBeGreaterThan(0);
		for (const frame of component.frames) {
			expect(frame.input).toBe(partialOf(frame));
		}
		expect(component.frames.at(-1)!.input).toBe(target);
	});

	describe("live/rebuild display-args identity", () => {
		// Contract: a transcript rebuild mid-stream (theme change, settings edit,
		// focus replay) MUST show exactly what the live preview shows. Both paths
		// decode the same raw buffer; the rebuild one-shot (decodeStreamedToolArgs)
		// and the live reveal (setTarget caught up to the buffer) must agree even
		// when the buffer grew past the last throttled full-JSON parse.
		it("matches for a mid-stream write whose content grew past the last throttled parse", () => {
			vi.useFakeTimers();
			const { component, controller } = makeController();
			const keys = streamingStringKeysForTool("write", false);
			const initialContent = `line 1\\nline 2\\n${"x".repeat(STREAMING_JSON_PARSE_MIN_GROWTH)}`;
			const seed = `{"path":"src/a.ts","content":"${initialContent}`;
			// Sub-throttle growth: the provider's own arguments parse has NOT rerun,
			// so a rebuild spreading provider args would still show only
			// initialContent. Includes an escape split across the growth boundary.
			const grown = `${seed}appended\\ntail`;

			// Live path: seed arrives, then grows; drain until the reveal catches up.
			const target = jsonTarget({ exposeRawPartialJson: true, streamingStringKeys: keys });
			controller.setTarget("call-1", seed, target);
			controller.bind("call-1", component);
			controller.setTarget("call-1", grown, target);
			drain(50);
			const live = component.frames.at(-1);
			expect(live).toBeDefined();
			expect(partialOf(live!)).toBe(grown);

			// Rebuild path: one-shot decode of the same buffer, seeded with the
			// provider's stale parsed arguments (as ui-helpers does).
			const staleProviderArgs = { path: "src/a.ts", content: initialContent };
			const rebuilt = decodeStreamedToolArgs(grown, {
				rawInput: false,
				fullArgs: staleProviderArgs,
				streamingStringKeys: keys,
			});

			expect(rebuilt).toEqual(live!);
			// Both must carry the grown content — decoded escapes included — not
			// the stale pre-throttle value.
			expect(rebuilt.content).toBe(`line 1\nline 2\n${"x".repeat(STREAMING_JSON_PARSE_MIN_GROWTH)}appended\ntail`);
		});

		it("matches for a custom raw-input stream", () => {
			const { controller } = makeController();
			const buffer = "*** Begin Patch\n*** Update File: a.ts\n-old\n+new";

			const live = controller.setTarget("call-1", buffer, rawTarget());
			const rebuilt = decodeStreamedToolArgs(buffer, { rawInput: true });

			expect(rebuilt).toEqual(live);
			expect(rebuilt.input).toBe(buffer);
		});

		it("stale provider args never override freshly decoded fields", () => {
			// fullArgs is an under-spread for dialect-projected keys a raw re-parse
			// cannot recover; any key the fresh decode recovers must win.
			const buffer = `{"path":"b.ts","content":"fresh body`;
			const rebuilt = decodeStreamedToolArgs(buffer, {
				rawInput: false,
				fullArgs: { path: "b.ts", content: "stale body", projected: true },
				streamingStringKeys: ["content"],
			});

			expect(rebuilt.content).toBe("fresh body");
			expect(rebuilt.projected).toBe(true);
			expect(rebuilt.path).toBe("b.ts");
		});
	});
});
