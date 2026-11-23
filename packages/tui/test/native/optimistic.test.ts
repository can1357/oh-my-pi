import { afterEach, describe, expect, it } from "bun:test";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TspHarness } from "./tsp-harness";

/** Markdown where the terminal renders it, else rows. */
class Note implements Component {
	text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(): readonly string[] {
		return [`rows: ${this.text}`];
	}
	describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("md") ? md(this.text) : null;
	}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

const verbs = (h: TspHarness): string[] => h.terminal.log.map(message => message.verb);

describe("optimistic native start (TERM_PROGRAM=tern)", () => {
	it("opens the surface on the very first frame, before the hello reply, even for a deferred-input prepaint", async () => {
		const note = new Note("hello");
		harness = await TspHarness.start(tui => tui.addChild(note), {
			expected: true,
			manualProbe: true,
			deferInput: true,
		});
		const h = harness;
		expect(h.terminal.tspProbePending).toBe(true);
		expect(verbs(h)[0]).toBe("o");
		expect(verbs(h)).toContain("f");
		expect(Bun.stripANSI(h.terminal.rowBytes).trim()).toBe("");
		expect(isNativeRendering()).toBe(true);
		expect(h.byId(nativeComponentId(note))).toMatchObject({ k: "md", p: { text: "hello" } });
		expect(h.errors).toEqual([]);
	});

	it("applies the real reply's capabilities when it arrives", async () => {
		const note = new Note("hello");
		harness = await TspHarness.start(tui => tui.addChild(note), {
			expected: true,
			manualProbe: true,
			autoAck: false,
		});
		const h = harness;
		h.terminal.ackAll();
		h.flush();
		const surface = h.terminal.surface;
		h.terminal.answerProbe({ kinds: ["col", "text", "rows"], credits: 1 });
		h.flush();
		// Same surface, the unsupported kind re-described as rows.
		expect(h.terminal.surface).toBe(surface);
		expect(verbs(h).filter(verb => verb === "o")).toHaveLength(1);
		expect(h.byId(nativeComponentId(note))).toMatchObject({ k: "rows", p: { lines: ["rows: hello"] } });
		// One credit now: a second change waits for the ack.
		h.terminal.ackAll();
		h.flush();
		const sent = h.frames.length;
		note.text = "one";
		await h.render();
		note.text = "two";
		await h.render();
		expect(h.frames.length).toBe(sent + 1);
		expect(h.errors).toEqual([]);
	});

	it("falls back to rows when no reply arrives by the deadline, but not because of an event-loop stall", async () => {
		const note = new Note("hello");
		harness = await TspHarness.start(tui => tui.addChild(note), { expected: true, manualProbe: true });
		const h = harness;
		// Module loading blocks the loop past the deadline with the reply already queued.
		h.stall(3000);
		expect(isNativeRendering()).toBe(true);
		h.terminal.answerProbe();
		h.flush();
		expect(isNativeRendering()).toBe(true);
		expect(verbs(h)).not.toContain("x");
		h.stop();

		harness = await TspHarness.start(tui => tui.addChild(new Note("silent")), {
			expected: true,
			manualProbe: true,
		});
		const silent = harness;
		silent.flush(999);
		expect(isNativeRendering()).toBe(true);
		silent.flush(1000);
		expect(isNativeRendering()).toBe(false);
		expect(silent.terminal.log.at(-1)).toEqual({ verb: "x", body: { id: "s:1", keep: false } });
		expect(silent.terminal.surface).toBeUndefined();
		expect(silent.terminal.rowBytes).toContain("rows: silent");
	});

	it("falls back at once when the terminal answers DA1 without a hello reply", async () => {
		harness = await TspHarness.start(tui => tui.addChild(new Note("plain")), {
			expected: true,
			manualProbe: true,
			reply: false,
		});
		const h = harness;
		expect(verbs(h)[0]).toBe("o");
		h.terminal.answerProbe();
		h.flush();
		expect(isNativeRendering()).toBe(false);
		expect(h.terminal.surface).toBeUndefined();
		expect(h.terminal.rowBytes).toContain("rows: plain");
	});
});
