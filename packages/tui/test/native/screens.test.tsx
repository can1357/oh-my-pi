/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Pages and sheets on a native host: which surface a layer node is drawn on,
 * what the terminal's focus names, and who sees the keys and events.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createSurface,
	type KeyEvent,
	type Surface,
	type SurfaceTemplate,
	signal,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import { TspConnection } from "@oh-my-pi/pi-tui/native/connection";
import { NativeSurfaces } from "@oh-my-pi/pi-tui/native/screens";
import { FakeTern, type FakeTernOptions, ManualClock } from "./fake-tern";

interface Harness {
	readonly tern: FakeTern;
	readonly surface: Surface;
	readonly surfaces: NativeSurfaces;
	readonly keys: string[];
	/** Run due timers, acknowledge frames and deliver terminal input until quiet. */
	settle(): void;
	/** Surfaces the terminal holds, by mode. */
	open(mode: string): { id: string; role?: string; title?: string }[];
	press(id: string): void;
}

const harnesses: (Harness & { connection: TspConnection })[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) {
		h.surfaces.stop(false);
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
	const surface = createSurface(template);
	const keys: string[] = [];
	const surfaces = new NativeSurfaces({
		surface,
		title: "app",
		role: "app.session",
		onKey: key => {
			keys.push(`global:${key.id}`);
			return true;
		},
	});
	const harness = {
		tern,
		surface,
		surfaces,
		connection,
		keys,
		settle() {
			for (let i = 0; i < 20; i++) {
				clock.advance(0);
				tern.pump();
			}
		},
		open(mode: string) {
			const closed = new Set(tern.sent("x").map(close => (close as { id: string }).id));
			return (tern.sent("o") as { id: string; mode: string; role?: string; title?: string }[])
				.filter(open => open.mode === mode && tern.docs.has(open.id) && !closed.has(open.id))
				.map(({ id, role, title }) => ({ id, role, title }));
		},
		press(id: string) {
			tern.input({ type: "key", key: { id, kind: "press", raw: id } });
			harness.settle();
		},
	};
	harnesses.push(harness);
	surfaces.start(connection);
	harness.settle();
	return harness;
}

const key = (onKey: (key: KeyEvent) => boolean) => onKey;

describe("pages", () => {
	it("draws a page on a screen surface of its own and resumes the session surface when it closes", async () => {
		const note = signal("before");
		const page = signal(false);
		const h = await mount(() => ({
			main: <text key="note" text={note} />,
			dock: <editor key="field" text="" cursor={0} />,
			layer: () =>
				page() ? (
					<overlay key="page" size="full" role="app.screen" page={{ role: "app.rewind", dock: 1 }}>
						<text key="replica" text="replica" />
						<row key="bar" role="app.rewind.bar" />
					</overlay>
				) : null,
		}));
		const inline = h.open("inline")[0]!;
		expect(inline).toEqual({ id: inline.id, role: "app.session", title: "app" });
		expect(h.open("screen")).toEqual([]);

		page.set(true);
		note.set("changed under the page");
		h.settle();
		const screen = h.open("screen")[0]!;
		expect(screen).toEqual({ id: screen.id, role: "app.rewind", title: "app" });
		expect(h.tern.doc(screen.id).shape("main")).toEqual([{ k: "text", p: { text: "replica" } }]);
		expect(h.tern.doc(screen.id).shape("dock")).toEqual([{ k: "row", p: { role: "app.rewind.bar" } }]);
		// The page is no sheet of the session, and the covered session surface is left as it was.
		expect(h.tern.doc(inline.id).shape("layer")).toEqual([]);
		expect(h.tern.doc(inline.id).shape("main")).toEqual([{ k: "text", p: { text: "before" } }]);

		page.set(false);
		h.settle();
		expect(h.open("screen")).toEqual([]);
		expect(h.tern.doc(inline.id).shape("main")).toEqual([{ k: "text", p: { text: "changed under the page" } }]);
		expect(h.tern.errors).toEqual([]);
	});

	it("gives the page's handlers the keys and events of what it holds", async () => {
		const seen: string[] = [];
		let field: UiNode | undefined;
		const h = await mount(() => ({
			dock: <editor key="composer" text="" cursor={0} />,
			layer: (
				<overlay
					key="page"
					size="full"
					page={{}}
					onKey={key(pressed => {
						seen.push(`page:${pressed.id}`);
						return pressed.id === "q";
					})}
					onAction={act => seen.push(`act:${act}`)}
				>
					<text
						key="close"
						text="Close"
						actions={{ click: "close" }}
						ref={node => {
							field = node;
						}}
					/>
				</overlay>
			),
		}));
		h.surface.focus(field!);
		h.settle();
		h.press("q");
		h.press("x");
		expect(seen).toEqual(["page:q", "page:x"]);
		expect(h.keys).toEqual(["global:x"]);

		const screen = h.open("screen")[0]!;
		// A page without a role of its own is styled as the session it belongs to.
		expect(screen.role).toBe("app.session");
		const close = [...h.tern.doc(screen.id).nodes.values()].find(node => node.k === "text")!;
		h.tern.event({ ev: "action", sf: screen.id, id: close.id, act: "close" });
		h.settle();
		expect(seen.at(-1)).toBe("act:close");
	});

	it("sends a page's lone picker as a sheet of the session and keeps the wrapper on its key path", async () => {
		const seen: string[] = [];
		let menu: UiNode | undefined;
		const h = await mount(() => ({
			layer: (
				<overlay
					key="menu"
					size="full"
					role="app.screen"
					page={{}}
					ref={node => (menu = node)}
					onKey={key(pressed => {
						seen.push(pressed.id);
						return true;
					})}
				>
					<picker key="models" title="Models" items={[]} />
				</overlay>
			),
		}));
		h.surface.focus(menu!);
		h.settle();
		expect(h.open("screen")).toEqual([]);
		const inline = h.open("inline")[0]!;
		expect(h.tern.doc(inline.id).shape("layer")).toEqual([{ k: "picker", p: { title: "Models", items: [] } }]);
		h.press("down");
		expect(seen).toEqual(["down"]);
		expect(h.keys).toEqual([]);
	});
});

describe("terminal focus", () => {
	it("names the first text field under the focused node, and nothing when it holds none", async () => {
		const editing = signal(false);
		let sheet: UiNode | undefined;
		const h = await mount(() => ({
			dock: <editor key="composer" text="" cursor={0} />,
			layer: (
				<overlay key="sheet" anchor="center" size="md" modal ref={node => (sheet = node)}>
					<text key="title" text="Rename" />
					{() => (editing() ? <input key="name" text="draft" cursor={5} /> : null)}
				</overlay>
			),
		}));
		const doc = h.tern.doc(h.open("inline")[0]!.id);
		h.surface.focus(sheet!);
		h.settle();
		expect(doc.focus).toBeNull();

		editing.set(true);
		h.settle();
		expect(doc.nodes.get(doc.focus ?? "")?.k).toBe("input");
	});
});

describe("narrow panes", () => {
	const tall = (rows: number) => Array.from({ length: rows }, (_, i) => <text key={`r${i}`} text={`row ${i}`} />);
	const sheetSize = (h: Harness): unknown => {
		const layer = h.tern.doc(h.open("inline")[0]!.id).shape("layer") as { p: { size?: string } }[];
		return layer[0]?.p.size;
	};

	it("fills the pane with a centered sheet once its content is tall, and keeps it full", async () => {
		const rows = signal(20);
		const template = () => ({
			layer: (
				<overlay key="sheet" anchor="center" size="lg" modal>
					{() => tall(rows())}
				</overlay>
			),
		});
		const narrow = await mount(template, { cols: 80 });
		expect(sheetSize(narrow)).toBe("full");
		rows.set(2);
		narrow.settle();
		expect(sheetSize(narrow)).toBe("full");

		rows.set(20);
		const wide = await mount(template, { cols: 120 });
		expect(sheetSize(wide)).toBe("lg");
	});

	it("leaves a short sheet floating", async () => {
		const h = await mount(
			() => ({
				layer: (
					<overlay key="sheet" anchor="center" size="lg" modal>
						{tall(3)}
					</overlay>
				),
			}),
			{ cols: 80 },
		);
		expect(sheetSize(h)).toBe("lg");
	});
});
