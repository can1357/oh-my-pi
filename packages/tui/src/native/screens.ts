/**
 * The surfaces of a native host: the program's inline surface and, while a
 * page is open, the `screen` surface that covers it.
 *
 * A page is a full-size `overlay` carrying {@link PageProps} (a fullscreen
 * app, the rewind screen, the setup wizard). Tern does not draw it as a sheet
 * in the session's `layer`: it gets a surface of its own (`mode: "screen"`,
 * the page's role), whose `main` is the overlay's children, whose `dock` is
 * the last `page.dock` of them, and whose `layer` holds whatever the program
 * opened above the page. While it is up the inline surface sends nothing and
 * takes no input; it catches up when the page closes. Two pages in a row
 * share one screen surface when they have the same role.
 *
 * A page whose only child is a `picker` or `prefs` node is no page: those
 * kinds are sheets of their own, so the child goes into `layer` bare, over
 * the session. A `picker` of `size: "screen"` (a program that is only the
 * picker) is the exception: it is the page's `main`.
 *
 * Neither a page nor the wrapper of a bare sheet is described, but each stays
 * the root of the key and event paths of what it holds, so handlers on it
 * keep working.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { TspFrame } from "@oh-my-pi/pi-wire";
import type { InputEvent } from "../driver/contract";
import type { KeyEvent } from "../events";
import type { UiNode } from "../node";
import { type Accessor, computed, createRoot, effect } from "../reactive";
import type { Surface } from "../surface";
import type { PageProps } from "../types";
import { NativeBackend } from "./backend";
import type { TspConnection } from "./connection";

/** Options of {@link NativeSurfaces}. */
export interface NativeSurfacesOptions {
	readonly surface: Surface;
	/** The title every surface opens with. */
	readonly title?: string;
	/** The inline surface's role, and a page's unless it names its own. */
	readonly role?: string;
	/** Keys nothing on the focus path consumed (global shortcuts). Return true when handled. */
	readonly onKey?: (key: KeyEvent) => boolean;
	/** Sees every decoded input event before routing; true consumes it. */
	readonly intercept?: (event: InputEvent) => boolean;
	/** Sees every frame after it is sent. */
	readonly onFrame?: (frame: TspFrame) => void;
}

interface Page {
	readonly node: UiNode;
	/** Its position in the surface's `layer`. */
	readonly index: number;
	readonly role: string | undefined;
	readonly dock: number;
}

const NONE: readonly UiNode[] = [];

function pageOf(node: UiNode): PageProps | undefined {
	if (node.kind !== "overlay") return undefined;
	const props = node.props() as { readonly page?: PageProps; readonly hidden?: boolean };
	return props.hidden ? undefined : props.page;
}

/** The sheet a page overlay stands for in `layer` (its lone `picker` or `prefs` child), if it is one. */
function sheetOf(node: UiNode): UiNode | undefined {
	if (!pageOf(node)) return undefined;
	const children = node.children();
	const only = children.length === 1 ? children[0]! : undefined;
	if (!only || (only.kind !== "picker" && only.kind !== "prefs")) return undefined;
	// A picker sized to the screen is the page's content, not a sheet over the session.
	return (only.props() as { readonly size?: string }).size === "screen" ? undefined : only;
}

/** `nodes` with every bare sheet's wrapper replaced by the sheet. */
function bare(nodes: readonly UiNode[]): readonly UiNode[] {
	let out: UiNode[] | undefined;
	for (let i = 0; i < nodes.length; i++) {
		const sheet = sheetOf(nodes[i]!);
		if (sheet) (out ??= nodes.slice())[i] = sheet;
	}
	return out ?? nodes;
}

/** The topmost page of `layer`, if any. */
function topPage(layer: readonly UiNode[]): Page | undefined {
	for (let index = layer.length - 1; index >= 0; index--) {
		const node = layer[index]!;
		const page = pageOf(node);
		if (!page || sheetOf(node)) continue;
		return { node, index, role: page.role, dock: Math.max(0, page.dock ?? 0) };
	}
	return undefined;
}

function samePage(a: Page | undefined, b: Page | undefined): boolean {
	return a?.node === b?.node && a?.index === b?.index && a?.role === b?.role && a?.dock === b?.dock;
}

/** See the module docs. */
export class NativeSurfaces {
	readonly #options: NativeSurfacesOptions;
	readonly #page: Accessor<Page | undefined>;
	readonly #inline: NativeBackend;
	readonly #pageSurface: Surface;
	#screen: { readonly backend: NativeBackend; readonly role: string | undefined } | undefined;
	#connection: TspConnection | undefined;
	#unwatch: (() => void) | undefined;

	constructor(options: NativeSurfacesOptions) {
		this.#options = options;
		const surface = options.surface;
		const page = computed(() => topPage(surface.layer()), { equals: samePage });
		this.#page = page;
		const below = computed(() => {
			const top = page();
			return bare(top ? surface.layer().slice(0, top.index) : surface.layer());
		});
		this.#inline = new NativeBackend({
			...this.#shared(),
			...(options.role === undefined ? {} : { role: options.role }),
			surface: { ...surface, layer: below },
			active: () => page() === undefined,
			parentOf: top => this.#parentOf(top, undefined),
		});
		const split = (dock: boolean): readonly UiNode[] => {
			const top = page();
			if (!top) return NONE;
			const children = top.node.children();
			const at = Math.max(0, children.length - top.dock);
			return dock ? children.slice(at) : top.dock === 0 ? children : children.slice(0, at);
		};
		this.#pageSurface = {
			main: computed(() => split(false)),
			dock: computed(() => split(true)),
			layer: computed(() => {
				const top = page();
				return top ? bare(surface.layer().slice(top.index + 1)) : NONE;
			}),
			focused: surface.focused,
			focus: node => surface.focus(node),
			dispose: () => {},
		};
	}

	#shared(): Pick<NativeSurfacesOptions, "title" | "onKey" | "intercept" | "onFrame"> {
		const { title, onKey, intercept, onFrame } = this.#options;
		return {
			...(title === undefined ? {} : { title }),
			...(onKey ? { onKey } : {}),
			...(intercept ? { intercept } : {}),
			...(onFrame ? { onFrame } : {}),
		};
	}

	/** Open the inline surface on `connection`, and the page's screen surface when a page is open. */
	start(connection: TspConnection): void {
		if (this.#connection) return;
		this.#connection = connection;
		this.#inline.start(connection);
		this.#unwatch = createRoot(dispose => {
			effect(() => this.#sync(this.#page()));
			return dispose;
		});
	}

	/** Close every surface; `keep` leaves the inline surface's `main` in scrollback (and adoptable). */
	stop(keep = true): void {
		if (!this.#connection) return;
		this.#unwatch?.();
		this.#unwatch = undefined;
		this.#connection = undefined;
		const screen = this.#screen;
		this.#screen = undefined;
		try {
			screen?.backend.stop(false);
		} finally {
			screen?.backend.dispose();
			this.#inline.stop(keep);
		}
	}

	/** Describe again the settled block of the inline surface holding `node` (see {@link Host.redescribe}). */
	redescribe(node: UiNode): void {
		this.#inline.redescribe(node);
	}

	/** Route `event` to the surface on top as if the terminal sent it (no interception). */
	dispatch(event: InputEvent): void {
		(this.#screen?.backend ?? this.#inline).dispatch(event);
	}

	/** The wire id `node` is described under on the surface that shows it, if it is. */
	idOf(node: UiNode): string | undefined {
		return this.#screen?.backend.idOf(node) ?? this.#inline.idOf(node);
	}

	/** The undescribed node `top` stands under: its page, or the wrapper of the bare sheet it is. */
	#parentOf(top: UiNode | undefined, page: Page | undefined): UiNode | undefined {
		if (!top) return page?.node;
		if (page?.node.children().includes(top)) return page.node;
		return this.#options.surface.layer().find(node => sheetOf(node) === top);
	}

	#sync(page: Page | undefined): void {
		const connection = this.#connection;
		if (!connection) return;
		const role = page ? (page.role ?? this.#options.role) : undefined;
		const open = this.#screen;
		if (open && (!page || open.role !== role)) {
			// A page with another role is another surface: the terminal styles it by the role it opened with.
			this.#screen = undefined;
			try {
				open.backend.stop(false);
			} finally {
				open.backend.dispose();
			}
		}
		if (!page) {
			if (open) logger.debug("TSP: page closed; the inline surface takes input again", { sf: this.#inline.id });
			this.#inline.requestFrame();
			return;
		}
		if (this.#screen) return;
		// A page the terminal never shows leaves the session frozen: say when one takes over.
		logger.debug("TSP: page covers the inline surface; it takes no input until the page closes", {
			sf: this.#inline.id,
			role,
		});
		const backend = new NativeBackend({
			...this.#shared(),
			surface: this.#pageSurface,
			mode: "screen",
			...(role === undefined ? {} : { role }),
			parentOf: top => this.#parentOf(top, this.#page()),
		});
		this.#screen = { backend, role };
		backend.start(connection);
	}
}
