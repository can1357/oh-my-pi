/**
 * Inline images for the terminal renderer.
 *
 * One {@link TerminalImages} per terminal. Painters call {@link TerminalImages.rows}
 * to get the rows of an image at a size: rows carrying placements
 * (kitty), placeholder cells (kitty `U=1`), an anchored SIXEL/iTerm2
 * sequence, reserved rows while a SIXEL encode runs, or text fallback rows.
 * The writer emits {@link TerminalImages.takeSequences} (transmits, virtual
 * placements, deletes) before the frame's rows.
 *
 * Frame protocol, per frame:
 * 1. paint (painters call `rows`; each call references the image until the
 *    painting computation reruns or is disposed);
 * 2. `settle()`; when it returns true the budget demoted or restored images:
 *    paint again (only the affected blocks recompute) and settle again;
 * 3. write `takeSequences()`, then the rows.
 *
 * Kitty specifics: kitty draws PNG only, so other formats are converted
 * off the JavaScript thread first (their rows stay reserved meanwhile).
 * kitty and Ghostty keep one image store per screen and start the
 * alternate screen's empty on every switch, so transmits are tracked per
 * screen; an erase of the main screen frees every image without a
 * placement, so a display reset transmits everything again after it.
 *
 * Budget: at most `budget` images are drawn at once, the most recently
 * added ones; older referenced images show their text fallback in the rows
 * the image took, so nothing below moves. Kitty keeps transmitted data
 * (so scrollback copies stay visible) for at most `budget` images; the
 * oldest images no longer drawn are freed first.
 */
import { encodeSixelAsync } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { TerminalCapabilities } from "../contract";
import type { Screen } from "../output/writer";
import { type Accessor, batch, getOwner, onCleanup, type Signal, signal } from "../../reactive";
import { truncate, visibleWidth } from "../../text/width";
import { anchoredRows, RESERVED_ROW, reservedRows } from "./anchor";
import { DEFAULT_CELL, fitImage, type ImageBounds, type ImageBox } from "./fit";
import { itermImage } from "./iterm";
import {
	KITTY_MAX_ID,
	kittyDelete,
	kittyDeleteAll,
	kittyPlacementRows,
	kittyPlaceholderRows,
	kittyPlaceholdersFit,
	kittyTransmit,
	kittyVirtualPlace,
} from "./kitty";
import { type SixelEncoder, sixelBackground } from "./sixel";

/** Images drawn at once unless configured otherwise. */
export const DEFAULT_IMAGE_BUDGET = 8;

/** An image file to draw. */
export interface ImageSource {
	/** Identity of the picture: equal keys share one terminal image (kitty transmits it once). */
	readonly key: string;
	/** The file, base64. */
	readonly data: string;
	/** `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Kitty draws PNG only. */
	readonly mime: string;
	/** Intrinsic size. */
	readonly widthPx: number;
	readonly heightPx: number;
}

/** How to draw an image: cell caps plus the text shown when it cannot be drawn. */
export interface ImageRequest extends ImageBounds {
	/** Fallback label (already styled), cut to `maxColumns`. */
	readonly fallback: string;
	/**
	 * Draw only as cells of text (kitty Unicode placeholders), which other text may share a row
	 * with (a thumbnail inside a border). A terminal that draws images any other way gets the
	 * one-row fallback, and the image is neither held nor transmitted.
	 */
	readonly cells?: boolean;
}

/** What the rows show. */
export type ImageRowsState = "image" | "pending" | "fallback";

/** The rows of an image. */
export interface ImageRows {
	readonly rows: readonly string[];
	/** Cells the content spans horizontally (rows themselves may measure 0: placements are zero-width). */
	readonly columns: number;
	readonly state: ImageRowsState;
}

/** Configuration of a {@link TerminalImages}. */
export interface TerminalImagesOptions {
	/** The terminal's capabilities (protocol, cell size, background, multiplexer); read reactively. */
	readonly capabilities: Accessor<TerminalCapabilities>;
	/** Kitty Unicode placeholders usable (see `kittyPlaceholdersSupported`); read reactively. Default off. */
	readonly placeholders?: Accessor<boolean>;
	/** Images drawn at once; 0 or less: unlimited. Default {@link DEFAULT_IMAGE_BUDGET}. */
	readonly budget?: number;
	/** SIXEL encoder. Default: `@oh-my-pi/pi-natives` off-thread encoder. */
	readonly encodeSixel?: SixelEncoder;
	/** Converts image bytes to PNG (base64) for kitty. Default: `Bun.Image`. */
	readonly convertPng?: PngConverter;
	/**
	 * Kitty may draw now; while false, kitty images keep their rows reserved
	 * (Ghostty drops graphics commands sent right after it starts). Read reactively. Default: always.
	 */
	readonly kittyReady?: Accessor<boolean>;
}

/** Converts image bytes (any format the runtime decodes) to base64 PNG. */
export type PngConverter = (bytes: Uint8Array) => Promise<string>;

const bunPng: PngConverter = bytes => new Bun.Image(bytes).png().toBase64();

/** A SIXEL encode: undefined while running, null when it failed. */
type SixelResult = Signal<string | null | undefined>;

interface Entry {
	readonly key: string;
	readonly id: number;
	/** Addition order: larger is newer. */
	readonly seq: number;
	source: ImageSource;
	/** Painting computations currently showing this image. */
	refs: number;
	/** Within the budget (drawn) or demoted to its fallback. */
	readonly live: Signal<boolean>;
	/** Kitty: the screens whose image store holds the data. */
	readonly held: Set<Screen>;
	/** Kitty placement-id slots by cell box (`CxR`); a slot owns a range of placement ids. */
	readonly slots: Map<string, number>;
	/** Kitty: virtual placements each screen's store holds, by slot. */
	readonly virtual: Record<Screen, Set<number>>;
	/** Kitty: the PNG conversion of a non-PNG source (undefined while running, null when it failed). */
	png: Signal<string | null | undefined> | undefined;
	/** SIXEL encodes by `WxH@background`, oldest first. */
	readonly sixel: Map<string, SixelResult>;
}

/** Placement ids one slot spans (one per image row in direct mode). */
const SLOT_SPAN = 4096;
/** SIXEL encodes kept per image (sizes × backgrounds). */
const MAX_SIXEL_ENCODES = 4;
/** Ids handed out by one store before wrapping (keeps ids clear of the 24-bit limit). */
const ID_RANGE = 0x10_0000;

/** Inline images of one terminal: rows for painters, transmit/delete sequences for the writer, the budget. */
export class TerminalImages {
	readonly #capabilities: Accessor<TerminalCapabilities>;
	readonly #placeholders: Accessor<boolean>;
	readonly #encodeSixel: SixelEncoder;
	#budget: number;
	readonly #entries = new Map<string, Entry>();
	#seq = 0;
	readonly #idBase: number;
	#idNext = 0;
	/** Reference counts changed since the last settle. */
	#dirty = false;
	/** Deletes decided by settle/reset, per screen, written with that screen's next sequences. */
	#queued: Record<Screen, string> = { main: "", alternate: "" };
	readonly #convertPng: PngConverter;
	readonly #kittyReady: Accessor<boolean>;
	readonly #encoding = new Set<Promise<unknown>>();

	constructor(options: TerminalImagesOptions) {
		this.#capabilities = options.capabilities;
		this.#placeholders = options.placeholders ?? (() => false);
		this.#encodeSixel = options.encodeSixel ?? encodeSixelAsync;
		this.#convertPng = options.convertPng ?? bunPng;
		this.#kittyReady = options.kittyReady ?? (() => true);
		this.#budget = options.budget ?? DEFAULT_IMAGE_BUDGET;
		// A random base keeps two programs sharing one terminal (tmux panes) off each other's ids.
		this.#idBase = 1 + Math.floor(Math.random() * (KITTY_MAX_ID - ID_RANGE));
	}

	/** Images drawn at once (0 or less: unlimited). */
	get budget(): number {
		return this.#budget;
	}

	/** Change the budget; takes effect at the next settle. */
	setBudget(budget: number): void {
		if (budget === this.#budget) return;
		this.#budget = budget;
		this.#dirty = true;
	}

	/**
	 * The rows `source` takes under `request`, for the current terminal.
	 * Must run inside a reactive owner (a painter): the image stays
	 * referenced until that computation reruns or is disposed, and the rows
	 * depend on the capabilities, the budget and pending SIXEL encodes.
	 */
	rows(source: ImageSource, request: ImageRequest): ImageRows {
		if (!getOwner()) throw new Error("pi-tui: TerminalImages.rows must run inside a painter (a reactive owner)");
		const caps = this.#capabilities();
		const label =
			request.maxColumns === undefined ? request.fallback : truncate(request.fallback, request.maxColumns);
		const protocol = caps.images;
		if (protocol === null) return { rows: [label], columns: visibleWidth(label), state: "fallback" };
		const box = fitImage(source.widthPx, source.heightPx, request, caps.cell ?? DEFAULT_CELL);
		const placeholders = protocol === "kitty" && this.#placeholders() && kittyPlaceholdersFit(box.columns, box.rows);
		// Placements and SIXEL/iTerm2 sequences address the screen: nothing else can share their rows.
		if (request.cells && !placeholders) return { rows: [label], columns: visibleWidth(label), state: "fallback" };
		const entry = this.#acquire(source);
		const fallback = (): ImageRows => ({
			rows: [label, ...Array.from({ length: box.rows - 1 }, () => RESERVED_ROW)],
			columns: visibleWidth(label),
			state: "fallback",
		});
		if (!entry.live()) return fallback();
		switch (protocol) {
			case "kitty": {
				const data = this.#kittyData(entry);
				if (data === null) return fallback();
				if (data === undefined || !this.#kittyReady()) {
					return { rows: reservedRows(box.rows), columns: box.columns, state: "pending" };
				}
				const slot = this.#slot(entry, box);
				if (placeholders) {
					const rows = kittyPlaceholderRows({
						id: entry.id,
						placement: slot + 1,
						columns: box.columns,
						rows: box.rows,
					});
					return { rows, columns: box.columns, state: "image" };
				}
				const rows = kittyPlacementRows(
					{ id: entry.id, widthPx: source.widthPx, heightPx: source.heightPx },
					box.columns,
					Math.min(box.rows, SLOT_SPAN - 1),
					slot * SLOT_SPAN + 1,
					caps.multiplexer,
				);
				return { rows, columns: box.columns, state: "image" };
			}
			case "iterm":
				return {
					rows: anchoredRows(itermImage(source.data, box.columns, box.rows, caps.multiplexer), box.rows),
					columns: box.columns,
					state: "image",
				};
			case "sixel": {
				const sequence = this.#sixel(entry, box, sixelBackground(caps))();
				if (sequence === undefined) return { rows: reservedRows(box.rows), columns: box.columns, state: "pending" };
				if (sequence === null) return fallback();
				return { rows: anchoredRows(sequence, box.rows), columns: box.columns, state: "image" };
			}
		}
	}

	/**
	 * Apply the budget to the images referenced now: the newest `budget`
	 * are drawn, older ones fall back. Demoted kitty images are freed.
	 * Returns true when an image changed state: paint again before writing.
	 */
	settle(): boolean {
		if (!this.#dirty) return false;
		this.#dirty = false;
		const referenced = [...this.#entries.values()].filter(entry => entry.refs > 0).sort((a, b) => b.seq - a.seq);
		let changed = false;
		batch(() => {
			for (let index = 0; index < referenced.length; index++) {
				const entry = referenced[index]!;
				const live = this.#budget <= 0 || index < this.#budget;
				if (entry.live.peek() === live) continue;
				entry.live.set(live);
				changed = true;
			}
		});
		const multiplexer = this.#capabilities().multiplexer;
		for (const entry of referenced) {
			if (!entry.live.peek() && entry.held.size > 0) this.#free(entry, multiplexer);
		}
		return changed;
	}

	/**
	 * Escape sequences to write before the frame's rows: deletes of freed
	 * images, then (kitty) the data of drawn images the terminal does not
	 * hold yet and the virtual placements their placeholders need. Each
	 * transmit happens once per image until it is freed.
	 */
	takeSequences(screen: Screen = "main"): string {
		let out = this.#queued[screen];
		this.#queued[screen] = "";
		const caps = this.#capabilities();
		if (caps.images === "kitty" && this.#kittyReady()) {
			const multiplexer = caps.multiplexer;
			const placeholders = this.#placeholders();
			const ordered = [...this.#entries.values()].sort((a, b) => a.seq - b.seq);
			for (const entry of ordered) {
				if (entry.refs === 0 || !entry.live.peek()) continue;
				const data = this.#kittyData(entry, false);
				if (!data) continue;
				if (!entry.held.has(screen)) {
					out += kittyTransmit(data, entry.id, multiplexer);
					entry.held.add(screen);
				}
				if (!placeholders) continue;
				const virtual = entry.virtual[screen];
				for (const [box, slot] of entry.slots) {
					if (virtual.has(slot)) continue;
					const [columns, rows] = box.split("x").map(Number) as [number, number];
					if (!kittyPlaceholdersFit(columns, rows)) continue;
					out += kittyVirtualPlace({ id: entry.id, placement: slot + 1, columns, rows }, multiplexer);
					virtual.add(slot);
				}
			}
			this.#trimResidents(ordered, multiplexer);
			out += this.#queued[screen];
			this.#queued[screen] = "";
		}
		for (const [key, entry] of this.#entries) {
			if (entry.refs === 0 && entry.held.size === 0) this.#entries.delete(key);
		}
		return out;
	}

	/** The alternate screen was entered: its image store starts empty. */
	enteredAlternate(): void {
		this.#queued.alternate = "";
		for (const entry of this.#entries.values()) {
			entry.held.delete("alternate");
			entry.virtual.alternate.clear();
		}
	}

	/**
	 * The main screen and its history are being erased (the erase precedes
	 * the next main-screen sequences). The erase frees images left without a
	 * placement, so every image is deleted outright (placements included:
	 * terminals that keep a placement anchored in erased scrollback move it
	 * on screen; virtual placements survive a delete-all, so they go by id)
	 * and transmitted again when drawn.
	 */
	cleared(): void {
		if (this.#capabilities().images !== "kitty") return;
		const multiplexer = this.#capabilities().multiplexer;
		let out = kittyDeleteAll(multiplexer);
		for (const entry of this.#entries.values()) {
			if (entry.held.has("main")) out += kittyDelete(entry.id, multiplexer);
			entry.held.delete("main");
			entry.virtual.main.clear();
		}
		this.#queued.main += out;
	}

	/**
	 * The terminal display was reset (history and screen cleared): free every
	 * kitty image now; the next sequences transmit the drawn ones again.
	 */
	reset(): void {
		const multiplexer = this.#capabilities().multiplexer;
		for (const entry of this.#entries.values()) {
			if (entry.held.size > 0) this.#free(entry, multiplexer);
		}
	}

	/**
	 * Delete sequences for every image the terminal holds (session cleanup),
	 * plus anything still queued. Scrollback copies disappear with them; skip
	 * this on exit to keep them.
	 */
	purge(screen: Screen = "main"): string {
		this.reset();
		const out = this.#queued[screen];
		this.#queued = { main: "", alternate: "" };
		return out;
	}

	/** Resolves once every SIXEL encode started so far has finished. */
	async whenEncoded(): Promise<void> {
		while (this.#encoding.size > 0) await Promise.allSettled(this.#encoding);
	}

	#acquire(source: ImageSource): Entry {
		let entry = this.#entries.get(source.key);
		if (!entry) {
			entry = {
				key: source.key,
				id: this.#allocateId(),
				seq: ++this.#seq,
				source,
				refs: 0,
				live: signal(true),
				held: new Set(),
				slots: new Map(),
				virtual: { main: new Set(), alternate: new Set() },
				png: undefined,
				sixel: new Map(),
			};
			this.#entries.set(source.key, entry);
		} else if (entry.source.data !== source.data) {
			// Same key, new pixels: drop what the terminal and the encoder hold for the old ones.
			if (entry.held.size > 0) this.#free(entry, this.#capabilities().multiplexer);
			entry.sixel.clear();
			entry.png = undefined;
		}
		entry.source = source;
		entry.refs++;
		this.#dirty = true;
		const held = entry;
		onCleanup(() => {
			held.refs--;
			this.#dirty = true;
		});
		return entry;
	}

	#allocateId(): number {
		const used = new Set<number>();
		for (const entry of this.#entries.values()) used.add(entry.id);
		for (;;) {
			const id = this.#idBase + (this.#idNext++ % ID_RANGE);
			if (!used.has(id)) return id;
		}
	}

	#slot(entry: Entry, box: ImageBox): number {
		const key = `${box.columns}x${box.rows}`;
		let slot = entry.slots.get(key);
		if (slot === undefined) {
			slot = entry.slots.size;
			entry.slots.set(key, slot);
		}
		return slot;
	}

	#sixel(entry: Entry, box: ImageBox, background: number): SixelResult {
		const key = `${box.widthPx}x${box.heightPx}@${background}`;
		const known = entry.sixel.get(key);
		if (known) return known;
		const result: SixelResult = signal<string | null | undefined>(undefined);
		entry.sixel.set(key, result);
		if (entry.sixel.size > MAX_SIXEL_ENCODES) {
			const oldest = entry.sixel.keys().next().value;
			if (oldest !== undefined) entry.sixel.delete(oldest);
		}
		const bytes = Buffer.from(entry.source.data, "base64");
		const encoding = this.#encodeSixel(bytes, box.widthPx, box.heightPx, background).then(
			sequence => result.set(sequence),
			(error: unknown) => {
				logger.warn("pi-tui: SIXEL encode failed", { key: entry.key, error: String(error) });
				result.set(null);
			},
		);
		this.#encoding.add(encoding);
		void encoding.finally(() => this.#encoding.delete(encoding));
		return result;
	}

	#free(entry: Entry, multiplexer: TerminalCapabilities["multiplexer"]): void {
		for (const screen of entry.held) this.#queued[screen] += kittyDelete(entry.id, multiplexer);
		entry.held.clear();
		entry.virtual.main.clear();
		entry.virtual.alternate.clear();
	}

	/**
	 * The PNG data kitty gets for `entry`: the source itself, or its
	 * conversion (undefined while it runs, null when it failed). `track`
	 * makes a painter rerun once the conversion lands.
	 */
	#kittyData(entry: Entry, track = true): string | null | undefined {
		if (entry.source.mime === "image/png") return entry.source.data;
		if (!entry.png) {
			const result = signal<string | null | undefined>(undefined);
			entry.png = result;
			const source = entry.source;
			const converting = this.#convertPng(Buffer.from(source.data, "base64")).then(
				png => result.set(png),
				(error: unknown) => {
					logger.warn("pi-tui: PNG conversion failed", {
						key: entry.key,
						mime: source.mime,
						error: String(error),
					});
					result.set(null);
				},
			);
			this.#encoding.add(converting);
			void converting.finally(() => this.#encoding.delete(converting));
		}
		return track ? entry.png() : entry.png.peek();
	}

	/** Free the oldest kitty images not drawn now until at most `budget` stay resident (deletes are queued). */
	#trimResidents(ordered: readonly Entry[], multiplexer: TerminalCapabilities["multiplexer"]): void {
		if (this.#budget <= 0) return;
		let resident = 0;
		for (const entry of ordered) if (entry.held.size > 0) resident++;
		for (const entry of ordered) {
			if (resident <= this.#budget) break;
			if (entry.held.size === 0 || (entry.refs > 0 && entry.live.peek())) continue;
			this.#free(entry, multiplexer);
			resident--;
		}
	}
}
