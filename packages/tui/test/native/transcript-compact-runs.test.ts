import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type CompactTranscriptBlock, TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { col, text, withHidden } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import type { TspNode, TspOp } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
	setNativeRendering(false);
});

/** A one-line block that describes itself, records native toggles, and flips compact or hidden. */
class Line implements Component, CompactTranscriptBlock {
	compact: boolean;
	hidden = false;
	readonly toggles: boolean[] = [];
	readonly #label: string;
	readonly #shown: NativeNode;
	readonly #hiddenNode: NativeNode;

	constructor(label: string, compact = true) {
		this.#label = label;
		this.compact = compact;
		this.#shown = text(label);
		this.#hiddenNode = withHidden(this.#shown, true);
	}

	render(): readonly string[] {
		return this.hidden ? [] : [this.#label];
	}

	describe(): NativeNode {
		return this.hidden ? this.#hiddenNode : this.#shown;
	}

	isTranscriptBlockCompact(): boolean {
		return this.compact && !this.hidden;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "toggle") this.toggles.push(event.collapsed);
	}
}

/** An assistant message holding only tool calls: an empty column between the calls' blocks. */
class EmptyReply implements Component {
	readonly #node = col([], { role: "omp.assistant" });

	render(): readonly string[] {
		return [];
	}

	describe(): NativeNode {
		return this.#node;
	}
}

async function mount(blocks: readonly Component[]): Promise<{ h: TspHarness; transcript: TranscriptContainer }> {
	const transcript = new TranscriptContainer();
	for (const block of blocks) transcript.addChild(block);
	harness = await TspHarness.start(tui => tui.addChild(transcript));
	await harness.render();
	return { h: harness, transcript };
}

/** Wire ids of the transcript's top-level entries, a run as the ids of its members. */
function entries(h: TspHarness): (string | string[])[] {
	const root = h.find(node => node.p?.role === "omp.transcript")!;
	return (root.c ?? []).map((node: TspNode) =>
		node.p?.role === "omp.compact" ? (node.c ?? []).map(member => member.id) : node.id,
	);
}

function opsSince(h: TspHarness, frameCount: number): TspOp[] {
	return h.frames.slice(frameCount).flatMap(frame => frame.ops);
}

describe("native compact runs", () => {
	it("draws a compact run, with hidden and empty blocks inside it, as one gapless entry whose members keep their own events", async () => {
		const [n1, c1, c2, hidden, c3, n2] = [
			new Line("n1", false),
			new Line("c1"),
			new Line("c2"),
			new Line("h"),
			new Line("c3"),
			new Line("n2", false),
		];
		const reply = new EmptyReply();
		hidden!.hidden = true;
		const { h } = await mount([n1!, c1!, reply, c2!, hidden!, c3!, n2!]);
		const id = (block: Component) => nativeComponentId(block);
		// Tern spaces every top-level entry; an empty or hidden one splitting the run would put gaps back.
		expect(entries(h)).toEqual([id(n1!), [id(c1!), id(reply), id(c2!), id(hidden!), id(c3!)], id(n2!)]);
		expect(h.find(node => node.p?.role === "omp.compact")?.p).toMatchObject({ gap: "none" });

		// Tern's expand toggle on a member reaches that member, not the run.
		h.event({ ev: "toggle", sf: h.terminal.surface!, id: id(c2!), collapsed: false });
		expect(c2!.toggles).toEqual([false]);
		expect(h.errors).toEqual([]);
	});

	it("keeps a compact block's trailers inside its run and a full block's trailers out of it", async () => {
		// Regression guard: a compact call's Spotlight notice splitting its run with a gap in Tern.
		const trailer = (label: string): Component => {
			const node = text(label);
			return { render: () => [], describe: () => node, invalidate: () => {} };
		};
		const t1 = trailer("t1");
		const tn = trailer("tn");
		const c1 = Object.assign(new Line("c1"), { nativeTrailers: () => [t1] });
		const c2 = new Line("c2");
		const n = Object.assign(new Line("n", false), { nativeTrailers: () => [tn] });
		const c3 = new Line("c3");
		const c4 = new Line("c4");
		const { h } = await mount([c1, c2, n, c3, c4]);
		const id = (block: Component) => nativeComponentId(block);
		expect(entries(h)).toEqual([[id(c1), id(t1), id(c2)], id(n), id(tn), [id(c3), id(c4)]]);
		expect(h.errors).toEqual([]);
	});

	it("regroups members as runs grow and split without remounting any of them", async () => {
		const blocks = [new Line("c1"), new Line("c2"), new Line("c3"), new Line("c4"), new Line("n", false)];
		const [c1, c2, c3, c4] = blocks;
		const { h, transcript } = await mount(blocks);
		const id = (block: Component) => nativeComponentId(block);
		const members = [c1!, c2!, c3!, c4!].map(id);
		const run = h.find(node => node.p?.role === "omp.compact")!.id;

		// A block joining the end of the run lands inside the same entry.
		const c5 = new Line("c5");
		transcript.insertChildAt(c5, 4);
		let before = h.frames.length;
		await h.render();
		expect(opsSince(h, before)).toContainEqual(["add", id(c5), run, null, expect.anything()]);
		expect(opsSince(h, before)).not.toContainEqual(["del", run]);

		// A member that stops being compact leaves the run on the next frame.
		c2!.compact = false;
		before = h.frames.length;
		await h.render();
		expect(entries(h)).toEqual([id(c1!), id(c2!), [id(c3!), id(c4!), id(c5)], id(blocks[4]!)]);
		const ops = opsSince(h, before);
		for (const member of [...members, id(c5)]) {
			expect(ops).not.toContainEqual(["del", member]);
			expect(ops.some(op => op[0] === "add" && op[1] === member)).toBe(false);
		}
		expect(h.errors).toEqual([]);
	});
});
