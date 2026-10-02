import { describe, expect, it } from "bun:test";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { type NativeRegions, nativeComponentId, Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import { settleNative } from "@oh-my-pi/pi-tui/native/settle";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import type { TspKind, TspOp } from "@oh-my-pi/pi-wire";

const cx: DescribeContext = { cols: 60, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

class Described implements Component {
	current: NativeNode | null = null;
	render(): readonly string[] {
		return [];
	}
	describe(): NativeNode | null {
		return this.current;
	}
}

class Painted implements Component {
	lines: readonly string[] = ["row"];
	render(): readonly string[] {
		return this.lines;
	}
}

/** Mulberry32: a fixed-seed PRNG so failures reproduce. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Apply `ops` to `doc`, failing on any rejected op. */
function apply(doc: TspDocument, s: number, ops: readonly TspOp[]): void {
	const errors = doc.applyFrame({ sf: doc.surface, s, ops });
	expect(errors).toEqual([]);
}

/** The document a fresh reconciler produces for `regions`: the reference for the incremental one. */
function fullDocument(regions: NativeRegions) {
	const reconciler = new Reconciler("s:t");
	const doc = new TspDocument("s:t");
	apply(doc, 1, reconciler.reconcile(regions, cx));
	return doc.snapshot();
}

describe("Reconciler", () => {
	it("applying emitted ops to the previous document always yields the current description", () => {
		const random = prng(0x7359);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
		const texts = new Map<Described, string>();
		const described = Array.from({ length: 10 }, () => new Described());
		const painted = Array.from({ length: 3 }, () => new Painted());
		const pool: Component[] = [...described, ...painted];
		const kinds: readonly TspKind[] = [
			"col",
			"row",
			"card",
			"section",
			"list",
			"item",
			"text",
			"md",
			"code",
			"badge",
		];

		const tree = (depth: number, comps: Component[]): NativeNode => {
			// Overlays below a component's root are hoisted into `layer`.
			const kind = depth === 1 && random() < 0.08 ? "overlay" : pick(kinds);
			const props: Record<string, unknown> = {};
			if (random() < 0.5) props.tone = pick(["info", "error", "success"]);
			if (random() < 0.3) props.role = pick(["omp.a", "omp.b"]);
			if (kind === "list" && random() < 0.5) props.selected = pick(["a", "b", "c"]);
			if (kind === "text" || kind === "md" || kind === "code")
				props.text = pick(["x", "hello", "hello world", "é🙂"]);
			const children: NativeChild[] = [];
			const count = depth < 3 ? Math.floor(random() * 4) : 0;
			for (let i = 0; i < count; i++) {
				const key = random() < 0.6 ? pick(["a", "b", "c", "head", "1"]) : undefined;
				const child = tree(depth + 1, comps);
				children.push(key === undefined ? child : { ...child, key });
			}
			// Hand this subtree the components assigned to it, at random slots.
			while (comps.length > 0 && (depth > 0 || random() < 0.7)) {
				children.splice(Math.floor(random() * (children.length + 1)), 0, comps.shift()!);
				if (random() < 0.5) break;
			}
			return node(kind, props, children.length > 0 ? children : undefined);
		};

		const assigned = new Map<Component, Component[]>();
		const sameList = (a: readonly Component[] | undefined, b: readonly Component[]) =>
			a !== undefined && a.length === b.length && a.every((c, i) => c === b[i]);
		const reconciler = new Reconciler("s:t");
		const doc = new TspDocument("s:t");
		let main: NativeChild[] = [];
		let dock: NativeChild[] = [];
		for (let step = 1; step <= 400; step++) {
			// Assign components to a random forest: a component's parent comes earlier in the order.
			const order = [...pool].sort(() => random() - 0.5);
			const children = new Map<Component, Component[]>();
			const roots: Component[] = [];
			for (let i = 0; i < order.length; i++) {
				const roll = random();
				if (roll < 0.15) continue;
				const parents = order.slice(0, i).filter(parent => parent instanceof Described);
				if (roll < 0.55 || parents.length === 0) roots.push(order[i]!);
				else {
					const parent = pick(parents);
					children.set(parent, [...(children.get(parent) ?? []), order[i]!]);
				}
			}
			for (const comp of described) {
				const kids = children.get(comp) ?? [];
				const text = texts.get(comp) ?? "";
				const roll = random();
				if (!sameList(assigned.get(comp), kids) || comp.current === null || roll < 0.25) {
					comp.current = tree(0, [...kids]);
					// A component must hand every assigned child to its description.
					const placed = new Set<Component>();
					const walk = (n: NativeNode) => {
						for (const c of n.c ?? [])
							if ("render" in c) placed.add(c as Component);
							else walk(c as NativeNode);
					};
					walk(comp.current);
					for (const kid of kids) if (!placed.has(kid)) comp.current = node("col", {}, [comp.current, kid]);
					assigned.set(comp, kids);
				} else if (roll < 0.4) {
					// Streaming: the primary text grows.
					const grown = `${text}${pick(["a", "ü", "🙂", " next"])}`;
					texts.set(comp, grown);
					comp.current = node("md", { text: grown, stream: true }, comp.current.c);
				}
			}
			for (const comp of painted) if (random() < 0.2) comp.lines = [`row ${step}`, pick(["a", "b"])];
			if (random() < 0.05) settleNative(pick(described));

			const plain = (): NativeNode => ({ ...tree(1, []), key: pick(["p", "q", "r"]) });
			const split = Math.floor(random() * (roots.length + 1));
			if (random() < 0.7) main = [...roots.slice(0, split), ...(random() < 0.3 ? [plain()] : [])];
			else main = main.filter(child => !("render" in child) || roots.slice(0, split).includes(child as Component));
			for (const comp of roots.slice(0, split)) if (!main.includes(comp)) main.push(comp);
			dock = roots.slice(split);
			const regions: NativeRegions = { main, dock, layer: [] };

			apply(doc, step, reconciler.reconcile(regions, cx));
			expect(doc.snapshot()).toEqual(fullDocument(regions));
		}
	});

	it("reorders keyed children with moves, keeping every node", () => {
		const comp = new Described();
		const items = (order: string[]) =>
			node(
				"list",
				{},
				order.map(key => ({ ...node("item", { label: key }), key })),
			);
		comp.current = items(["a", "b", "c", "d"]);
		const reconciler = new Reconciler("s:t");
		const doc = new TspDocument("s:t");
		apply(doc, 1, reconciler.reconcile({ main: [comp], dock: [], layer: [] }, cx));
		comp.current = items(["d", "a", "b", "c"]);
		const ops = reconciler.reconcile({ main: [comp], dock: [], layer: [] }, cx);
		apply(doc, 2, ops);
		const base = nativeComponentId(comp);
		expect(ops).toEqual([["move", `${base}.d`, base, `${base}.a`]]);
		expect(doc.get(base)?.c?.map(child => child.id)).toEqual(["d", "a", "b", "c"].map(key => `${base}.${key}`));
	});

	it("streams growing primary text as an append of the new tail only", () => {
		const comp = new Described();
		comp.current = node("md", { text: "Hello", stream: true });
		const reconciler = new Reconciler("s:t");
		const doc = new TspDocument("s:t");
		apply(doc, 1, reconciler.reconcile({ main: [comp], dock: [], layer: [] }, cx));
		comp.current = node("md", { text: "Hello, wörld", stream: true });
		const ops = reconciler.reconcile({ main: [comp], dock: [], layer: [] }, cx);
		apply(doc, 2, ops);
		expect(ops).toEqual([["text", nativeComponentId(comp), "append", ", wörld"]]);
	});

	it("sends a scroll op only when a node's scroll request changes, and only to terminals with the feature", () => {
		const comp = new Described();
		const stream = (n?: number): NativeNode => ({
			...node("ansi", { text: "log" }),
			scroll: n === undefined ? undefined : { by: n % 2 ? "page-up" : "end", n },
		});
		const scrolls = (ops: readonly TspOp[]) => ops.filter(op => op[0] === "scroll");
		const reconciler = new Reconciler("s:t");
		const doc = new TspDocument("s:t");
		const regions = { main: [comp], dock: [], layer: [] };
		comp.current = stream(1);
		const added = reconciler.reconcile(regions, cx);
		apply(doc, 1, added);
		// A fresh node starts where it is; a request belongs to the node it was made for.
		expect(scrolls(added)).toEqual([]);
		comp.current = stream(2);
		const id = nativeComponentId(comp);
		expect(scrolls(reconciler.reconcile(regions, cx))).toEqual([["scroll", id, "end"]]);
		comp.current = { ...node("ansi", { text: "log 2" }), scroll: { by: "end", n: 2 } };
		expect(scrolls(reconciler.reconcile(regions, cx))).toEqual([]);
		// Two presses before the next frame: two steps.
		comp.current = { ...node("ansi", { text: "log 2" }), scroll: { by: "page-up", n: 4 } };
		expect(scrolls(reconciler.reconcile(regions, cx))).toEqual([
			["scroll", id, "page-up"],
			["scroll", id, "page-up"],
		]);
		comp.current = stream(5);
		expect(scrolls(reconciler.reconcile(regions, { ...cx, feature: () => false }))).toEqual([]);
	});

	it("moves a component to a new parent instead of re-adding it", () => {
		const child = new Described();
		child.current = node("text", { text: "kept" });
		const left = new Described();
		const right = new Described();
		left.current = node("col", {}, [child]);
		right.current = node("col", {});
		const reconciler = new Reconciler("s:t");
		const doc = new TspDocument("s:t");
		const regions = { main: [left, right], dock: [], layer: [] };
		apply(doc, 1, reconciler.reconcile(regions, cx));
		left.current = node("col", {});
		right.current = node("col", {}, [child]);
		const ops = reconciler.reconcile(regions, cx);
		apply(doc, 2, ops);
		const id = nativeComponentId(child);
		expect(ops.filter(op => op[1] === id)).toEqual([["move", id, nativeComponentId(right), null]]);
		expect(doc.get(nativeComponentId(right))?.c?.[0]?.id).toBe(id);
	});

	it("sends components without describe as rows rendered at the surface width, and counts them", () => {
		const painted = new Painted();
		const reconciler = new Reconciler("s:t");
		const ops = reconciler.reconcile({ main: [painted], dock: [], layer: [] }, cx);
		const added = ops.find(op => op[0] === "add" && op[1] === nativeComponentId(painted));
		expect(added?.[0] === "add" && added[4]).toEqual({
			id: nativeComponentId(painted),
			k: "rows",
			p: { cols: 60, lines: ["row"] },
		});
		expect(reconciler.fallbackCount).toBe(1);
	});
});
