/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createSurface,
	For,
	type JSXNode,
	type Reveal,
	type ScrollRequest,
	Show,
	type Surface,
	type SurfaceTemplate,
	settle,
	signal,
	type UiEvent,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import { parseTspApc } from "@oh-my-pi/pi-tui/native/apc";
import { NativeBackend } from "@oh-my-pi/pi-tui/native/backend";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { BLOB_REPLY_MS, TspConnection } from "@oh-my-pi/pi-tui/native/connection";
import type { TspDocComment, TspOp } from "@oh-my-pi/pi-wire";
import { FakeTern, type FakeTernOptions, ManualClock, sha256 } from "./fake-tern";

interface Harness {
	readonly tern: FakeTern;
	readonly clock: ManualClock;
	readonly surface: Surface;
	readonly backend: NativeBackend;
	readonly connection: TspConnection;
	/** Run due timers and deliver terminal input until quiet. */
	settle(): void;
	/** Ops of frames sent since the last call. */
	ops(): TspOp[];
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) {
		h.backend.dispose();
		h.connection.close();
		h.surface.dispose();
	}
});

async function mount(template: () => SurfaceTemplate, options: FakeTernOptions = {}): Promise<Harness> {
	const tern = new FakeTern(options);
	const clock = new ManualClock();
	const pending = TspConnection.connect(tern, { clock });
	tern.pump();
	const connection = (await pending)!;
	expect(connection).not.toBeNull();
	const surface = createSurface(template);
	const backend = new NativeBackend({ surface, id: "s:t" });
	let seen = 0;
	const harness: Harness = {
		tern,
		clock,
		surface,
		backend,
		connection,
		settle() {
			for (let i = 0; i < 20; i++) {
				clock.advance(0);
				tern.pump();
			}
		},
		ops() {
			const out = tern.opsSince(seen);
			seen = tern.frames.length;
			return out;
		},
	};
	harnesses.push(harness);
	backend.start(connection);
	harness.settle();
	harness.ops();
	return harness;
}

const regions = (h: Harness, region: "main" | "dock" | "layer") => h.tern.doc("s:t").shape(region);

/** The document a fresh backend builds for the same surface: the reference for incremental updates. */
async function fresh(template: () => SurfaceTemplate): Promise<unknown> {
	const h = await mount(template);
	return { main: regions(h, "main"), dock: regions(h, "dock"), layer: regions(h, "layer") };
}

describe("native handshake", () => {
	it("negotiates apc limit, credits, kinds and features from the hello reply", async () => {
		const tern = new FakeTern({ apc: 512, credits: 3, features: ["blobs"], kinds: ["col", "text"] });
		const clock = new ManualClock();
		const pending = TspConnection.connect(tern, { clock, ver: "9" });
		expect(tern.sent("q")).toEqual([
			{ q: "hello", v: [1], app: "omp", features: ["edit", "undo", "send"], ver: "9" },
		]);
		tern.pump();
		const connection = (await pending)!;
		expect(connection.apcLimit).toBe(512);
		expect(connection.credits).toBe(3);
		expect(connection.supports("text")).toBe(true);
		expect(connection.supports("card")).toBe(false);
		expect(connection.hasFeature("blobs")).toBe(true);
		connection.close();
	});

	it("resolves null when the terminal stays silent or speaks another version", async () => {
		const silent = new FakeTern({ reply: false });
		const clock = new ManualClock();
		const pending = TspConnection.connect(silent, { clock });
		silent.pump();
		clock.advance(300);
		expect(await pending).toBeNull();

		const future = new FakeTern({ version: 2 });
		const other = TspConnection.connect(future, { clock });
		future.pump();
		expect(await other).toBeNull();
	});

	it("gives up once the hello's batch settled without a reply, before the deadline", async () => {
		// A terminal without TSP answers the batch's DA1: rows must not wait out the deadline first.
		const silent = new FakeTern({ reply: false });
		const clock = new ManualClock();
		let settle = (): void => {};
		const pending = TspConnection.connect(silent, {
			clock,
			settled: listener => {
				settle = listener;
				return () => {};
			},
		});
		silent.pump();
		let result: TspConnection | null | undefined;
		void pending.then(value => {
			result = value;
		});
		await Promise.resolve();
		expect(result).toBeUndefined();
		settle();
		await Promise.resolve();
		expect(result).toBeNull();
	});

	it("works on an assumed hello at once and adopts the terminal's reply when it comes", () => {
		const tern = new FakeTern({ cols: 90 });
		const connection = TspConnection.assume(tern, new ManualClock());
		const settled: boolean[] = [];
		connection.onHello(confirmed => settled.push(confirmed));
		expect(connection.confirmation).toBe("assumed");
		expect(connection.cols()).toBe(90);
		expect(connection.hasFeature("blobs")).toBe(true);
		// The terminal reported its width before the reply: that width outranks the reply's.
		tern.event({ ev: "resize", cols: 70 });
		tern.input({
			type: "tsp",
			verb: "r",
			params: {},
			body: JSON.stringify({
				r: "hello",
				v: 1,
				term: "tern",
				kinds: ["col"],
				apc: 512,
				credits: 4,
				cols: 100,
				features: ["adopt"],
				hour12: true,
			}),
		});
		tern.pump();
		expect(settled).toEqual([true]);
		expect(connection.confirmation).toBe("confirmed");
		expect([connection.apcLimit, connection.credits, connection.cols()]).toEqual([512, 4, 70]);
		expect(connection.hasFeature("blobs")).toBe(false);
		expect(connection.hasFeature("adopt")).toBe(true);
		expect(connection.hello.hour12).toBe(true);
		connection.close();

		const future = new FakeTern();
		const declined = TspConnection.assume(future, new ManualClock());
		declined.onHello(confirmed => settled.push(confirmed));
		future.input({ type: "tsp", verb: "r", params: {}, body: '{"r":"hello","v":2,"term":"tern","kinds":[]}' });
		future.pump();
		expect(settled).toEqual([true, false]);
		expect(declined.confirmation).toBe("unsupported");
		declined.close();
	});

	it("only listens when the driver sends the query itself", async () => {
		const tern = new FakeTern();
		const pending = TspConnection.connect(tern, { clock: new ManualClock(), queried: true });
		expect(tern.received).toEqual([]);
		tern.event({ ev: "ack", sf: "x", s: 1 });
		tern.input({ type: "tsp", verb: "r", params: {}, body: '{"r":"hello","v":1,"term":"t","kinds":["col"]}' });
		tern.pump();
		const connection = await pending;
		expect(connection?.hello.term).toBe("t");
		connection?.close();
	});
});

describe("native reconciler", () => {
	it("describes the regions on open and changes one prop with a single set", async () => {
		const tone = signal<"info" | "error">("info");
		const h = await mount(() => ({
			main: (
				<card title="Run" tone={tone}>
					<text>hello</text>
				</card>
			),
			dock: <editor text="" />,
		}));
		expect(h.tern.sent("o")).toEqual([{ id: "s:t", mode: "inline" }]);
		expect(h.tern.doc("s:t").tree("main")).toEqual({
			id: "main",
			k: "col",
			c: [
				{
					id: "main/0",
					k: "card",
					p: { title: "Run", tone: "info" },
					c: [{ id: "main/0/0", k: "text", p: { text: "hello" } }],
				},
			],
		});
		expect(regions(h, "dock")).toEqual([{ k: "editor", p: { text: "" } }]);
		tone.set("error");
		h.settle();
		expect(h.ops()).toEqual([["set", "main/0", { tone: "error" }]]);
		expect(h.tern.errors).toEqual([]);
	});

	it("sends null for a removed prop and nothing for an equal value", async () => {
		const tone = signal<"info" | undefined>("info");
		const spans = signal([{ t: "a" }]);
		const h = await mount(() => ({ main: <text tone={tone} spans={spans} /> }));
		spans.set([{ t: "a" }]);
		h.settle();
		expect(h.ops()).toEqual([]);
		tone.set(undefined);
		h.settle();
		expect(h.ops()).toEqual([["set", "main/0", { tone: null }]]);
		expect(h.tern.doc("s:t").tree("main/0")).toEqual({ id: "main/0", k: "text", p: { spans: [{ t: "a" }] } });
	});

	it("inserts, removes and reorders keyed children with single add, del and move ops", async () => {
		const items = signal(["a", "b", "c", "d"]);
		const h = await mount(() => ({
			main: (
				<list>
					<For each={items}>{key => <item key={key} label={key} />}</For>
				</list>
			),
		}));
		const ids = () =>
			h.tern
				.doc("s:t")
				.tree("main/0")
				.c?.map(c => c.id);
		expect(ids()).toEqual(["main/0/a", "main/0/b", "main/0/c", "main/0/d"]);

		items.set(["d", "a", "b", "c"]);
		h.settle();
		expect(h.ops()).toEqual([["move", "main/0/d", "main/0", "main/0/a"]]);

		items.set(["d", "a", "x", "b", "c"]);
		h.settle();
		expect(h.ops()).toEqual([
			["add", "main/0/x", "main/0", "main/0/b", { id: "main/0/x", k: "item", p: { label: "x" } }],
		]);

		items.set(["d", "x", "b", "c"]);
		h.settle();
		expect(h.ops()).toEqual([["del", "main/0/a"]]);

		items.set(["c", "b", "x", "d"]);
		h.settle();
		const reversed = h.ops();
		expect(reversed.every(op => op[0] === "move")).toBe(true);
		expect(reversed).toHaveLength(3);
		expect(ids()).toEqual(["main/0/c", "main/0/b", "main/0/x", "main/0/d"]);
		expect(h.tern.errors).toEqual([]);
	});

	it("appends a growing text, splices a rewritten tail and replaces a text rewritten from its start", async () => {
		const text = signal("Hello");
		const h = await mount(() => ({ main: <md stream={true}>{text}</md> }));
		text.set("Hello, wörld");
		h.settle();
		expect(h.ops()).toEqual([["text", "main/0", "append", ", wörld"]]);
		// A streaming link is sent closed; when the rest arrives only the tail is rewritten.
		text.set("see [docs](https://ex");
		h.settle();
		h.ops();
		text.set("see [docs](https://example.com) now");
		h.settle();
		expect(h.ops()).toEqual([["splice", "main/0", 21, 1, "ample.com) now"]]);
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ stream: true, text: "see [docs](https://example.com) now" });
		text.set("Bye");
		h.settle();
		expect(h.ops()).toEqual([["text", "main/0", "replace", "Bye"]]);
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ stream: true, text: "Bye" });
	});

	it("holds a streaming md's partial table row until its line ends", async () => {
		const text = signal("| a | b |\n|---|---|\n| 1 | 2 |\n| 3");
		const h = await mount(() => ({ main: <md stream={true}>{text}</md> }));
		expect(h.tern.doc("s:t").tree("main/0").p).toMatchObject({ text: "| a | b |\n|---|---|\n| 1 | 2 |\n" });
		text.set(`${text()} | 4 |\n`);
		h.settle();
		expect(h.ops()).toEqual([["text", "main/0", "append", "| 3 | 4 |\n"]]);
	});

	it("morphs a re-created node at the same keypath instead of re-adding it", async () => {
		const label = signal("one");
		const h = await mount(() => ({
			main: (
				<col>
					{() => (
						<card title={label()}>
							<text>body</text>
						</card>
					)}
				</col>
			),
		}));
		label.set("two");
		h.settle();
		expect(h.ops()).toEqual([["set", "main/0/0", { title: "two" }]]);
	});

	it("morphs a re-created node that moved up since it was first described", async () => {
		const before = signal(["x", "y", "z"]);
		const text = signal("a");
		const h = await mount(() => ({
			main: (
				<>
					<For each={before}>{t => <text text={t} />}</For>
					{() => (
						<col>
							<text text={text()} />
						</col>
					)}
				</>
			),
		}));
		// The col leaves index 3 for index 2, whose id `main/2` the block after `x` still holds.
		before.set(["y", "z"]);
		h.settle();
		expect(h.ops()).toEqual([["del", "main/0"]]);
		for (const next of ["ab", "abc"]) {
			text.set(next);
			h.settle();
			expect(h.ops()).toEqual([["text", "main/3/0", "append", next.slice(-1)]]);
		}
	});

	it("re-adds a node whose kind changed under a fresh id, deleting the old one last", async () => {
		const code = signal(false);
		const h = await mount(() => ({
			main: <col>{() => (code() ? <code text="x" /> : <text text="x" />)}</col>,
		}));
		code.set(true);
		h.settle();
		expect(h.ops()).toEqual([
			["add", "main/0/0~1", "main/0", null, { id: "main/0/0~1", k: "code", p: { text: "x" } }],
			["del", "main/0/0"],
		]);
		expect(h.tern.errors).toEqual([]);
	});

	it("moves a node out of a deleted subtree before deleting the subtree", async () => {
		const leaf = <text key="leaf" text="kept" />;
		const inner = signal(true);
		const h = await mount(() => ({
			main: (
				<col>
					{() => (inner() ? <card key="box">{leaf}</card> : null)}
					<section key="dest">{() => (inner() ? null : leaf)}</section>
				</col>
			),
		}));
		inner.set(false);
		h.settle();
		expect(h.ops()).toEqual([
			["move", "main/0/box/leaf", "main/0/dest", null],
			["del", "main/0/box"],
		]);
		expect(h.tern.errors).toEqual([]);
	});

	it("skips unchanged subtrees without walking them", async () => {
		let keyReads = 0;
		const a = signal("a");
		const h = await mount(() => ({
			main: (
				<col>
					<col>
						<text
							key={() => {
								keyReads++;
								return "watched";
							}}
							text="static"
						/>
					</col>
					<text>{a}</text>
				</col>
			),
		}));
		const before = keyReads;
		a.set("b");
		h.settle();
		expect(h.ops()).toEqual([["text", "main/0/1", "replace", "b"]]);
		expect(keyReads).toBe(before);
	});

	it("settles a top-level main node, and describes it again when it changes after all", async () => {
		let node: UiNode | undefined;
		const status = signal("running");
		const h = await mount(() => ({
			main: (
				<card ref={n => (node = n)} title={status}>
					<text>{status}</text>
				</card>
			),
		}));
		status.set("done");
		settle(node!);
		h.settle();
		expect(h.ops()).toEqual([
			["set", "main/0", { title: "done" }],
			["text", "main/0/0", "replace", "done"],
			["settle", "main/0"],
		]);
		h.settle();
		expect(h.ops()).toEqual([]);
		status.set("changed after settle");
		h.settle();
		expect(h.ops()).toEqual([
			["del", "main/0"],
			[
				"add",
				"main/0",
				"main",
				null,
				{
					id: "main/0",
					k: "card",
					p: { title: "changed after settle" },
					c: [{ id: "main/0/0", k: "text", p: { text: "changed after settle" } }],
				},
			],
			["settle", "main/0"],
		]);
		expect(h.tern.doc("s:t").settled.has("main/0")).toBe(true);
		expect(h.tern.errors).toEqual([]);
	});

	it("refreshes only the settled block that changed, then lets it settle again", async () => {
		let root!: UiNode;
		const folded = signal(true);
		const h = await mount(() => ({
			main: [
				<card key="details" ref={node => (root = node)}>
					<section key="fold" collapsible collapsed={folded} onToggle={value => folded.set(value)}>
						{() => !folded() && <md key="body" text="Full details" />}
					</section>
				</card>,
				<text key="after">Following message</text>,
			],
		}));
		settle(root);
		h.settle();
		h.ops();
		const doc = h.tern.doc("s:t");
		for (const collapsed of [false, true]) {
			h.tern.event({ ev: "toggle", sf: "s:t", id: "main/details/fold", collapsed });
			h.settle();
			expect(doc.nodes.get("main/details/fold")?.p.collapsed).toBe(collapsed);
			expect(doc.nodes.get("main/details/fold/body")?.p.text).toBe(collapsed ? undefined : "Full details");
			expect(doc.tree("main").c?.map(node => node.id)).toEqual(["main/details", "main/after"]);
			const ops = h.ops();
			expect(ops.at(-1)).toEqual(["settle", "main/details"]);
			expect(ops.some(op => op.length > 1 && op[1] === "main/after")).toBe(false);
		}
		h.tern.event({ ev: "toggle", sf: "s:t", id: "main/details/fold", collapsed: true });
		h.settle();
		expect(h.ops()).toEqual([]);
		// A change the app makes by itself (a display setting, a late result) reaches the block the same way.
		folded.set(false);
		h.settle();
		expect(doc.nodes.get("main/details/fold/body")?.p.text).toBe("Full details");
		expect(doc.tree("main").c?.map(node => node.id)).toEqual(["main/details", "main/after"]);
		const ops = h.ops();
		expect(ops.at(-1)).toEqual(["settle", "main/details"]);
		expect(ops.some(op => op.length > 1 && op[1] === "main/after")).toBe(false);
		expect(h.tern.errors).toEqual([]);
	});

	it("describes a settled block again on request, then settles it again", async () => {
		let inner!: UiNode;
		const view = signal("pseudo");
		const h = await mount(() => ({
			main: [
				<card key="call">
					<text key="view" ref={node => (inner = node)} text={view} />
				</card>,
				<text key="after">Following message</text>,
			],
		}));
		const doc = h.tern.doc("s:t");
		// Before it settles the block is watched: saying so changes nothing.
		h.backend.redescribe(inner);
		h.settle();
		expect(h.ops()).toEqual([]);

		settle(h.surface.main()[0]!);
		h.settle();
		h.ops();
		// A settled block follows its own changes; the request describes it again without one.
		view.set("raw");
		h.settle();
		expect(h.ops().at(-1)).toEqual(["settle", "main/call"]);

		// Any node of the block names it.
		h.backend.redescribe(inner);
		h.settle();
		const ops = h.ops();
		expect(doc.nodes.get("main/call/view")?.p.text).toBe("raw");
		expect(doc.tree("main").c?.map(node => node.id)).toEqual(["main/call", "main/after"]);
		expect(ops.at(-1)).toEqual(["settle", "main/call"]);
		expect(ops.some(op => op.length > 1 && op[1] === "main/after")).toBe(false);
		expect(h.tern.errors).toEqual([]);
	});

	it("forgets a retention-evicted row without deleting it twice or using it as a live sibling", async () => {
		const prepend = signal(false);
		const keep = signal(true);
		const actions: string[] = [];
		let retained!: UiNode;
		const h = await mount(() => ({
			main: [
				() => (prepend() ? <text key="new">New</text> : null),
				<Show when={keep}>
					{() => (
						<card key="old" ref={node => (retained = node)} onAction={act => actions.push(act)}>
							<button key="copy" text="Copy" />
						</card>
					)}
				</Show>,
				<text key="last">Last</text>,
			],
		}));
		settle(retained);
		h.settle();
		const doc = h.tern.doc("s:t");
		expect(doc.settled.has("main/old")).toBe(true);
		h.tern.event({ ev: "gone", sf: "another", ids: ["main/old"] });
		h.settle();
		expect(h.backend.idOf(retained)).toBe("main/old");

		// Tern drops the entire settled subtree, reporting only its root.
		expect(doc.apply([["del", "main/old"]])).toEqual([]);
		h.tern.event({ ev: "gone", sf: "s:t", ids: ["main/old"] });
		h.tern.event({ ev: "action", sf: "s:t", id: "main/old/copy", act: "copy" });
		h.settle();
		expect(h.backend.idOf(retained)).toBeUndefined();
		expect(actions).toEqual([]);
		prepend.set(true);
		h.settle();
		expect(regions(h, "main")).toEqual([
			{ k: "text", p: { text: "New" } },
			{ k: "text", p: { text: "Last" } },
		]);
		keep.set(false);
		h.settle();
		expect(h.tern.errors).toEqual([]);
	});

	it("sends focus from the surface focus", async () => {
		let field: UiNode | undefined;
		const h = await mount(() => ({ dock: <input ref={n => (field = n)} text="" /> }));
		h.surface.focus(field!);
		h.settle();
		expect(h.ops()).toEqual([["focus", "dock/0"]]);
		h.surface.focus(null);
		h.settle();
		expect(h.ops()).toEqual([["focus", null]]);
	});

	it("hoists overlays and pickers from main/dock into layer", async () => {
		const open = signal(false);
		let field: UiNode | undefined;
		const h = await mount(() => ({
			main: <text>transcript</text>,
			dock: (
				<col>
					<editor text="" />
					<Show when={open}>
						{() => (
							<overlay key="sheet" modal={true}>
								<input ref={n => (field = n)} text="linear" />
							</overlay>
						)}
					</Show>
				</col>
			),
			layer: <toast text="saved" />,
		}));
		open.set(true);
		h.surface.focus(field!);
		h.settle();
		expect(h.ops()).toEqual([
			[
				"add",
				"dock/0/^sheet",
				"layer",
				"layer/0",
				{
					id: "dock/0/^sheet",
					k: "overlay",
					p: { modal: true },
					c: [{ id: "dock/0/^sheet/0", k: "input", p: { text: "linear" } }],
				},
			],
			["focus", "dock/0/^sheet/0"],
		]);
		expect(regions(h, "dock")).toEqual([{ k: "col", c: [{ k: "editor", p: { text: "" } }] }]);
		open.set(false);
		h.settle();
		expect(h.ops()).toEqual([
			["focus", null],
			["del", "dock/0/^sheet"],
		]);
		expect(h.tern.errors).toEqual([]);
	});

	it("sends a canvas as rows painted at the surface width, repainting on resize", async () => {
		const h = await mount(() => ({ main: <canvas paint={width => ["=".repeat(width)]} onMouse={() => true} /> }), {
			cols: 6,
		});
		expect(h.tern.doc("s:t").tree("main/0")).toEqual({ id: "main/0", k: "rows", p: { cols: 6, lines: ["======"] } });
		h.tern.event({ ev: "resize", cols: 3 });
		h.settle();
		expect(h.ops()).toEqual([["set", "main/0", { cols: 3, lines: ["==="] }]]);
	});

	it("reveals and scrolls from node fields", async () => {
		const reveal = signal<Reveal>({ at: "start", n: 1 });
		const scroll = signal<ScrollRequest>({ by: "page-up", n: 1 });
		const h = await mount(() => ({
			main: [<md reveal="end" text="a" />, <ansi reveal={reveal} scroll={scroll} text="log" />],
		}));
		expect(h.tern.doc("s:t").reveals).toEqual([["main/0", "end"]]);
		reveal.set({ at: "start", n: 2 });
		scroll.set({ by: "page-up", n: 3 });
		h.settle();
		expect(h.ops()).toEqual([
			["reveal", "main/1", "start"],
			["scroll", "main/1", "page-up"],
			["scroll", "main/1", "page-up"],
		]);
		// `features` replaces, rather than extends, the negotiated list.
		h.tern.event({ ev: "features", features: ["adopt"] });
		h.settle();
		scroll.set({ by: "page-down", n: 4 });
		h.settle();
		expect(h.ops()).toEqual([]);
		h.tern.event({ ev: "features", features: ["scroll"] });
		h.settle();
		scroll.set({ by: "page-down", n: 5 });
		h.settle();
		expect(h.ops()).toEqual([["scroll", "main/1", "page-down"]]);
	});

	it("reveals a rebuilt node again only when its request moves", async () => {
		const rev = signal(0);
		const open = signal(false);
		const n = signal(1);
		const h = await mount(() => ({
			main: () => {
				rev();
				return open() ? (
					<col key="q" reveal={{ at: "start", n: n() }}>
						<text text={`open ${rev()}`} />
					</col>
				) : (
					<col key="q">
						<text text="folded" />
					</col>
				);
			},
		}));
		// The folded node opening (its record taken over) is a request it never had.
		open.set(true);
		h.settle();
		expect(h.ops().filter(op => op[0] === "reveal")).toEqual([["reveal", "main/q", "start"]]);
		// Rebuilt with the same request (a key moving the highlight): no reveal.
		rev.set(1);
		h.settle();
		expect(h.ops().filter(op => op[0] === "reveal")).toEqual([]);
		n.set(2);
		h.settle();
		expect(h.ops().filter(op => op[0] === "reveal")).toEqual([["reveal", "main/q", "start"]]);
	});

	it("scrolls on the first request an existing node gets, never on the one it was added with", async () => {
		const scroll = signal<ScrollRequest | undefined>(undefined);
		const shown = signal(false);
		const h = await mount(() => ({
			main: [
				<ansi scroll={scroll} text="log" />,
				() => (shown() ? <ansi key="late" scroll={scroll} text="late" /> : null),
			],
		}));
		scroll.set({ by: "start", n: 1 });
		h.settle();
		expect(h.ops()).toEqual([["scroll", "main/0", "start"]]);
		shown.set(true);
		h.settle();
		expect(h.ops().filter(op => op[0] === "scroll")).toEqual([]);
		scroll.set({ by: "line-down", n: 2 });
		h.settle();
		expect(h.ops()).toEqual([
			["scroll", "main/0", "line-down"],
			["scroll", "main/late", "line-down"],
		]);
	});

	it("never sends the terminal-only `term` prop", async () => {
		const look = signal({ border: "round" });
		const term = { term: look } as {};
		const h = await mount(() => ({ main: <card title="t" {...term} /> }));
		expect(h.tern.doc("s:t").tree("main/0")).toEqual({ id: "main/0", k: "card", p: { title: "t" } });
		look.set({ border: "sharp" });
		h.settle();
		expect(h.ops()).toEqual([]);
	});

	it("sends `propKey` as the wire prop `key`, leaving ids to the node key", async () => {
		const call = signal("call1");
		const h = await mount(() => ({ main: <tool key="t" propKey={call} name="read" /> }));
		expect(h.tern.doc("s:t").tree("main/t").p).toMatchObject({ key: "call1" });
		call.set("call2");
		h.settle();
		expect(h.ops()).toEqual([["set", "main/t", { key: "call2" }]]);
	});

	it("sends each icon glyph as its own `icon` span, without the space that padded it", async () => {
		const h = await mount(() => ({
			main: (
				<col key="c">
					<text
						key="styled"
						spans={[
							{ t: "Model \ue26d opus \uf00c", s: "accent" },
							{ t: " done" },
							{ t: "\uf111", s: "ok icon" },
						]}
					/>
					<list key="list">
						<item key="a" label={[{ t: "\uf07b src", s: "muted" }]} detail="no glyph here" value={"\uf00c"} />
					</list>
					<kv key="facts" items={[{ k: "\uf017 Time", v: [{ t: "now" }] }]} />
					<section key="fold" head={"\uf0e2 Rewind"} />
				</col>
			),
		}));
		const shape = h.tern.doc("s:t").tree("main/c").c!;
		expect(shape.map(node => node.p)).toEqual([
			{
				spans: [
					{ t: "Model", s: "accent" },
					{ t: "\ue26d", s: "accent icon" },
					{ t: "opus", s: "accent" },
					{ t: "\uf00c", s: "accent icon" },
					{ t: "done" },
					{ t: "\uf111", s: "ok icon" },
				],
			},
			undefined,
			{ items: [{ k: [{ t: "\uf017", s: "icon" }, { t: "Time" }], v: [{ t: "now" }] }] },
			{ head: [{ t: "\uf0e2", s: "icon" }, { t: "Rewind" }] },
		]);
		expect(shape[1]!.c![0]!.p).toEqual({
			label: [
				{ t: "\uf07b", s: "muted icon" },
				{ t: "src", s: "muted" },
			],
			detail: "no glyph here",
			value: [{ t: "\uf00c", s: "icon" }],
		});
	});

	it("turns a plain label into spans while it holds an icon and back when it no longer does", async () => {
		const label = signal("\uf111 Active");
		const h = await mount(() => ({ main: <text key="state" text={label} /> }));
		const sent = () => h.tern.doc("s:t").tree("main/state").p;
		expect(sent()).toEqual({ spans: [{ t: "\uf111", s: "icon" }, { t: "Active" }] });
		label.set("Idle");
		h.settle();
		expect(sent()).toEqual({ text: "Idle" });
		label.set("\uf111 Busy");
		h.settle();
		expect(sent()).toEqual({ text: "", spans: [{ t: "\uf111", s: "icon" }, { t: "Busy" }] });
		expect(h.tern.errors).toEqual([]);
	});

	it("anchors hoisted overlays to their own field and follows its replacement wire id", async () => {
		const multiline = signal(true);
		const h = await mount(() => ({
			dock: [
				<col key="left">
					<row key="line">
						<editor key="input" />
					</row>
					<overlay key="popup" anchor={{ caret: "line/input" }} />
				</col>,
				<col key="right">
					<row key="line">{() => (multiline() ? <editor key="input" /> : <input key="input" />)}</row>
					<overlay key="popup" anchor={{ caret: "line/input" }} />
				</col>,
			],
		}));
		const doc = h.tern.doc("s:t");
		const fieldId = (owner: string) => doc.tree(`dock/${owner}/line`).c![0]!.id;
		const left = fieldId("left");
		const right = fieldId("right");
		const anchors = () => doc.tree("layer").c!.map(popup => popup.p);
		expect(anchors()).toEqual([{ anchor: { caret: left } }, { anchor: { caret: right } }]);

		multiline.set(false);
		h.settle();
		const replacement = fieldId("right");
		expect(replacement).not.toBe(right);
		expect(doc.tree(replacement).k).toBe("input");
		expect(anchors()).toEqual([{ anchor: { caret: left } }, { anchor: { caret: replacement } }]);
		expect(h.tern.errors).toEqual([]);
	});

	it("sends a picker's caret anchor with its query range, only the keypath resolved to a wire id", async () => {
		const query = signal<[number, number]>([1, 1]);
		const h = await mount(() => ({
			dock: (
				<col key="composer">
					<row key="line">
						<editor key="input" />
					</row>
					<picker key="mentions" anchor={() => ({ caret: "line/input", query: query() })} />
				</col>
			),
		}));
		const doc = h.tern.doc("s:t");
		const field = doc.tree("dock/composer/line").c![0]!.id;
		const sent = () => doc.tree("layer").c![0]!.p;
		expect(sent()).toEqual({ anchor: { caret: field, query: [1, 1] } });

		query.set([1, 3]);
		h.settle();
		expect(sent()).toEqual({ anchor: { caret: field, query: [1, 3] } });
		expect(h.tern.errors).toEqual([]);
	});

	it("anchors to a node moved into the referenced path, not the id its new path would generate", async () => {
		const active = signal(false);
		const field = <input key="field" />;
		const h = await mount(() => ({
			layer: (
				<col>
					<overlay key="popup" anchor={{ node: "active/field", side: "above" }} />
					<row key="idle">{() => (active() ? null : field)}</row>
					<row key="active">{() => (active() ? field : null)}</row>
				</col>
			),
		}));
		const doc = h.tern.doc("s:t");
		const id = doc.tree("layer/0/idle").c![0]!.id;
		active.set(true);
		h.settle();
		expect(doc.tree("layer/0/active").c![0]!.id).toBe(id);
		expect(doc.tree("layer/0/popup").p).toEqual({ anchor: { node: id, side: "above" } });

		active.set(false);
		h.settle();
		expect(doc.tree("layer/0/popup").p).toBeUndefined();
		expect(h.tern.errors).toEqual([]);
	});

	it("translates a list's selected key to its item's wire id", async () => {
		const selected = signal("b");
		const h = await mount(() => ({
			main: (
				<list selected={selected}>
					<item key="a" label="A" />
					<item key="b" label="B" />
				</list>
			),
		}));
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ selected: "main/0/b" });
		selected.set("a");
		h.settle();
		expect(h.ops()).toEqual([["set", "main/0", { selected: "main/0/a" }]]);
	});

	it("names a section's child keyed `head` as its head, following a replaced head", async () => {
		const live = signal(true);
		const h = await mount(() => ({
			main: (
				<section collapsible>
					{() => (live() ? <row key="head" /> : <text key="head" text="Thought" />)}
					<md key="body" text="body" />
				</section>
			),
		}));
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ collapsible: true, head: "main/0/head" });
		live.set(false);
		h.settle();
		const section = h.tern.doc("s:t").tree("main/0");
		expect(section.p).toEqual({ collapsible: true, head: section.c?.[0]?.id });
	});

	it("keeps the terminal's document equal to a fresh description through random edits", async () => {
		let seed = 0x5eed;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) >>> 0;
			return seed / 2 ** 32;
		};
		const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
		interface Spec {
			k: "col" | "card" | "text" | "md" | "overlay";
			key?: string;
			tone?: string;
			text?: string;
			c?: Spec[];
		}
		const gen = (depth: number): Spec => {
			const k = depth > 0 && random() < 0.1 ? "overlay" : pick(["col", "card", "text", "md"] as const);
			const spec: Spec = { k };
			if (random() < 0.5) spec.key = pick(["a", "b", "c", "d"]);
			if (random() < 0.4) spec.tone = pick(["info", "error"]);
			if (k === "text" || k === "md") spec.text = pick(["x", "xy", "xyz", "q"]);
			else if (depth < 3) spec.c = Array.from({ length: Math.floor(random() * 4) }, () => gen(depth + 1));
			return spec;
		};
		// Specs render as nodes cached on the spec, so unchanged specs keep their nodes.
		const kNode = Symbol("node");
		type Cached = Spec & { [kNode]?: JSXNode };
		const mutate = (spec: Spec): Spec => {
			const roll = random();
			if (roll < 0.2) return gen(1);
			const out: Cached = { ...spec };
			delete out[kNode];
			if (roll < 0.4) out.tone = random() < 0.5 ? undefined : pick(["info", "error", "success"]);
			if (out.text !== undefined && roll < 0.6) out.text = random() < 0.7 ? `${out.text}${pick(["!", "é"])}` : "new";
			if (out.c) {
				let c = out.c.map(child => (random() < 0.5 ? mutate(child) : child));
				if (random() < 0.3) c = c.sort(() => random() - 0.5);
				if (random() < 0.2) c.splice(Math.floor(random() * (c.length + 1)), 0, gen(2));
				if (random() < 0.2 && c.length > 0) c.splice(Math.floor(random() * c.length), 1);
				out.c = c;
			}
			return out;
		};
		const render = (spec: Cached): JSXNode => {
			let node = spec[kNode];
			if (node) return node;
			const seen = new Set<string>();
			const kids = (spec.c ?? []).map(child => {
				// Keys stay unique among siblings.
				if (child.key !== undefined && seen.has(child.key)) child = { ...child, key: undefined };
				if (child.key !== undefined) seen.add(child.key);
				return render(child);
			});
			const Kind = spec.k;
			node =
				Kind === "text" || Kind === "md" ? (
					<Kind key={spec.key} tone={spec.tone as never} text={spec.text} />
				) : (
					<Kind key={spec.key} tone={spec.tone as never}>
						{kids}
					</Kind>
				);
			spec[kNode] = node;
			return node;
		};
		let main: Spec[] = [gen(0), gen(0)];
		let dock: Spec[] = [gen(0)];
		const state = signal({ main, dock });
		const template = () => ({
			main: () => state().main.map(render),
			dock: () => state().dock.map(render),
		});
		const h = await mount(template);
		for (let step = 0; step < 150; step++) {
			main = main.map(spec => (random() < 0.4 ? mutate(spec) : spec));
			if (random() < 0.2) main = [...main, gen(0)];
			if (random() < 0.1 && main.length > 1) main = main.slice(1);
			dock = dock.map(spec => (random() < 0.3 ? mutate(spec) : spec));
			// The same specs are rendered fresh for the reference (no shared nodes).
			const snapshot = { main, dock };
			state.set(snapshot);
			h.settle();
			expect(h.tern.errors).toEqual([]);
			const reference = await fresh(() => ({
				main: snapshot.main.map(spec => renderFresh(spec)),
				dock: snapshot.dock.map(spec => renderFresh(spec)),
			}));
			expect({ main: regions(h, "main"), dock: regions(h, "dock"), layer: regions(h, "layer") }).toEqual(
				reference as never,
			);
		}

		function renderFresh(spec: Spec): JSXNode {
			const seen = new Set<string>();
			const kids = (spec.c ?? []).map(child => {
				if (child.key !== undefined && seen.has(child.key)) child = { ...child, key: undefined };
				if (child.key !== undefined) seen.add(child.key);
				return renderFresh(child);
			});
			const Kind = spec.k;
			return Kind === "text" || Kind === "md" ? (
				<Kind key={spec.key} tone={spec.tone as never} text={spec.text} />
			) : (
				<Kind key={spec.key} tone={spec.tone as never}>
					{kids}
				</Kind>
			);
		}
	});
});

describe("native pacing and transport", () => {
	it("keeps at most `credits` frames unacknowledged and coalesces changes made while blocked", async () => {
		const text = signal("");
		const h = await mount(() => ({ main: <md stream={true}>{text}</md> }), { credits: 2, autoAck: false });
		h.tern.ackAll();
		h.settle();
		const sent = h.tern.frames.length;
		for (const token of ["one", " two", " three", " four"]) {
			text.set(text() + token);
			h.settle();
		}
		expect(h.tern.frames.length).toBe(sent + 2);
		h.ops();
		h.tern.ackAll();
		h.settle();
		expect(h.ops()).toEqual([["text", "main/0", "append", " three four"]]);
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ stream: true, text: "one two three four" });
	});

	it("resets the credits when the oldest frame stays unacknowledged", async () => {
		const text = signal("a");
		const h = await mount(() => ({ main: <text>{text}</text> }), { credits: 1, autoAck: false });
		const sent = h.tern.frames.length;
		text.set("ab");
		h.settle();
		expect(h.tern.frames.length).toBe(sent);
		h.clock.advance(4999);
		expect(h.tern.frames.length).toBe(sent);
		h.clock.advance(1);
		expect(h.tern.frames.length).toBe(sent + 1);
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ text: "ab" });
	});

	it("lets a keystroke echo overdraw stalled credits while transcript changes still wait", async () => {
		const transcript = signal("");
		const text = signal("");
		let field: UiNode | undefined;
		const h = await mount(
			() => ({
				main: <text>{transcript}</text>,
				dock: (
					<editor
						ref={n => (field = n)}
						text={text}
						onEdit={e => {
							if (e.type === "edit") text.set(text().slice(0, e.from) + e.text + text().slice(e.to));
						}}
					/>
				),
			}),
			{ credits: 1, autoAck: false },
		);
		h.surface.focus(field!);
		for (let i = 0; i < 2; i++) {
			h.tern.ackAll();
			h.settle();
		}
		const type = (ch: string) => {
			h.tern.input({ type: "key", key: { id: ch, text: ch, kind: "press", raw: ch } });
			h.settle();
		};
		// A streaming transcript spends the only credit, and Tern stops acknowledging.
		transcript.set("one");
		h.settle();
		const sent = h.tern.frames.length;
		transcript.set("one two");
		h.settle();
		expect(h.tern.frames.length).toBe(sent);
		// The echo goes out at once, carrying the held transcript change with it.
		type("h");
		expect(h.tern.frames.length).toBe(sent + 1);
		expect(h.tern.doc("s:t").shape("dock")).toEqual([{ k: "editor", p: { text: "h" } }]);
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ text: "one two" });
		// A transcript change alone still waits for an ack.
		transcript.set("one two three");
		h.settle();
		expect(h.tern.frames.length).toBe(sent + 1);
		// Echoes run two frames past the credit, then wait until the oldest stops counting (250 ms), not 5 s.
		type("i");
		expect(h.tern.frames.length).toBe(sent + 2);
		type("!");
		expect(h.tern.frames.length).toBe(sent + 2);
		h.clock.advance(249);
		expect(h.tern.frames.length).toBe(sent + 2);
		h.clock.advance(1);
		expect(h.tern.frames.length).toBe(sent + 3);
		expect(h.tern.doc("s:t").shape("dock")).toEqual([{ k: "editor", p: { text: "hi!" } }]);
	});

	it("lets the echo of a Tern edit overdraw stalled credits", async () => {
		const text = signal("");
		let field: UiNode | undefined;
		const h = await mount(
			() => ({
				main: <text>streaming</text>,
				dock: (
					<editor
						ref={n => (field = n)}
						text={text}
						onEdit={e => {
							if (e.type === "edit") text.set(text().slice(0, e.from) + e.text + text().slice(e.to));
						}}
					/>
				),
			}),
			{ credits: 1, autoAck: false },
		);
		// The first frame holds the only credit and is never acknowledged.
		const sent = h.tern.frames.length;
		h.tern.event({
			ev: "edit",
			sf: "s:t",
			id: h.backend.idOf(field!)!,
			from: 0,
			to: 0,
			text: "h",
			cursor: 1,
			len: 0,
		});
		h.settle();
		expect(h.tern.frames.length).toBe(sent + 1);
		expect(h.tern.doc("s:t").shape("dock")).toEqual([{ k: "editor", p: { text: "h" } }]);
	});

	it("lets the echo of a click overdraw stalled credits, so a form it closes leaves Tern at once", async () => {
		const open = signal(true);
		const h = await mount(
			() => ({
				main: [
					<text>streaming</text>,
					<Show when={open}>
						<col key="form">
							<row key="actions">
								<button key="submit" text="Submit" onAction={() => open.set(false)} />
							</row>
						</col>
					</Show>,
				],
			}),
			{ credits: 1, autoAck: false },
		);
		// The first frame holds the only credit and is never acknowledged.
		const doc = h.tern.doc("s:t");
		expect(doc.nodes.has("main/form/actions/submit")).toBe(true);
		h.tern.event({ ev: "action", sf: "s:t", id: "main/form/actions/submit", act: "click" });
		h.settle();
		// Held behind the credit, the form would stay on screen: every further click would name a node
		// the program already let go of.
		expect(doc.nodes.has("main/form")).toBe(false);
	});

	it("lends no overdraft to a transcript change after input that changed nothing", async () => {
		const transcript = signal("");
		const text = signal("");
		let field: UiNode | undefined;
		const h = await mount(
			() => ({
				main: <text>{transcript}</text>,
				dock: (
					<editor
						ref={n => (field = n)}
						text={text}
						onEdit={e => {
							if (e.type === "edit") text.set(text().slice(0, e.from) + e.text + text().slice(e.to));
						}}
					/>
				),
			}),
			{ credits: 1, autoAck: false },
		);
		h.surface.focus(field!);
		for (let i = 0; i < 2; i++) {
			h.tern.ackAll();
			h.settle();
		}
		const left = () => {
			h.tern.input({ type: "key", key: { id: "left", kind: "press", raw: "\x1b[D" } });
			h.settle();
		};
		// A streaming transcript spends the only credit, and Tern stops acknowledging.
		transcript.set("one");
		h.settle();
		const sent = h.tern.frames.length;
		// Left at the start of an empty editor, and a Tern caret move to where the caret is, change nothing.
		left();
		h.tern.event({ ev: "edit", sf: "s:t", id: h.backend.idOf(field!)!, from: 0, to: 0, text: "", cursor: 0, len: 0 });
		h.settle();
		transcript.set("one two");
		h.settle();
		expect(h.tern.frames.length).toBe(sent);
		// Nor does a no-op key typed while that transcript change is held.
		left();
		transcript.set("one two three");
		h.settle();
		expect(h.tern.frames.length).toBe(sent);
		// A key that changes the editor still echoes at once, carrying the held transcript with it.
		h.tern.input({ type: "key", key: { id: "h", text: "h", kind: "press", raw: "h" } });
		h.settle();
		expect(h.tern.frames.length).toBe(sent + 1);
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ text: "one two three" });
	});

	it("echoes a key typed while a split redraw is in flight once the split is out", async () => {
		const replace = signal(false);
		const block = "界".repeat(3 * 1024 * 1024);
		const text = signal("");
		let field: UiNode | undefined;
		const h = await mount(
			() => {
				const a = <text key="a">{block}</text>;
				const b = <text key="b">{block}</text>;
				const c = <text key="c">{block}</text>;
				return {
					main: () => (replace() ? [a, b, c] : []),
					dock: (
						<editor
							ref={n => (field = n)}
							text={text}
							onEdit={e => {
								if (e.type === "edit") text.set(text().slice(0, e.from) + e.text + text().slice(e.to));
							}}
						/>
					),
				};
			},
			{ credits: 1, autoAck: false },
		);
		h.surface.focus(field!);
		for (let i = 0; i < 2; i++) {
			h.tern.ackAll();
			h.settle();
		}
		const sent = h.tern.frames.length;
		// A redraw over the frame limit goes out in two frames; the second waits for the first's ack.
		replace.set(true);
		h.settle();
		expect(h.tern.frames.length).toBe(sent + 1);
		// A key typed meanwhile waits behind the split.
		h.tern.input({ type: "key", key: { id: "h", text: "h", kind: "press", raw: "h" } });
		h.settle();
		expect(h.tern.frames.length).toBe(sent + 1);
		// The ack releases the rest of the split, and the echo follows it without waiting for another ack.
		h.tern.ackAll();
		h.settle();
		expect(h.tern.frames.length).toBe(sent + 3);
		expect(h.tern.doc("s:t").shape("dock")).toEqual([{ k: "editor", p: { text: "h" } }]);
	});

	it("reopens a lost surface and redraws it, ignoring late errors for frames from the old surface", async () => {
		const text = signal("before");
		const h = await mount(() => ({ main: <text>{text}</text> }));
		h.tern.docs.delete("s:t");
		text.set("after");
		h.settle();
		const error = { ev: "error", sf: "s:t", s: h.tern.frames.at(-1)!.s, msg: "unknown surface s:t" } as const;
		h.tern.event(error);
		h.settle();
		const recovered = h.tern.doc("s:t");
		expect(recovered.shape("main")).toEqual([{ k: "text", p: { text: "after" } }]);
		h.tern.event(error);
		text.set("later");
		h.settle();
		expect(recovered.shape("main")).toEqual([{ k: "text", p: { text: "later" } }]);
	});

	it("stops sending after a rejected reopen, even across credit resets, until a new surface is requested", async () => {
		const text = signal("before");
		const h = await mount(() => ({ main: <text>{text}</text> }), { credits: 1, autoAck: false });
		h.tern.ackAll();
		h.settle();
		h.tern.docs.delete("s:t");
		text.set("lost");
		h.settle();
		const rejected = h.tern.frames.at(-1)!.s;
		h.tern.event({ ev: "error", sf: "s:t", s: rejected, msg: "unknown surface s:t" });
		h.settle();
		const retry = h.tern.frames.at(-1)!.s;
		expect(retry).toBeGreaterThan(rejected);

		h.tern.docs.delete("s:t");
		h.tern.event({ ev: "ack", sf: "s:t", s: rejected });
		h.tern.event({ ev: "error", sf: "s:t", s: retry, msg: "unknown surface s:t" });
		h.settle();
		for (const value of ["while blocked", "latest"]) {
			text.set(value);
			h.clock.advance(5000);
			h.settle();
		}
		expect(h.tern.frames.at(-1)!.s).toBe(retry);
		expect(h.tern.docs.has("s:t")).toBe(false);

		h.tern.event({ ev: "gone", ids: ["s:t"] });
		h.settle();
		expect(regions(h, "main")).toEqual([{ k: "text", p: { text: "latest" } }]);
	});

	it("redraws a large replacement transcript in UTF-8-bounded frames", async () => {
		const replace = signal(false);
		const block = "界".repeat(3 * 1024 * 1024);
		const h = await mount(
			() => {
				const old = (
					<card key="old" ref={settle}>
						<text>Old chat</text>
					</card>
				);
				const removed = (
					<text key="removed" ref={settle}>
						Removed from the new view
					</text>
				);
				const a = <text key="a">{block}</text>;
				const b = <text key="b">{block}</text>;
				const c = <text key="c">{block}</text>;
				return { main: () => (replace() ? [a, old, b, c] : [removed, old]) };
			},
			{ credits: 3, autoAck: false },
		);
		const start = h.tern.received.length;
		h.tern.ackAll();
		replace.set(true);
		h.settle();
		const frameSizes = () =>
			h.tern.received
				.slice(start)
				.filter(m => m.verb === "f")
				.map(m => Buffer.byteLength(m.body));
		expect(Math.max(...frameSizes())).toBeLessThanOrEqual(24 * 1024 * 1024);
		expect(frameSizes()).toHaveLength(1);

		// Retention can remove both a queued insertion anchor and a row about to be deleted.
		const doc = h.tern.doc("s:t");
		expect(
			doc.apply([
				["del", "main/old"],
				["del", "main/removed"],
			]),
		).toEqual([]);
		h.tern.event({ ev: "gone", sf: "s:t", ids: ["main/old", "main/removed"] });
		h.tern.ackAll();
		h.settle();
		expect(frameSizes()).toHaveLength(2);
		expect(Math.max(...frameSizes())).toBeLessThanOrEqual(24 * 1024 * 1024);
		expect(doc.tree("main").c?.map(node => node.id)).toEqual(["main/a", "main/b", "main/c"]);
		expect(h.tern.errors).toEqual([]);
	});

	it("chunks frames over the negotiated APC limit", async () => {
		const long = "é漢🙂 ".repeat(40);
		const h = await mount(() => ({ main: <text>{long}</text> }), { apc: 32 });
		const frame = h.tern.received.find(m => m.verb === "f")!;
		expect(frame.chunks).toBeGreaterThan(5);
		for (const payload of h.tern.apc.filter(p => p.startsWith("tsp;f;")))
			expect(Buffer.byteLength(parseTspApc(`\x1b_${payload}`)!.body)).toBeLessThanOrEqual(32);
		expect(h.tern.doc("s:t").tree("main/0").p).toEqual({ text: long });
		expect(h.tern.errors).toEqual([]);
	});

	it("redraws the dock after a keep-close dropped it", async () => {
		const h = await mount(() => ({ main: <text>kept</text>, dock: <text>composer</text> }));
		h.backend.stop();
		expect(regions(h, "main")).toEqual([{ k: "text", p: { text: "kept" } }]);
		h.backend.start(h.connection);
		h.settle();
		expect(regions(h, "dock")).toEqual([{ k: "text", p: { text: "composer" } }]);
		expect(h.tern.errors).toEqual([]);
	});

	it("adopts its surface after stop/start and reopens fresh when the terminal lost it", async () => {
		const h = await mount(() => ({ main: <text>kept</text> }));
		h.backend.stop();
		h.backend.start(h.connection);
		h.settle();
		expect(h.tern.sent("o").at(-1)).toEqual({ id: "s:t", mode: "inline", adopt: true });
		expect(h.tern.sent("x")).toEqual([{ id: "s:t", keep: true }]);
		// The keep-close dropped the live regions: only they come back; `main` stayed in the terminal.
		expect(h.ops().map(op => op.slice(0, 3))).toEqual([
			["add", "dock", "s:t"],
			["add", "layer", "s:t"],
		]);
		expect(regions(h, "main")).toEqual([{ k: "text", p: { text: "kept" } }]);
		h.backend.stop();
		h.tern.docs.delete("s:t");
		h.backend.start(h.connection);
		h.settle();
		expect(h.tern.sent("o").slice(-2)).toEqual([
			{ id: "s:t", mode: "inline", adopt: true },
			{ id: "s:t", mode: "inline" },
		]);
		expect(regions(h, "main")).toEqual([{ k: "text", p: { text: "kept" } }]);
		// Only the live regions' frame, sent before the terminal said it lost the surface, was refused.
		expect(h.tern.errors).toEqual(["frame for unopened surface s:t"]);
	});
});

describe("native blobs", () => {
	const image = () => {
		const bytes = crypto.getRandomValues(new Uint8Array(64));
		return { bytes, id: registerBlob(bytes, "image/png") };
	};

	it("asks about first-frame blobs and uploads the ones the terminal lacks", async () => {
		const pic = image();
		const h = await mount(() => ({ main: <image blob={pic.id} alt="pic" /> }));
		expect(h.tern.sent("q").slice(1)).toEqual([{ q: "blobs", ids: [pic.id] }]);
		expect(h.tern.received.filter(m => m.verb === "b").map(m => m.params)).toEqual([
			{ id: pic.id, mime: "image/png" },
		]);
		expect(h.tern.blobs.get(pic.id)).toEqual(pic.bytes);
		expect(pic.id).toBe(sha256(pic.bytes));
	});

	it("does not upload a blob the terminal holds, and re-uploads it when the terminal reports it gone", async () => {
		const pic = image();
		const h = await mount(() => ({ main: <image blob={pic.id} /> }), { heldBlobs: [pic.bytes] });
		expect(h.tern.sent("b")).toEqual([]);
		h.tern.blobs.delete(pic.id);
		h.tern.event({ ev: "gone", ids: [pic.id] });
		h.settle();
		expect(h.tern.sent("b")).toHaveLength(1);
		expect(h.tern.blobs.get(pic.id)).toEqual(pic.bytes);
	});

	it("uploads later blobs inline ahead of their frame, and blobs of terminals without the feature", async () => {
		const first = image();
		const later = image();
		const shown = signal(false);
		const h = await mount(() => ({
			main: [<image blob={first.id} />, () => (shown() ? <image blob={later.id} /> : null)],
		}));
		shown.set(true);
		h.settle();
		const verbs = h.tern.received.map(m => m.verb);
		expect(verbs.slice(-2)).toEqual(["b", "f"]);
		expect(h.tern.sent("q")).toHaveLength(2);

		const bare = image();
		const plain = await mount(() => ({ main: <image blob={bare.id} /> }), { features: [] });
		expect(plain.tern.sent("q")).toHaveLength(1);
		expect(plain.tern.sent("b")).toHaveLength(1);
	});

	it("uploads anyway when the blobs query goes unanswered", async () => {
		const pic = image();
		const h = await mount(() => ({ main: <image blob={pic.id} /> }), { answerBlobs: false });
		expect(h.tern.sent("b")).toEqual([]);
		h.clock.advance(BLOB_REPLY_MS - 1);
		expect(h.tern.sent("b")).toEqual([]);
		h.clock.advance(1);
		expect(h.tern.sent("b")).toHaveLength(1);
	});
});

describe("native events", () => {
	it("routes UI events to the named node, bubbling to the nearest handler with its keypath", async () => {
		const events: UiEvent[] = [];
		const toggled: boolean[] = [];
		const h = await mount(() => ({
			main: [
				<text>other</text>,
				<card
					key="tool"
					collapsible={true}
					onToggle={collapsed => toggled.push(collapsed)}
					onEvent={e => events.push(e)}
				>
					<list key="body">
						<item key="a" label="A" />
						<item key="b" label="B" />
					</list>
				</card>,
			],
		}));
		const sf = "s:t";
		h.tern.event({ ev: "toggle", sf, id: "main/tool", collapsed: true });
		h.tern.event({ ev: "select", sf, id: "main/tool/body", item: "main/tool/body/a" });
		h.tern.event({ ev: "action", sf, id: "main/tool/body/b", act: "copy", mods: ["shift"] });
		h.tern.event({ ev: "toggle", sf: "other", id: "main/tool", collapsed: false });
		h.settle();
		expect(toggled).toEqual([true]);
		expect(events).toEqual([
			{ type: "select", key: "body", item: "a" },
			{ type: "action", key: "body/b", act: "copy", mods: ["shift"] },
		]);
	});

	it("keeps a controlled menu open and checked in sync with Tern's pointer events", async () => {
		const open = signal(false);
		const checked = signal(true);
		const h = await mount(() => ({
			dock: (
				<menu
					key="options"
					open={open}
					items={() => [{ id: "timestamps", checked: checked() }]}
					onToggle={collapsed => open.set(!collapsed)}
					onAction={(act, event) => {
						if (act === "timestamps" && event.checked !== undefined) checked.set(event.checked);
					}}
				/>
			),
		}));
		const route = { sf: "s:t", id: "dock/options" };
		h.tern.event({ ev: "toggle", ...route, open: true });
		h.settle();
		const doc = h.tern.doc("s:t");
		expect(doc.tree(route.id).p).toMatchObject({ open: true });
		h.tern.event({ ev: "action", ...route, act: "timestamps", checked: false });
		h.tern.event({ ev: "toggle", ...route, open: false });
		h.settle();
		expect(doc.tree(route.id).p).toMatchObject({ open: false, items: [{ id: "timestamps", checked: false }] });
	});

	it("uses the toggled tree row's key, not the tree node's keypath, to fold one branch", async () => {
		const folded = signal<string | undefined>(undefined);
		const h = await mount(() => ({
			main: (
				<tree
					key="files"
					nodes={() =>
						["src", "test"].map(id => ({
							id,
							label: id,
							open: folded() !== id,
							children: [{ id: `${id}/a`, label: "a" }],
						}))
					}
					onToggle={(collapsed, event) => folded.set(collapsed ? event.item : undefined)}
				/>
			),
		}));
		h.tern.event({ ev: "toggle", sf: "s:t", id: "main/files", key: "test", collapsed: true });
		h.settle();
		expect(h.tern.doc("s:t").tree("main/files").p).toMatchObject({
			nodes: [
				{ id: "src", open: true },
				{ id: "test", open: false },
			],
		});
	});

	it("updates pane visibility from the live surface, ignoring malformed and unknown events", async () => {
		const h = await mount(() => ({ main: <text>live</text> }));
		const sf = "s:t";
		h.tern.event({ ev: "resize", sf, cols: 60, visible: false, cell: { w: 8, h: 16 } });
		h.settle();
		expect(h.connection.visible()).toBe(false);
		h.tern.input({ type: "tsp", verb: "e", params: {}, body: '{"ev":"constructor"}' });
		h.tern.input({ type: "tsp", verb: "e", params: {}, body: '{"ev":"resize","cols":20,"cell":{"w":"x","h":5}}' });
		h.tern.event({ ev: "visible", sf, visible: true });
		h.settle();
		expect(h.connection.cols()).toBe(60);
		expect(h.connection.cell()).toEqual({ w: 8, h: 16 });
		expect(h.connection.visible()).toBe(true);
	});

	it("accepts a send only for the addressed live field while it is sendable", async () => {
		const ready = signal(true);
		const prompts: string[] = [];
		const h = await mount(() => ({
			dock: (
				<col onSend={text => prompts.push(text)}>
					<input key="composer" sendable={ready} />
					<input key="filter" />
					<input key="locked" sendable readonly />
					<text key="hint">Type a prompt</text>
				</col>
			),
		}));
		const send = (key: string, text: string) => h.tern.event({ ev: "send", sf: "s:t", id: `dock/0/${key}`, text });
		send("composer", "first");
		send("filter", "wrong field");
		send("locked", "readonly");
		send("composer", "  \n");
		send("hint", "not a field");
		send("composer/stale", "unknown");
		h.settle();
		send("composer", "late");
		ready.set(false);
		h.settle();
		expect(prompts).toEqual(["first"]);
	});

	it("routes document editing, source and comment events to their distinct updates", async () => {
		const text = signal("Alpha line");
		const editing = signal(false);
		const comments = signal<readonly TspDocComment[]>([]);
		const h = await mount(() => ({
			main: (
				<doc
					key="plan"
					edit
					comment
					text={text}
					title={() => (editing() ? "Editing" : "Plan")}
					comments={comments}
					onEvent={e => {
						switch (e.type) {
							case "editing":
								return editing.set(e.on);
							case "docChange":
								return text.set(e.text);
							case "comment":
								return comments.set([{ id: "c1", quote: e.quote, at: e.at, note: e.note }]);
							case "commentNote":
								return comments.set(comments().map(c => (c.id === e.comment ? { ...c, note: e.note } : c)));
							case "uncomment":
								return comments.set(comments().filter(c => c.id !== e.comment));
						}
					}}
				/>
			),
		}));
		const sf = "s:t";
		const id = "main/plan";
		const props = () => h.tern.doc(sf).tree(id).p;
		h.tern.event({ ev: "comment", sf, id, quote: "Alpha", at: 0, note: "clarify" });
		h.tern.event({ ev: "editing", sf, id, on: true });
		h.settle();
		expect(props()).toMatchObject({
			title: "Editing",
			comments: [{ id: "c1", quote: "Alpha", at: 0, note: "clarify" }],
		});
		h.tern.event({ ev: "comment", sf, id, comment: "c1", note: "name the API" });
		h.tern.event({ ev: "change", sf, id, text: "# Plan\n" });
		h.settle();
		expect(props()).toMatchObject({ text: "# Plan\n", comments: [{ id: "c1", note: "name the API" }] });
		h.tern.event({ ev: "uncomment", sf, id, comment: "c1" });
		h.tern.event({ ev: "editing", sf, id, on: false });
		h.settle();
		expect(props()).toMatchObject({ title: "Plan", comments: [] });
	});

	it("decodes chunked edit events and delivers them to the editor", async () => {
		const edits: UiEvent[] = [];
		const h = await mount(() => ({ dock: <editor text="ab" onEdit={e => edits.push(e)} /> }));
		const body = JSON.stringify({
			ev: "edit",
			sf: "s:t",
			id: "dock/0",
			from: 2,
			to: 2,
			text: "c€",
			cursor: 4,
			len: 2,
		});
		h.tern.eventChunks([body.slice(0, 10), body.slice(10, 30), body.slice(30)]);
		h.settle();
		expect(edits).toEqual([{ type: "edit", key: "", from: 2, to: 2, text: "c€", cursor: 4, len: 2 }]);
	});

	it("edits a focused editor from raw keys and pastes, as Tern forwards them", async () => {
		// Tern leaves an omp editor's editing to the program: typed keys arrive raw, not as `edit` events.
		const text = signal("");
		let field: UiNode | undefined;
		const h = await mount(() => ({
			dock: (
				<editor
					ref={n => (field = n)}
					text={text}
					onEdit={e => {
						if (e.type === "edit") text.set(text().slice(0, e.from) + e.text + text().slice(e.to));
					}}
				/>
			),
		}));
		h.surface.focus(field!);
		h.settle();
		h.ops();
		for (const ch of "hi") h.tern.input({ type: "key", key: { id: ch, text: ch, kind: "press", raw: ch } });
		h.tern.input({ type: "paste", paste: { text: " there" } });
		h.settle();
		expect(text()).toBe("hi there");
		expect(h.tern.doc("s:t").shape("dock")).toEqual([{ k: "editor", p: { text: "hi there" } }]);
	});

	it("shows a raw selection on Tern and honors a subsequent native caret move to the same offset", async () => {
		const text = signal("ab\ncd");
		const cursor = signal(1);
		let field!: UiNode;
		const h = await mount(() => ({
			dock: (
				<editor
					ref={n => (field = n)}
					text={text}
					cursor={cursor}
					onEdit={e => {
						text.set(text().slice(0, e.from) + e.text + text().slice(e.to));
						cursor.set(e.cursor);
					}}
				/>
			),
		}));
		h.surface.focus(field);
		h.settle();
		h.tern.input({ type: "key", key: { id: "super+a", kind: "press", raw: "\x1b[97;9u" } });
		h.settle();
		expect(h.tern.doc("s:t").shape("dock")).toEqual([{ k: "editor", p: { text: "ab\ncd", cursor: 5, anchor: 0 } }]);

		h.tern.event({ ev: "edit", sf: "s:t", id: "dock/0", from: 5, to: 5, text: "", cursor: 5, len: 5 });
		h.settle();
		h.tern.input({ type: "paste", paste: { text: "!" } });
		h.settle();
		expect(h.tern.doc("s:t").shape("dock")).toEqual([{ k: "editor", p: { text: "ab\ncd!", cursor: 6 } }]);
	});

	it("keeps pointer focus inside a modal but lets a non-modal sheet yield the keys", async () => {
		const modal = signal(true);
		let inside!: UiNode;
		let composer!: UiNode;
		const h = await mount(() => ({
			dock: <editor ref={node => (composer = node)} />,
			layer: (
				<overlay key="dialog" modal={modal}>
					<input ref={node => (inside = node)} />
				</overlay>
			),
		}));
		h.surface.focus(inside);
		h.settle();
		const clickComposer = () => h.tern.event({ ev: "focus", sf: "s:t", id: h.backend.idOf(composer)! });
		clickComposer();
		h.settle();
		expect(h.surface.focused()).toBe(inside);
		expect(h.tern.doc("s:t").focus).toBe(h.backend.idOf(inside)!);
		modal.set(false);
		clickComposer();
		h.settle();
		expect(h.surface.focused()).toBe(composer);
		expect(h.tern.doc("s:t").focus).toBe(h.backend.idOf(composer)!);
	});

	it("moves focus on an unhandled focus event and routes keys up the focus path", async () => {
		const keys: string[] = [];
		const global: string[] = [];
		let field: UiNode | undefined;
		const tern = new FakeTern();
		const clock = new ManualClock();
		const pending = TspConnection.connect(tern, { clock });
		tern.pump();
		const connection = (await pending)!;
		const surface = createSurface(() => ({
			dock: (
				<col onKey={key => (key.id === "ctrl+s" ? (keys.push(key.id), true) : false)}>
					<input ref={n => (field = n)} text="" />
				</col>
			),
		}));
		const backend = new NativeBackend({ surface, id: "s:k", onKey: key => (global.push(key.id), true) });
		harnesses.push({ tern, clock, surface, backend, connection, settle() {}, ops: () => [] });
		backend.start(connection);
		clock.advance(0);
		tern.pump();
		tern.event({ ev: "focus", sf: "s:k", id: "dock/0/0" });
		tern.pump();
		expect(surface.focused()).toBe(field!);
		clock.advance(0);
		tern.pump();
		expect(tern.doc("s:k").focus).toBe("dock/0/0");
		for (const id of ["ctrl+s", "ctrl+q"]) tern.input({ type: "key", key: { id, kind: "press", raw: "" } });
		tern.pump();
		expect(keys).toEqual(["ctrl+s"]);
		expect(global).toEqual(["ctrl+q"]);
	});

	it("batches handler writes into one frame", async () => {
		const a = signal("a");
		const b = signal("b");
		const h = await mount(() => ({
			main: [<text>{a}</text>, <text>{b}</text>],
			dock: (
				<button
					text="go"
					onAction={() => {
						a.set("A");
						b.set("B");
					}}
				/>
			),
		}));
		h.tern.event({ ev: "action", sf: "s:t", id: "dock/0", act: "press" });
		h.settle();
		expect(h.tern.frames.length).toBeGreaterThan(0);
		expect(h.ops()).toEqual([
			["text", "main/0", "replace", "A"],
			["text", "main/1", "replace", "B"],
		]);
	});
});
