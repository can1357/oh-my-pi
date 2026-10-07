import { afterEach, expect, it } from "bun:test";
import { TspDocument } from "../../src/native/apply";
import { node } from "../../src/native/describe";
import type { DescribeContext, NativeNode } from "../../src/native/node";
import { nativeComponentId, Reconciler } from "../../src/native/reconcile";
import { setReduceMotion } from "../../src/reduce-motion";
import type { Component } from "../../src/tui";
import { Text } from "../../src/components/text";
import { TspHarness } from "./tsp-harness";

const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

afterEach(() => setReduceMotion("off"));

it("freezes cached native animations on a live setting change, preserves data and restores motion", () => {
	let level = 0.25;
	let meter: NativeNode = node("meter", { value: level, style: "bar" });
	const live: Component = { render: () => [], describe: () => meter };
	const tree = node("col", {}, [
		node("spinner", { label: "Thinking", tone: "muted" }, undefined, "spin"),
		node("shimmer", { spans: [{ t: "Working", s: "accent", fx: "pulse" }] }, undefined, "shine"),
		node("progress", { value: null, label: "Compacting" }, undefined, "progress"),
		node("elapsed", { age: 1000, format: "short" }, undefined, "elapsed"),
		live,
	]);
	// Both direct region nodes and a memoized component must update without
	// requiring their producers to rebuild a description on the setting change.
	const comp: Component = { render: () => [], describe: () => tree };
	const id = nativeComponentId(comp);
	const regions = { main: [comp], dock: [node("spinner", { label: "Loading" }, undefined, "direct")], layer: [] };
	const reconciler = new Reconciler("test");
	const doc = new TspDocument("test");
	let sequence = 0;
	const paint = () => {
		const ops = reconciler.reconcile(regions, cx);
		expect(doc.applyFrame({ sf: "test", s: ++sequence, ops })).toEqual([]);
		return ops;
	};
	paint();
	expect(doc.get(`${id}.spin`)?.k).toBe("spinner");
	setReduceMotion("on");
	paint();
	expect(doc.get(`${id}.spin`)).toMatchObject({ k: "text", p: { text: "… Thinking", tone: "muted" } });
	expect(doc.get(`${id}.shine`)).toMatchObject({
		k: "text",
		p: { spans: [{ t: "Working", s: "accent", fx: "none" }] },
	});
	expect(doc.get(`${id}.progress`)).toMatchObject({ k: "text", p: { text: "… Compacting" } });
	expect(doc.get("dock.direct")?.k).toBe("text");
	expect(doc.get(`${id}.elapsed`)).toMatchObject({ k: "elapsed", p: { age: 1000 } });
	expect(paint()).toEqual([]);

	level = 0.8;
	meter = node("meter", { value: level, style: "bar" });
	paint();
	expect(doc.get(nativeComponentId(live))).toMatchObject({ k: "meter", p: { value: 0.8 } });
	setReduceMotion("strict");
	expect(paint()).toEqual([]);
	setReduceMotion("off");
	paint();
	expect(doc.get(`${id}.spin`)?.k).toBe("spinner");
	expect(doc.get(`${id}.shine`)?.k).toBe("shimmer");
	expect(doc.get("dock.direct")?.k).toBe("spinner");
});

it("honors a terminal reduce-motion preference without changing editor text or actions", () => {
	const editor = node("editor", {
		text: "hello",
		decor: [{ from: 0, to: 5, s: "accent", fx: "shimmer" }],
		actions: { click: "focus" },
	});
	const comp: Component = { render: () => [], describe: () => editor };
	const reconciler = new Reconciler("test");
	const doc = new TspDocument("test");
	const ops = reconciler.reconcile({ main: [comp], dock: [], layer: [] }, { ...cx, reduceMotion: true });
	expect(doc.applyFrame({ sf: "test", s: 1, ops })).toEqual([]);
	expect(doc.get(nativeComponentId(comp))).toMatchObject({
		k: "editor",
		p: { text: "hello", decor: [{ from: 0, to: 5, s: "accent", fx: "none" }], actions: { click: "focus" } },
	});
});

it("paces native content updates in strict mode and restores credit-driven rendering", async () => {
	const label = new Text("initial");
	const h = await TspHarness.start(tui => tui.addChild(label));
	try {
		h.tui.setMinRenderInterval(250);
		label.setText("updated");
		h.tui.requestRender();
		h.stall(249);
		expect(JSON.stringify(h.region("main"))).toContain("initial");
		h.stall(1);
		expect(JSON.stringify(h.region("main"))).toContain("updated");
		h.tui.setMinRenderInterval(undefined);
		label.setText("restored");
		await h.render();
		expect(JSON.stringify(h.region("main"))).toContain("restored");
		expect(h.errors).toEqual([]);
	} finally {
		h.stop();
	}
});
