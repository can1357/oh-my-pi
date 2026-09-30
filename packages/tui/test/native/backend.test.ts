import { afterEach, describe, expect, it } from "bun:test";
import { card, md, node } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { settleNative } from "@oh-my-pi/pi-tui/native/settle";
import { isNativeRendering, onNativeRenderingChange } from "@oh-my-pi/pi-tui/native/state";
import { type Component, Container } from "@oh-my-pi/pi-tui/tui";
import type { TspOp } from "@oh-my-pi/pi-wire";
import { ManualScheduler, TspHarness, TspTestTerminal } from "./tsp-harness";

class Probe implements Component {
	current: NativeNode;
	events: NativeUiEvent[] = [];
	constructor(current: NativeNode) {
		this.current = current;
	}
	render(): readonly string[] {
		return ["probe rows"];
	}
	describe(): NativeNode {
		return this.current;
	}
	handleNativeEvent(event: NativeUiEvent): void {
		this.events.push(event);
	}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

const opsOf = (h: TspHarness, from: number): TspOp[] => h.frames.slice(from).flatMap(frame => frame.ops);

describe("native backend", () => {
	it("keeps at most `credits` frames unacknowledged and coalesces changes made while blocked", async () => {
		const stream = new Probe(md("", { stream: true }));
		harness = await TspHarness.start(tui => tui.addChild(stream), { credits: 2, autoAck: false });
		const h = harness;
		const id = nativeComponentId(stream);
		let text = "";
		for (const token of ["one", " two", " three", " four", " five"]) {
			text += token;
			stream.current = md(text, { stream: true });
			await h.render();
		}
		expect(h.frames.length).toBe(2);
		const sent = h.frames.length;

		h.terminal.ackAll();
		h.flush();
		expect(opsOf(h, sent)).toEqual([["text", id, "append", " two three four five"]]);
		expect(h.byId(id)?.p).toEqual({ text: "one two three four five", stream: true });
		expect(h.errors).toEqual([]);
	});

	it("routes pointer events to the component that described the node, with its keypath and item key", async () => {
		const other = new Probe(node("text", { text: "other" }));
		const target = new Probe(
			card({ collapsible: true, collapsed: true }, [
				{
					...node("list", { selected: "b" }, [
						{ ...node("item", { label: "A" }), key: "a" },
						{ ...node("item", { label: "B" }), key: "b" },
					]),
					key: "body",
				},
			]),
		);
		harness = await TspHarness.start(tui => {
			tui.addChild(other);
			tui.addChild(target);
		});
		const h = harness;
		const base = nativeComponentId(target);
		// The list's selection is sent as the wire id of the item with that key.
		expect(h.byId(`${base}.body`)?.p).toEqual({ selected: `${base}.body/b` });

		h.event({ ev: "toggle", sf: h.terminal.surface!, id: base, collapsed: false });
		h.event({ ev: "select", sf: h.terminal.surface!, id: `${base}.body`, item: `${base}.body/a` });
		h.event({ ev: "action", sf: h.terminal.surface!, id: `${base}.body/b`, act: "copy-path", mods: ["shift"] });
		expect(target.events).toEqual([
			{ type: "toggle", key: "", collapsed: false },
			{ type: "select", key: "body", item: "a" },
			{ type: "action", key: "body/b", act: "copy-path", mods: ["shift"] },
		]);
		expect(other.events).toEqual([]);
	});

	it("falls back to the row renderer when the terminal never answers hello", async () => {
		const text = new Probe(node("text", { text: "unused" }));
		harness = await TspHarness.start(tui => tui.addChild(text), { reply: false });
		expect(harness.frames).toEqual([]);
		expect(harness.terminal.surface).toBeUndefined();
		expect(isNativeRendering()).toBe(false);
		expect(harness.terminal.rowBytes).toContain("probe rows");
	});

	it("applies a change to a settled block deep in main as targeted ops", async () => {
		const block = new Probe(card({ status: "running", collapsed: true }, [md("done?")]));
		const inner = new Container();
		inner.addChild(block);
		const outer = new Container();
		outer.addChild(inner);
		settleNative(block);
		harness = await TspHarness.start(tui => tui.addChild(outer));
		const h = harness;
		const id = nativeComponentId(block);
		expect(h.frames.flatMap(frame => frame.ops)).toContainEqual(["settle", id]);
		const sent = h.frames.length;

		block.current = card({ status: "done", collapsed: false }, [md("done.")]);
		await h.render();
		expect(h.errors).toEqual([]);
		expect(opsOf(h, sent)).toContainEqual(["set", id, { status: "done", collapsed: false }]);
		expect(h.byId(id)).toEqual({
			id,
			k: "card",
			p: { status: "done", collapsed: false },
			c: [{ id: `${id}.0`, k: "md", p: { text: "done." } }],
		});
	});

	it("adopts its surface after a stop/start cycle instead of re-adding the transcript", async () => {
		const block = new Probe(md("kept"));
		harness = await TspHarness.start(tui => tui.addChild(block));
		const h = harness;
		const surface = h.terminal.surface;
		h.tui.stop();
		h.flush();
		expect(isNativeRendering()).toBe(false);
		h.tui.start();
		h.flush();
		expect(h.terminal.surface).toBe(surface);
		expect(isNativeRendering()).toBe(true);
		expect(h.errors).toEqual([]);
		expect(h.region("main")?.c?.map(child => child.id)).toEqual([nativeComponentId(block)]);
		expect(h.region("dock")).toBeDefined();
	});

	it("announces native rendering once its surface is open, on start and after a stop/start cycle", () => {
		// Tern drops the shell's title when a command's first surface opens, so
		// the tab title omp writes when rendering turns native must follow the `o`.
		const h = new TspHarness(new TspTestTerminal({}), new ManualScheduler());
		harness = h;
		h.tui.addChild(new Probe(md("kept")));
		const openWhenAnnounced: (string | undefined)[] = [];
		const unwatch = onNativeRenderingChange(on => {
			if (on) openWhenAnnounced.push(h.terminal.surface);
		});
		try {
			h.tui.start();
			h.flush();
			const surface = h.terminal.surface;
			h.tui.stop();
			h.flush();
			h.tui.start();
			h.flush();
			expect(surface).toBeDefined();
			expect(openWhenAnnounced).toEqual([surface, surface]);
		} finally {
			unwatch();
		}
	});

	it("shows a fullscreen overlay on a screen surface over the session, which resumes untouched", async () => {
		const transcript = new Probe(md("hello"));
		const editor = new Probe(node("editor", { text: "/settings", cursor: 9 }));
		const settings = new Probe(node("text", { text: "Settings" }));
		const provider = {
			renderFrame: () => ({ viewport: [] }),
			acknowledgeHistory: () => {},
			describeSurface: () => ({ main: [transcript], dock: [editor] }),
		};
		harness = await TspHarness.start(tui => {
			tui.setFrameProvider(provider);
			tui.setFocus(editor);
		});
		const h = harness;
		const session = h.terminal.surface!;
		const editorId = nativeComponentId(editor);
		const sessionDoc = () => h.terminal.docs.get(session)!;
		expect(sessionDoc().focus).toBe(editorId);
		const before = sessionDoc().snapshot();
		const logged = h.terminal.log.length;
		const sent = h.frames.length;
		const lifecycle = () =>
			h.terminal.log.slice(logged).filter(message => message.verb === "o" || message.verb === "x");

		const overlay = h.tui.showOverlay(settings, { width: "100%", fullscreen: true });
		h.tui.setFocus(settings);
		await h.render();
		const cover = h.terminal.surface!;
		expect(lifecycle()).toEqual([{ verb: "o", body: expect.objectContaining({ id: cover, mode: "screen" }) }]);
		expect(h.region("main")?.c?.map(child => child.id)).toEqual([nativeComponentId(settings)]);
		expect(h.frames.slice(sent).every(frame => frame.sf === cover)).toBe(true);
		expect(sessionDoc().snapshot()).toEqual(before);

		overlay.hide();
		h.flush();
		// Only the cover opened and closed: the session was never closed, reopened or adopted.
		expect(lifecycle()).toEqual([
			{ verb: "o", body: expect.objectContaining({ id: cover, mode: "screen" }) },
			{ verb: "x", body: { id: cover, keep: false } },
		]);
		expect(h.terminal.surface).toBe(session);
		expect(h.region("dock")?.c?.map(child => child.id)).toEqual([editorId]);
		expect(sessionDoc().focus).toBe(editorId);
		expect(h.errors).toEqual([]);
	});

	it("closes its surfaces ahead of stop, after the render already requested, and paints nothing until then", async () => {
		const block = new Probe(md("kept"));
		harness = await TspHarness.start(tui => tui.addChild(block));
		const h = harness;
		const surface = h.terminal.surface;
		const logged = h.terminal.log.length;
		const rows = h.terminal.rowBytes.length;
		// The exit's status line: requested, still waiting for the scheduler.
		block.current = md("closing");
		h.tui.requestRender();
		h.tui.closeNative();
		block.current = md("changed");
		await h.render();
		h.stop();
		harness = undefined;
		const sent = h.terminal.log.slice(logged);
		expect(sent.map(message => message.verb)).toEqual(["f", "x"]);
		expect(sent[0]!.body).toMatchObject({
			sf: surface,
			ops: [["text", nativeComponentId(block), "replace", "closing"]],
		});
		expect(sent[1]!.body).toEqual({ id: surface, keep: true });
		expect(h.terminal.rowBytes.slice(rows)).not.toContain("probe rows");
	});
});
