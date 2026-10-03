import { afterEach, describe, expect, it } from "bun:test";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { quietMotion, resetQuietMotion } from "@oh-my-pi/pi-tui/native/quiet";
import { nativeComponentId, Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import { setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import {
	DEFAULT_SPINNER_INTERVAL_MS,
	setSpinnerInterval,
	SPINNER_INTERVAL_STATIC,
	STATIC_SPINNER_GLYPH,
} from "@oh-my-pi/pi-tui/spinner-clock";
import type { Component } from "@oh-my-pi/pi-tui/tui";

const cx: DescribeContext = { cols: 60, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

/** A working row as the dock describes it: a terminal-clocked spinner, a pulsing badge, a plain label. */
function working(): NativeNode {
	return row(
		[
			node("spinner", { style: "starburst", tone: "accent", role: "omp.working.spin" }, undefined, "spin"),
			node("spinner", { label: [span("booting", "dim", { fx: "shimmer" })] }, undefined, "labelled"),
			text([span("●", "accent", { fx: "pulse" }), span(" running", "muted")], { role: "status" }),
			node("tool", {
				name: "find",
				title: "Find",
				status: "running",
				meta: [[span("scanning", "muted", { fx: "shimmer" })]],
			}),
			// Object-nested text (the agent chip's running tool) and non-span effect carriers (editor decorations).
			node("agent", {
				name: "SeqAudit",
				status: "running",
				tool: { name: "find", intent: [span("looking", "muted", { fx: "shimmer" })], age: 10 },
			}),
			node("editor", { text: "say /btw hi", decor: [{ from: 4, to: 8, s: "accent", fx: "shimmer" }] }),
			text("plain", { role: "plain" }),
		],
		{ role: "omp.working" },
	);
}

describe("quietMotion", () => {
	afterEach(() => {
		setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS);
		setMotionEffects(true);
		resetQuietMotion();
	});

	it("passes a description through untouched while spinners animate and effects are on", () => {
		const described = working();
		expect(quietMotion(described)).toBe(described);
	});

	it("stills native spinners to the frame-0 glyph with their label and common props kept", () => {
		setSpinnerInterval(SPINNER_INTERVAL_STATIC);
		const described = working();
		const before = described.c as NativeNode[];
		const quiet = quietMotion(described);
		expect(quiet).not.toBe(described);
		const [spin, labelled, pulse, tool, agent, editor, plain] = quiet.c as NativeNode[];
		expect(spin).toMatchObject({
			k: "text",
			key: "spin",
			p: { tone: "accent", role: "omp.working.spin", spans: [{ t: STATIC_SPINNER_GLYPH }] },
		});
		expect((spin!.p as { style?: unknown }).style).toBeUndefined();
		expect(labelled).toMatchObject({
			k: "text",
			p: { spans: [{ t: STATIC_SPINNER_GLYPH }, { t: " " }, { t: "booting", s: "dim", fx: "shimmer" }] },
		});
		// Effects stay on: the pulse and shimmer spans are not the spinner switch's business.
		expect(pulse).toBe(before[2]);
		expect(tool).toBe(before[3]);
		expect(agent).toBe(before[4]);
		expect(editor).toBe(before[5]);
		expect(plain).toBe(before[6]);
	});

	it("drops every fx — spans in lists, object-nested text, editor decorations — when decorative motion is off", () => {
		setMotionEffects(false);
		const described = working();
		const before = described.c as NativeNode[];
		const quiet = quietMotion(described);
		const [spin, labelled, pulse, tool, agent, editor, plain] = quiet.c as NativeNode[];
		// Spinners still animate: only the effects switch flipped.
		expect(spin).toBe(before[0]);
		expect(labelled).toMatchObject({ k: "spinner", p: { label: [{ t: "booting", s: "dim" }] } });
		expect((labelled!.p as { label: { fx?: unknown }[] }).label[0]!.fx).toBeUndefined();
		expect(pulse!.p).toEqual({
			role: "status",
			spans: [
				{ t: "●", s: "accent" },
				{ t: " running", s: "muted" },
			],
		});
		expect((tool!.p as { meta: unknown[][] }).meta[0]![0]).toEqual({ t: "scanning", s: "muted" });
		expect(agent!.p).toEqual({
			name: "SeqAudit",
			status: "running",
			tool: { name: "find", intent: [{ t: "looking", s: "muted" }], age: 10 },
		});
		expect(editor!.p).toEqual({ text: "say /btw hi", decor: [{ from: 4, to: 8, s: "accent" }] });
		expect(plain).toBe(before[6]);
	});

	it("memoizes per described node until a switch flips, so unchanged subtrees keep their identity", () => {
		setSpinnerInterval(SPINNER_INTERVAL_STATIC);
		const described = working();
		const first = quietMotion(described);
		expect(quietMotion(described)).toBe(first);
		setMotionEffects(false);
		resetQuietMotion();
		const second = quietMotion(described);
		expect(second).not.toBe(first);
		expect((second.c![2] as NativeNode).p).toEqual({
			role: "status",
			spans: [
				{ t: "●", s: "accent" },
				{ t: " running", s: "muted" },
			],
		});
	});

	it("is what the reconciler sends: a static spinner reaches the wire as text, not a spinner", () => {
		class Dock implements Component {
			render(): readonly string[] {
				return [];
			}
			describe(): NativeNode {
				return node("spinner", { style: "braille", label: "Thinking" }, undefined, "spin");
			}
		}
		const comp = new Dock();
		const regions = { main: [comp], dock: [], layer: [] };
		const animated = new TspDocument("s:t");
		expect(animated.applyFrame({ sf: "s:t", s: 1, ops: new Reconciler("s:t").reconcile(regions, cx) })).toEqual([]);
		expect(animated.get(nativeComponentId(comp))).toMatchObject({ k: "spinner", p: { style: "braille" } });

		setSpinnerInterval(SPINNER_INTERVAL_STATIC);
		const still = new TspDocument("s:t");
		expect(still.applyFrame({ sf: "s:t", s: 1, ops: new Reconciler("s:t").reconcile(regions, cx) })).toEqual([]);
		expect(still.get(nativeComponentId(comp))).toMatchObject({
			k: "text",
			p: { spans: [{ t: STATIC_SPINNER_GLYPH }, { t: " Thinking" }] },
		});
	});
});
