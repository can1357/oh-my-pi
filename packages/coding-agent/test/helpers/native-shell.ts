import { encodeTsp, encodeTspJson } from "@oh-my-pi/pi-tui/native/apc";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspEvent, TspNode } from "@oh-my-pi/pi-wire";
import { FakeTern } from "../../../tui/test/native/fake-tern";
import { Shell } from "../../src/ui/shell/shell";

/** A node of a surface's document as Tern holds it; `c` lists its children's wire ids. */
export interface NativeNode {
	readonly id: string;
	readonly k: string;
	readonly p: Record<string, unknown>;
	readonly c: readonly string[];
	readonly parent: string | null;
}

/** A surface as Tern holds it: how it was opened, its focus and each region's top-level nodes. */
export interface NativeSurface {
	readonly id: string;
	readonly mode: string | undefined;
	readonly role: string | undefined;
	readonly focus: string | null;
	readonly main: readonly NativeNode[];
	readonly dock: readonly NativeNode[];
	readonly layer: readonly NativeNode[];
}

/** A page as Tern holds it: its surface role and each region's tree without ids. */
export interface NativePage {
	readonly role: string | undefined;
	region(id: "main" | "dock" | "layer"): unknown;
}

/** Start the app's shell on a byte stream with a Tern peer and inspect its negotiated native document. */
export async function nativeShell(shell = new Shell(), options?: { readonly kinds?: readonly string[] }) {
	const tern = new FakeTern({ features: ["aside", "settle"], autoAck: false, kinds: options?.kinds });
	const term = memoryTerminal({
		columns: tern.columns,
		rows: tern.rows,
		env: { TERM_PROGRAM: "tern" },
		onWrite(data) {
			if (!data.includes("\x1b_tsp;")) return;
			tern.writeRaw(data);
			queueMicrotask(() => tern.pump());
		},
	});
	const unsubscribe = tern.onInput(event => {
		if (event.type === "tsp" && (event.verb === "r" || event.verb === "e"))
			term.feed(encodeTsp(event.verb, event.body, event.params));
	});
	await shell.start({ theme: currentTheme, driver: term.options, role: "omp.session" });
	const sf = tern.frames[0]?.sf;
	if (!shell.native() || !sf || !shell.host?.feature("aside")) throw new Error("The shell did not negotiate Tern");
	const flush = () => {
		// At an observation boundary the peer reports its latest applied frame. The ACK releases
		// any dirty frame synchronously, without sleeping or reaching into the backend to paint.
		tern.ackAll();
		tern.pump();
		if (tern.errors.length) throw new Error(tern.errors.join("\n"));
	};
	/** Open surfaces, the one on top (a page's screen surface) first. */
	const surfaces = () => [...tern.docs].toReversed();
	const node = (kind: string, key?: string) => {
		flush();
		for (const [, doc] of surfaces()) {
			const found = [...doc.nodes.values()].find(n => n.k === kind && (!key || n.id.endsWith(`/${key}`)));
			if (found) return found;
		}
		throw new Error(`No ${kind} ${key ?? ""} in the native document`);
	};
	/**
	 * A surface as Tern holds it: how it was opened, its focus and each region's top-level nodes
	 * (read deeper with `get`). Without `mode` the surface on top; with one, the latest open
	 * surface of that mode, undefined when there is none (no page is up).
	 */
	function surface(): NativeSurface;
	function surface(mode: "inline" | "screen"): NativeSurface | undefined;
	function surface(mode?: "inline" | "screen"): NativeSurface | undefined {
		flush();
		const opened = tern.sent("o") as { id: string; mode: string; role?: string }[];
		const held = surfaces().find(([id]) => mode === undefined || opened.findLast(o => o.id === id)?.mode === mode);
		if (!held) return undefined;
		const [id, doc] = held;
		const open = opened.findLast(o => o.id === id);
		const region = (name: string) => (doc.nodes.get(name)?.c ?? []).map(child => doc.nodes.get(child)!);
		return {
			id,
			mode: open?.mode,
			role: open?.role,
			focus: doc.focus,
			main: region("main"),
			dock: region("dock"),
			layer: region("layer"),
		};
	}
	/** The whole tree under the node with wire id `id`, children nested. */
	const tree = (id: string): TspNode => {
		flush();
		for (const [, doc] of surfaces()) if (doc.nodes.has(id)) return doc.tree(id);
		throw new Error(`No node ${id} in the native document`);
	};
	/** The node with wire id `id` (another node's `parent`, or an entry of its `c`). */
	const get = (id: string) => {
		flush();
		for (const [, doc] of surfaces()) {
			const found = doc.nodes.get(id);
			if (found) return found;
		}
		throw new Error(`No node ${id} in the native document`);
	};
	/** The nodes Tern holds under `parent`, in order. */
	const children = (parent: { readonly c: readonly string[] }) => parent.c.map(get);
	/** Deliver `event` as Tern would: addressed to the surface that holds the node it names. */
	const send = (event: TspEvent) => {
		const id = "id" in event ? event.id : undefined;
		const holder = id === undefined ? undefined : surfaces().find(([, doc]) => doc.nodes.has(id))?.[0];
		term.feed(encodeTspJson("e", holder === undefined || !("sf" in event) ? event : { ...event, sf: holder }));
		flush();
	};
	/** The page on top; undefined while only the session shows. */
	const page = (): NativePage | undefined => {
		flush();
		const opened = tern.sent("o") as { id: string; mode?: string; role?: string }[];
		const top = opened.findLast(surface => surface.mode === "screen" && tern.docs.has(surface.id));
		if (!top) return undefined;
		const doc = tern.doc(top.id);
		return { role: top.role, region: (id: "main" | "dock" | "layer") => doc.shape(id) };
	};
	return {
		shell,
		sf,
		node,
		surface,
		page,
		/** Scroll operations received by the active native surface. */
		scrolls() {
			flush();
			return surfaces()[0]?.[1].scrolls ?? [];
		},
		get,
		tree,
		children,
		send,
		/** Only a click actually advertised by the rendered control can be dispatched. */
		click(kind: string, key: string) {
			const { id, p } = node(kind, key);
			const actions = p.actions;
			if (!actions || typeof actions !== "object" || !("click" in actions) || typeof actions.click !== "string")
				throw new Error(`${id} has no click action`);
			send({ ev: "action", sf, id, act: actions.click });
		},
		type(text: string) {
			term.feed(text);
			flush();
		},
		async [Symbol.asyncDispose]() {
			try {
				await shell.stop();
			} finally {
				unsubscribe();
				shell.overlays.closeAll();
				shell.surface.dispose();
			}
		},
	};
}
