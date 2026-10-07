/**
 * Native (Tern Surface Protocol) backend: owns the surfaces a TSP terminal
 * shows, sends reconciled frames under credit-based flow control, uploads
 * blobs, and routes terminal events back to components.
 *
 * Surfaces. An inline surface (`mode:"inline"`) holds the session: its root
 * (id = surface id) gets the fixed regions `main`, `dock` and `layer` on the
 * first frame. While a fullscreen overlay is topmost, a `mode:"screen"`
 * surface shows it instead and the inline surface pauses (the way the ANSI
 * path borrows the alternate screen); closing the overlay closes that surface
 * and the next inline frame catches up.
 *
 * Flow control. At most `credits` frames per surface are unacknowledged. A
 * render while blocked only marks the surface dirty; the next `ack` reconciles
 * once against the last sent state, so every intermediate change coalesces
 * into one frame (`set`s merged, `text append`s joined).
 *
 * Blobs. Each image's bytes reach the terminal once per connection. A
 * terminal with the `blobs` feature is asked first which it already holds:
 * under `TERN_BLOB_DIR` (Tern's on-disk blob cache, on this machine) every new
 * blob is written there and then asked about, so its bytes never cross the
 * pty; otherwise the first pass after (re)connecting asks, so a resumed
 * session doesn't resend what the terminal kept. Whatever the reply lacks
 * (or a reply that never comes) is sent inline with `b`. Frames never wait:
 * the terminal draws an image whose blob arrives after the frame.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	TSP_DEFAULT_APC_LIMIT,
	TSP_DEFAULT_CREDITS,
	TSP_KINDS,
	TSP_VERSION,
	type TspEvent,
	type TspFrame,
	type TspKind,
	type TspNode,
	type TspOp,
} from "@oh-my-pi/pi-wire";
import type { Terminal } from "../terminal";
import {
	bindTheme,
	getCurrentThemeName,
	getNativeThemePalette,
	getNativeThemePaletteKey,
	isLightTheme,
	type NativeThemePalette,
	setNativeSymbolPreset,
} from "../theme/theme";
import type { Component, OverlayOptions, RenderScheduler, RenderTimer } from "../tui";
import { TspDocument } from "./apply";
import { getNativeBlob, type NativeBlob } from "./blobs";
import { node } from "./describe";
import { encodeTspJson, encodeTspMessage, type TspHello, TspReader, splitTspMessage } from "./encode";
import type { DescribeContext, NativeChild, NativeNode, NativeSurface, NativeUiEvent } from "./node";
import { nativeComponentId, Reconciler } from "./reconcile";
import { setNativeRendering } from "./state";

/** A visible TUI overlay, bottom to top. */
export interface NativeOverlay {
	readonly component: Component;
	readonly options: OverlayOptions | undefined;
	/** Keyboard focus is inside this overlay. */
	readonly focused: boolean;
}

/** What the backend needs from the TUI. */
export interface NativeHost {
	readonly terminal: Terminal;
	/** `main`/`dock` content: the frame provider's surface, or the TUI children. */
	describeSurface(cx: DescribeContext): NativeSurface;
	/** Visible overlays, bottom to top. */
	overlays(): readonly NativeOverlay[];
	/** Component receiving keyboard input. */
	focused(): Component | null;
	/**
	 * The user clicked into a node described by `owners[0]` (then the
	 * components containing it, innermost first): move keyboard focus there.
	 * `field` is the outermost owner that takes keys and whose focus target is
	 * the clicked `editor`/`input`, if any; `sheet` tells the overlays that
	 * don't hold the keys while the user works beside them.
	 */
	focusFromPointer(
		owners: readonly Component[],
		field: Component | null,
		sheet: (overlay: Component) => boolean,
	): void;
	requestRender(): void;
	/** The terminal switched appearance. */
	appearanceChanged(dark: boolean): void;
	/** Reduce Motion toggled. */
	motionChanged(reduce: boolean): void;
	/** Theme-derived output changed (symbol preset): drop render and describe caches. */
	invalidate(): void;
}

export interface NativeBackendOptions {
	/** Keep the reference document and recent frames for debugging. */
	readonly mirror?: boolean;
	/** Append every TSP message to this JSONL file. Defaults to `PI_TUI_TSP_RECORD`. */
	readonly recordPath?: string;
	/** Log the `rows` fallback count per frame. Defaults to `PI_TUI_NATIVE_STATS=1`. */
	readonly stats?: boolean;
	/** Clock and timers (stall wake-up); defaults to `Date.now` and unref'd `setTimeout`. */
	readonly scheduler?: RenderScheduler;
}

/** Real clock and timers that never keep the process alive on their own. */
const DEFAULT_SCHEDULER: RenderScheduler = {
	now: () => Date.now(),
	scheduleImmediate: callback => {
		setImmediate(callback);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return { cancel: () => clearTimeout(timer) };
	},
};

/** Frames kept for the debug `tsp` op. */
const RECENT_FRAMES = 64;
/** An unanswered frame older than this no longer holds rendering back. */
const STALLED_ACK_MS = 5000;
/** Role of the session's surfaces; a screen page may name its own. */
const SESSION_ROLE = "omp.session";
/** A `blobs` query unanswered this long counts its ids as missing: they go inline. */
const BLOB_REPLY_MS = 3000;
/** Expired queries kept to pair late replies with their queries, at most. */
const MAX_BLOB_QUERIES = 16;

/** A `blobs` query awaiting its reply; `timer` is unset once its ids no longer depend on it. */
interface BlobQuery {
	readonly ids: readonly string[];
	timer: RenderTimer | undefined;
}

/**
 * Save `blob` in the terminal's blob cache as `<dir>/<id>` (written aside,
 * then renamed; skipped when present). A failure only means the terminal
 * won't find it, so the blob goes inline.
 */
async function cacheBlob(dir: string, blob: NativeBlob): Promise<void> {
	const target = path.join(dir, blob.id);
	const temp = `${target}.tmp${process.pid}`;
	try {
		if (await Bun.file(target).exists()) return;
		// Not `Bun.write`: it would create a missing folder, which only Tern may.
		await fs.promises.writeFile(temp, blob.bytes);
		await fs.promises.rename(temp, target);
	} catch (error) {
		logger.debug("TSP: could not save a blob to the terminal's cache", { dir, id: blob.id, error: String(error) });
		await fs.promises.rm(temp, { force: true }).catch(() => {});
	}
}

/**
 * A `b` message's parameters. Tern names a blob by the sha256 of the bytes it
 * receives and ignores `id`, but Tern 0.5.3 and earlier reject a blob without
 * it, so it stays until those are gone.
 */
function blobParams(blob: NativeBlob): Record<string, string> {
	return { id: blob.id, mime: blob.mime };
}

class NativeContext implements DescribeContext {
	cols: number;
	reduceMotion: boolean;
	dark: boolean;
	hour12: boolean | undefined;
	#kinds: ReadonlySet<string>;
	#features: ReadonlySet<string>;

	constructor(hello: TspHello, cols: number) {
		this.cols = cols;
		this.reduceMotion = hello.reduceMotion === true;
		this.dark = hello.dark !== false;
		this.hour12 = hello.hour12;
		this.#kinds = new Set(hello.kinds);
		this.#features = new Set(hello.features);
	}

	supports(kind: TspKind): boolean {
		return this.#kinds.has(kind);
	}

	feature(name: string): boolean {
		return this.#features.has(name);
	}

	/** Whether `other` advertises exactly the same kinds and features. */
	sameVocabulary(other: NativeContext): boolean {
		return sameSet(this.#kinds, other.#kinds) && sameSet(this.#features, other.#features);
	}
}

/** Whether `a` and `b` hold the same strings. */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}

/**
 * The reply a v1 terminal is assumed to give before its real `hello` arrives
 * (the `TERM_PROGRAM=tern` optimistic start): the whole vocabulary, the
 * default APC limit and credits, the terminal's width, the appearance omp
 * already detected, full motion, and `blobs`, so a resumed session's images
 * are asked about rather than resent before the reply comes.
 */
export function assumedTspHello(terminal: Terminal): TspHello {
	const appearance = terminal.appearance;
	return {
		r: "hello",
		v: TSP_VERSION,
		term: "tern",
		kinds: TSP_KINDS,
		features: ["blobs"],
		apc: TSP_DEFAULT_APC_LIMIT,
		credits: TSP_DEFAULT_CREDITS,
		cols: terminal.columns,
		dark: appearance === undefined ? !isLightTheme(getCurrentThemeName()) : appearance === "dark",
		reduceMotion: false,
	};
}

class Surface {
	readonly id: string;
	readonly mode: "inline" | "screen";
	/** The `o` role: `omp.session`, or a screen page's own (`NativeScreen.role`). */
	readonly role: string;
	readonly reconciler: Reconciler;
	readonly doc: TspDocument | null;
	seq = 0;
	acked = 0;
	/** Send times of unacknowledged frames, oldest first. */
	unacked: number[] = [];
	focus: string | null = null;
	dirty = false;

	constructor(id: string, mode: "inline" | "screen", role: string, mirror: boolean) {
		this.id = id;
		this.mode = mode;
		this.role = role;
		this.reconciler = new Reconciler(id);
		this.doc = mirror ? new TspDocument(id) : null;
	}
}

function overlayAnchor(options: OverlayOptions | undefined): "center" | "top" | "bottom" {
	const anchor = options?.anchor;
	if (anchor?.startsWith("top")) return "top";
	if (anchor?.startsWith("bottom")) return "bottom";
	return "center";
}

function overlaySize(options: OverlayOptions | undefined, cols: number): "sm" | "md" | "lg" | "full" {
	if (options?.fullscreen) return "full";
	const width = options?.width;
	if (width === undefined) return "md";
	const fraction = typeof width === "number" ? width / Math.max(1, cols) : Number.parseFloat(width) / 100;
	if (!Number.isFinite(fraction)) return "md";
	if (fraction >= 0.75) return "lg";
	if (fraction >= 0.45) return "md";
	return "sm";
}

/** Blob ids referenced by `image` nodes an op adds or sets. */
function collectBlobs(op: TspOp, out: Set<string>): void {
	if (op[0] === "set") {
		const blob = op[2].blob;
		if (typeof blob === "string") out.add(blob);
	} else if (op[0] === "add") {
		const visit = (wire: TspNode): void => {
			if (wire.k === "image" && typeof wire.p?.blob === "string") out.add(wire.p.blob);
			if (wire.c) for (const child of wire.c) visit(child);
		};
		visit(op[4]);
	}
}

export class NativeBackend {
	#host: NativeHost;
	#hello: TspHello;
	#cx: NativeContext;
	#limit: number;
	#credits: number;
	#reader = new TspReader();
	#inline: Surface;
	#screen: Surface | null = null;
	#nextSurface = 1;
	#mirror: boolean;
	#recordPath: string | undefined;
	#stats: boolean;
	#scheduler: RenderScheduler;
	/** Wakes a render when the oldest unacked frame of a credit-blocked surface turns stalled. */
	#stallTimer: RenderTimer | undefined;
	#recent: TspFrame[] = [];
	#sawResize = false;
	#live = false;
	#overlayNodes = new Map<Component, { key: string; node: NativeNode }>();
	#unbindTheme: (() => void) | undefined;
	#palette: NativeThemePalette | undefined;
	#paletteKey: string | undefined;
	/** Serialized palette last sent, to skip resends of an unchanged theme. */
	#paletteSent: string | undefined;
	/** Blobs handled on this connection: asked about in a `blobs` query, or sent (or held by the terminal). */
	#blobs = new Map<string, "asked" | "sent">();
	/** `blobs` queries sent, oldest first: the terminal answers each once, in order. */
	#blobQueries: BlobQuery[] = [];
	/** The next pass with new blobs asks the terminal which it holds (a fresh connection). */
	#askHeld = true;
	/** Bumped when the connection resets or stops, so blob cache writes finishing later are dropped. */
	#blobEpoch = 0;

	constructor(host: NativeHost, hello: TspHello, options: NativeBackendOptions = {}) {
		this.#host = host;
		this.#hello = hello;
		this.#cx = new NativeContext(hello, hello.cols ?? host.terminal.columns);
		this.#limit = TSP_DEFAULT_APC_LIMIT;
		this.#credits = TSP_DEFAULT_CREDITS;
		this.#applyHello(hello);
		this.#mirror = options.mirror === true;
		this.#recordPath = options.recordPath ?? (Bun.env.PI_TUI_TSP_RECORD || undefined);
		this.#stats = options.stats ?? Bun.env.PI_TUI_NATIVE_STATS === "1";
		this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
		this.#inline = this.#newSurface("inline");
	}

	/** The terminal's hello reply. */
	get hello(): TspHello {
		return this.#hello;
	}

	/** Describe context shared by every surface. */
	get context(): DescribeContext {
		return this.#cx;
	}

	/** `rows` fallback nodes in the last frame. */
	get fallbackCount(): number {
		return (this.#screen ?? this.#inline).reconciler.fallbackCount;
	}

	/**
	 * Open the inline surface and send the first frame. Native rendering is
	 * announced only once the surface is open: Tern drops the shell's title
	 * when a command's first surface opens, so the tab title set on the change
	 * has to follow the `o`.
	 */
	start(): void {
		if (this.#live) return;
		this.#live = true;
		this.#useNerdSymbols(true);
		this.#watchTheme();
		this.#open(this.#inline);
		setNativeRendering(true);
		this.render();
	}

	/**
	 * Any theme swap (switch, selector preview, auto light/dark, file reload)
	 * schedules a render; `render()` resends the palette when it changed, so
	 * bursts coalesce into one `t` and no frame is needed for it.
	 */
	#watchTheme(): void {
		this.#unbindTheme?.();
		let initial = true;
		this.#unbindTheme = bindTheme(() => {
			if (initial) return;
			this.#host.requestRender();
		});
		initial = false;
	}

	/** The current palette, recomputed only when its inputs changed. */
	#currentPalette(): NativeThemePalette {
		const key = getNativeThemePaletteKey();
		if (this.#palette === undefined || key !== this.#paletteKey) {
			this.#paletteKey = key;
			this.#palette = getNativeThemePalette();
		}
		return this.#palette;
	}

	/** Send the palette to `surface` (right after its `o`, before any `f`). */
	#sendPalette(surface: Surface): void {
		const palette = this.#currentPalette();
		if (!palette.dark && !palette.light) return;
		this.#paletteSent = JSON.stringify(palette);
		this.#write("t", { sf: surface.id, ...palette });
	}

	/** Resend the palette to every open surface when the theme changed since it was sent. */
	#refreshPalette(): void {
		const key = this.#paletteKey;
		const palette = this.#currentPalette();
		if (key === this.#paletteKey || JSON.stringify(palette) === this.#paletteSent) return;
		this.#sendPalette(this.#inline);
		if (this.#screen) this.#sendPalette(this.#screen);
	}

	/**
	 * Tern's font carries every Nerd Font glyph, and it never answers the Glyph
	 * Protocol, so icons come from the nerd preset (process-local, not the
	 * user's saved setting) while a surface is live.
	 */
	#useNerdSymbols(on: boolean): void {
		if (setNativeSymbolPreset(on ? "nerd" : undefined)) this.#host.invalidate();
	}

	/**
	 * Close every surface. The inline transcript stays in scrollback unless
	 * `keep` is false (a revoked optimistic start: rows repaint from scratch).
	 */
	stop(keep = true): void {
		if (!this.#live) return;
		this.#live = false;
		if (this.#screen) this.#close(this.#screen, false);
		this.#screen = null;
		this.#close(this.#inline, keep);
		this.#inline.doc?.close();
		setNativeRendering(false);
		this.#unbindTheme?.();
		this.#unbindTheme = undefined;
		this.#useNerdSymbols(false);
		this.#clearStallTimer();
		// Replies no longer reach the backend: forget the queries outright.
		this.#resetBlobs();
		this.#blobQueries = [];
	}

	/**
	 * After a stop/start cycle (external editor, suspend): adopt the closed
	 * inline surface so the transcript continues in place instead of being
	 * printed again. A `gone` reply for it opens a fresh surface.
	 */
	resume(hello: TspHello): void {
		if (this.#live) return;
		this.#hello = hello;
		this.#applyHello(hello);
		this.#live = true;
		this.#useNerdSymbols(true);
		this.#watchTheme();
		this.#resetBlobs();
		const surface = this.#inline;
		surface.reconciler.detachLive();
		surface.unacked = [];
		surface.acked = surface.seq;
		surface.focus = null;
		surface.dirty = false;
		this.#write("o", { id: surface.id, mode: "inline", title: "omp", role: SESSION_ROLE, adopt: true });
		this.#sendPalette(surface);
		// After the `o`, as in `start()`.
		setNativeRendering(true);
		this.render();
	}

	/**
	 * The terminal's real `hello` reply after an optimistic start: adopt its
	 * APC limit, credits, cell size, kinds, appearance and motion preference.
	 * A width the terminal already reported in a `resize` event wins over the
	 * reply's. A different vocabulary, motion preference or clock re-describes
	 * every component, so kinds the terminal lacks fall back.
	 */
	confirm(hello: TspHello): void {
		const before = this.#cx;
		const sawResize = this.#sawResize;
		this.#hello = hello;
		this.#applyHello(hello);
		if (sawResize) {
			this.#cx.cols = before.cols;
			this.#sawResize = true;
		}
		if (this.#cx.dark !== before.dark) this.#host.appearanceChanged(this.#cx.dark);
		if (
			this.#cx.reduceMotion !== before.reduceMotion ||
			this.#cx.hour12 !== before.hour12 ||
			!this.#cx.sameVocabulary(before)
		)
			this.#host.invalidate();
		this.#host.requestRender();
	}

	/** SIGWINCH: refresh the width used for `rows` fallback until the terminal reports one. */
	noteTerminalColumns(columns: number): void {
		if (this.#sawResize || columns === this.#cx.cols) return;
		this.#cx.cols = columns;
		this.#host.requestRender();
	}

	/** Reconcile and send a frame, unless the target surface is out of credits. */
	render(): void {
		if (!this.#live) return;
		this.#refreshPalette();
		const overlays = this.#host.overlays();
		let fullscreen = -1;
		for (let i = overlays.length - 1; i >= 0; i--) {
			// A picker/prefs sheet floats in `layer` over the transcript even
			// when the TUI shows it fullscreen.
			const o = overlays[i]!;
			if (o.options?.fullscreen && !o.component.nativeSheet?.(this.#cx) && !o.component.nativeOverlay) {
				fullscreen = i;
				break;
			}
		}
		let surface: Surface;
		let main: readonly NativeChild[];
		let dock: readonly NativeChild[];
		let layer: NativeChild[];
		if (fullscreen >= 0) {
			const component = overlays[fullscreen]!.component;
			const page = component.describeScreen?.(this.#cx);
			const role = page?.role ?? SESSION_ROLE;
			if (this.#screen?.role !== role) {
				// A page with another role is another surface: its styling keys off the `o`.
				if (this.#screen) this.#close(this.#screen, false);
				this.#screen = this.#newSurface("screen", role);
				this.#open(this.#screen);
			}
			surface = this.#screen;
			main = page?.main ?? [component];
			dock = page?.dock ?? [];
			layer = overlays.slice(fullscreen + 1).map(overlay => this.#overlayNode(overlay));
		} else {
			if (this.#screen) {
				this.#close(this.#screen, false);
				this.#screen = null;
			}
			surface = this.#inline;
			const described = this.#host.describeSurface(this.#cx);
			main = described.main;
			dock = described.dock;
			layer = overlays.map(overlay => this.#overlayNode(overlay));
		}
		this.#pruneOverlayNodes(overlays);
		if (!this.#hasCredit(surface)) {
			surface.dirty = true;
			this.#armStallTimer(surface);
			return;
		}
		surface.dirty = false;
		const ops = surface.reconciler.reconcile({ main, dock, layer }, this.#cx);
		const focused = this.#host.focused();
		const focus = focused ? surface.reconciler.focusTarget(focused) : null;
		if (focus !== surface.focus) {
			ops.push(["focus", focus]);
			surface.focus = focus;
		}
		if (this.#stats) {
			logger.debug("TSP frame", { sf: surface.id, ops: ops.length, rows: surface.reconciler.fallbackCount });
		}
		if (ops.length === 0) return;
		this.#uploadBlobs(ops);
		this.#sendFrame(surface, ops);
	}

	/**
	 * Handle one complete `ESC _ tsp;…` input string (events and late replies).
	 * Returns false when `sequence` isn't TSP.
	 */
	handleInput(sequence: string): boolean {
		const raw = splitTspMessage(sequence);
		if (!raw) return false;
		this.#record("in", raw.verb, raw.params, raw.body);
		const message = this.#reader.feed(sequence);
		if (message?.verb === "e") this.#handleEvent(message.event);
		else if (message?.reply.r === "blobs") this.#onBlobsReply(message.reply.have);
		return true;
	}

	/** Reference document of the live surface (mirror mode only). */
	document(): TspNode | undefined {
		return (this.#screen ?? this.#inline).doc?.snapshot();
	}

	/** Last sent frames, oldest first (mirror mode only). */
	recentFrames(count = RECENT_FRAMES): readonly TspFrame[] {
		return this.#recent.slice(-count);
	}

	#applyHello(hello: TspHello): void {
		this.#limit = hello.apc !== undefined && hello.apc > 0 ? hello.apc : TSP_DEFAULT_APC_LIMIT;
		this.#credits = hello.credits !== undefined && hello.credits > 0 ? hello.credits : TSP_DEFAULT_CREDITS;
		this.#cx = new NativeContext(hello, hello.cols ?? this.#cx.cols);
		this.#sawResize = false;
	}

	#newSurface(mode: "inline" | "screen", role = SESSION_ROLE): Surface {
		return new Surface(`s:${this.#nextSurface++}`, mode, role, this.#mirror);
	}

	#open(surface: Surface): void {
		this.#write("o", { id: surface.id, mode: surface.mode, title: "omp", role: surface.role });
		this.#sendPalette(surface);
	}

	#close(surface: Surface, keep: boolean): void {
		this.#write("x", { id: surface.id, keep });
	}

	#hasCredit(surface: Surface): boolean {
		if (surface.unacked.length < this.#credits) return true;
		const oldest = surface.unacked[0]!;
		if (this.#scheduler.now() - oldest < STALLED_ACK_MS) return false;
		logger.warn("TSP: terminal stopped acknowledging frames; resuming without credits", {
			sf: surface.id,
			s: surface.seq,
			acked: surface.acked,
		});
		surface.unacked = [];
		surface.acked = surface.seq;
		return true;
	}

	/** Render again once `surface`'s oldest unacked frame counts as stalled, in case no ack ever arrives. */
	#armStallTimer(surface: Surface): void {
		if (this.#stallTimer) return;
		const delay = surface.unacked[0]! + STALLED_ACK_MS - this.#scheduler.now();
		this.#stallTimer = this.#scheduler.scheduleRender(
			() => {
				this.#stallTimer = undefined;
				this.#host.requestRender();
			},
			Math.max(0, delay),
		);
	}

	#clearStallTimer(): void {
		this.#stallTimer?.cancel();
		this.#stallTimer = undefined;
	}

	#sendFrame(surface: Surface, ops: readonly TspOp[]): void {
		surface.seq++;
		surface.unacked.push(this.#scheduler.now());
		const frame: TspFrame = { sf: surface.id, s: surface.seq, ops };
		if (surface.doc) {
			const errors = surface.doc.applyFrame(frame);
			if (errors.length > 0) logger.warn("TSP: reference document rejected ops", { sf: surface.id, errors });
			this.#recent.push(frame);
			if (this.#recent.length > RECENT_FRAMES) this.#recent.splice(0, this.#recent.length - RECENT_FRAMES);
		}
		this.#write("f", frame);
	}

	/** Deliver the blobs `ops` reference that this connection hasn't handled yet (see the module doc). */
	#uploadBlobs(ops: readonly TspOp[]): void {
		const ids = new Set<string>();
		for (const op of ops) collectBlobs(op, ids);
		const fresh: NativeBlob[] = [];
		for (const id of ids) {
			if (this.#blobs.has(id)) continue;
			const blob = getNativeBlob(id);
			if (blob) fresh.push(blob);
			else logger.warn("TSP: image references an unregistered blob", { id });
		}
		if (fresh.length === 0) return;
		if (!this.#cx.feature("blobs")) {
			for (const blob of fresh) this.#sendBlob(blob);
			return;
		}
		const dir = Bun.env.TERN_BLOB_DIR;
		if (dir) {
			for (const blob of fresh) this.#blobs.set(blob.id, "asked");
			void this.#cacheBlobs(dir, fresh);
			return;
		}
		if (this.#askHeld) {
			this.#askHeld = false;
			this.#askBlobs(fresh.map(blob => blob.id));
			return;
		}
		for (const blob of fresh) this.#sendBlob(blob);
	}

	/** Write `blobs` to the terminal's cache, then ask about the ones still pending. */
	async #cacheBlobs(dir: string, blobs: readonly NativeBlob[]): Promise<void> {
		const epoch = this.#blobEpoch;
		await Promise.all(blobs.map(blob => cacheBlob(dir, blob)));
		if (epoch !== this.#blobEpoch) return;
		const ids = blobs.map(blob => blob.id).filter(id => this.#blobs.get(id) === "asked");
		if (ids.length > 0) this.#askBlobs(ids);
	}

	/** Ask the terminal which of `ids` it holds; the reply (or its absence) settles them. */
	#askBlobs(ids: readonly string[]): void {
		for (const id of ids) this.#blobs.set(id, "asked");
		const query: BlobQuery = { ids, timer: undefined };
		query.timer = this.#scheduler.scheduleRender(() => {
			query.timer = undefined;
			logger.warn("TSP: no reply to a blobs query; sending its blobs inline", { ids: ids.length });
			this.#sendMissing(ids);
		}, BLOB_REPLY_MS);
		// Expired queries stay only to pair late replies; a terminal that never answers mustn't grow the list.
		while (this.#blobQueries.length >= MAX_BLOB_QUERIES && !this.#blobQueries[0]!.timer) this.#blobQueries.shift();
		this.#blobQueries.push(query);
		this.#write("q", { q: "blobs", ids });
	}

	/**
	 * The reply to the oldest outstanding query. Any `have` id still asked
	 * about is held by the terminal (whichever query asked); the query's other
	 * ids go inline.
	 */
	#onBlobsReply(have: readonly string[]): void {
		const query = this.#blobQueries.shift();
		for (const id of have) {
			if (this.#blobs.get(id) !== "asked") continue;
			this.#blobs.set(id, "sent");
			// The bytes went another way; a recording still carries them so a replay without them shows the image.
			const blob = this.#recordPath ? getNativeBlob(id) : undefined;
			if (blob) {
				const body = Buffer.from(blob.bytes.buffer, blob.bytes.byteOffset, blob.bytes.byteLength).toString(
					"base64",
				);
				this.#record("out", "b", blobParams(blob), body);
			}
		}
		if (!query?.timer) return;
		query.timer.cancel();
		query.timer = undefined;
		this.#sendMissing(query.ids);
	}

	/** Send inline every id of `ids` still waiting on a query. */
	#sendMissing(ids: readonly string[]): void {
		for (const id of ids) {
			const blob = this.#blobs.get(id) === "asked" ? getNativeBlob(id) : undefined;
			if (blob) this.#sendBlob(blob);
		}
	}

	#sendBlob(blob: NativeBlob): void {
		this.#blobs.set(blob.id, "sent");
		const body = Buffer.from(blob.bytes.buffer, blob.bytes.byteOffset, blob.bytes.byteLength).toString("base64");
		// The full body, so a replay (Tern's `surface-play`) shows the image.
		this.#record("out", "b", blobParams(blob), body);
		this.#host.terminal.write(encodeTspMessage("b", body, blobParams(blob), this.#limit));
	}

	/**
	 * A new connection (resume, or a fresh inline surface after `gone`): the
	 * terminal is asked again. Outstanding queries stay, without their
	 * deadlines, only to pair their replies.
	 */
	#resetBlobs(): void {
		this.#blobEpoch++;
		this.#blobs.clear();
		this.#askHeld = true;
		for (const query of this.#blobQueries) {
			query.timer?.cancel();
			query.timer = undefined;
		}
	}

	#write(verb: "o" | "f" | "t" | "x" | "q", body: unknown): void {
		this.#record("out", verb, undefined, body);
		this.#host.terminal.write(encodeTspJson(verb, body, undefined, this.#limit));
	}

	#record(dir: "in" | "out", verb: string, params: Readonly<Record<string, string>> | undefined, body: unknown): void {
		const path = this.#recordPath;
		if (!path) return;
		let payload = body;
		if (dir === "in" && typeof body === "string") {
			try {
				payload = JSON.parse(body);
			} catch {
				payload = body;
			}
		}
		try {
			fs.appendFileSync(path, `${JSON.stringify({ t: this.#scheduler.now(), dir, verb, params, body: payload })}\n`);
		} catch (error) {
			logger.warn("TSP: recording failed; disabling", { path, error: String(error) });
			this.#recordPath = undefined;
		}
	}

	#surfaceFor(sf: string | undefined): Surface | null {
		if (sf === undefined || sf === this.#inline.id) return this.#inline;
		return this.#screen?.id === sf ? this.#screen : null;
	}

	#handleEvent(event: TspEvent): void {
		switch (event.ev) {
			case "ack": {
				const surface = this.#surfaceFor(event.sf);
				if (!surface || event.s <= surface.acked) return;
				const newly = Math.min(event.s, surface.seq) - surface.acked;
				surface.acked = Math.min(event.s, surface.seq);
				surface.unacked.splice(0, newly);
				this.#clearStallTimer();
				if (surface.dirty) this.#host.requestRender();
				return;
			}
			case "resize": {
				this.#sawResize = true;
				if (event.cols === this.#cx.cols) return;
				this.#cx.cols = event.cols;
				this.#host.requestRender();
				return;
			}
			case "theme":
				this.#cx.dark = event.dark;
				this.#host.appearanceChanged(event.dark);
				return;
			case "motion":
				this.#cx.reduceMotion = event.reduce;
				this.#host.motionChanged(event.reduce);
				return;
			case "visible":
				return;
			case "error":
				logger.warn("TSP: terminal reported an error", event);
				return;
			case "gone":
				if (event.ids.includes(this.#inline.id)) {
					// Adopt found nothing (evicted, or another pane): start over.
					this.#resetBlobs();
					this.#inline = this.#newSurface("inline");
					if (this.#live) this.#open(this.#inline);
					this.#host.requestRender();
					return;
				}
				this.#surfaceFor(event.sf)?.reconciler.forget(event.ids);
				return;
			case "toggle":
			case "select":
			case "activate":
			case "action":
			case "change":
			case "edit":
			case "undo":
			case "send":
				this.#routeUiEvent(event);
				return;
			case "focus": {
				const reconciler = this.#surfaceFor(event.sf)?.reconciler;
				const owners = reconciler?.owners(event.id) ?? [];
				if (!reconciler || owners.length === 0) return;
				const field =
					owners.findLast(owner => owner.handleInput && reconciler.focusTarget(owner) === event.id) ?? null;
				this.#host.focusFromPointer(owners, field, overlay => overlay.nativeSheet?.(this.#cx) === true);
				this.#host.requestRender();
				return;
			}
		}
	}

	#routeUiEvent(
		event: Extract<
			TspEvent,
			{ ev: "toggle" | "select" | "activate" | "action" | "change" | "edit" | "undo" | "send" }
		>,
	): void {
		const reconciler = this.#surfaceFor(event.sf)?.reconciler;
		const target = reconciler?.target(event.id);
		if (!reconciler || !target?.component.handleNativeEvent) return;
		// Explicit sends must address the live editor, not a stale or invented
		// descendant id that merely shares the component's namespace.
		if (event.ev === "send" && (!this.#live || reconciler.focusTarget(target.component) !== event.id)) return;
		// A list's items are nodes (`<list>/<key>`, or a component's root id) and
		// map back to their described key. Data-first kinds (picker, prefs) send
		// the program's own item ids (model ids, paths), which pass through.
		const item = (id: string): string =>
			id.startsWith(`${event.id}/`) || id.startsWith(`${event.id}.`) || !id.includes(".")
				? reconciler.itemKey(id)
				: id;
		let ui: NativeUiEvent;
		switch (event.ev) {
			case "toggle":
				ui = { type: "toggle", key: target.keypath, collapsed: event.collapsed };
				break;
			case "select":
				ui = { type: "select", key: target.keypath, item: item(event.item) };
				break;
			case "activate":
				ui = { type: "activate", key: target.keypath, item: item(event.item) };
				break;
			case "action":
				ui = { type: "action", key: target.keypath, act: event.act, value: event.value, mods: event.mods ?? [] };
				break;
			case "change":
				ui = { type: "change", key: target.keypath, item: event.item, value: event.value };
				break;
			case "edit": {
				const { from, to, text, cursor, len } = event;
				ui = { type: "edit", key: target.keypath, from, to, text, cursor, len };
				break;
			}
			case "undo":
				ui = { type: "undo", key: target.keypath };
				break;
			case "send":
				ui = { type: "send", key: target.keypath, text: event.text };
				break;
		}
		target.component.handleNativeEvent(ui);
		this.#host.requestRender();
	}

	/**
	 * The `overlay` node wrapping a TUI overlay, memoized while its placement
	 * is unchanged; a component describing its own sheet goes in unwrapped.
	 */
	#overlayNode(overlay: NativeOverlay): NativeChild {
		if (overlay.component.nativeSheet?.(this.#cx)) return overlay.component;
		const own = overlay.component.nativeOverlay;
		const anchor = own?.anchor ?? overlayAnchor(overlay.options);
		const size = own?.size ?? overlaySize(overlay.options, this.#cx.cols);
		const modal = overlay.focused || overlay.options?.fullscreen === true;
		const role = own?.role;
		const head = own?.head;
		const key = `${anchor}|${size}|${modal}|${role}|${JSON.stringify(head)}`;
		const cached = this.#overlayNodes.get(overlay.component);
		if (cached?.key === key) return cached.node;
		const wrapper = node(
			"overlay",
			{ anchor, size, modal, ...(role ? { role } : {}), ...(head ? { head } : {}) },
			[overlay.component],
			`ov-${nativeComponentId(overlay.component)}`,
		);
		this.#overlayNodes.set(overlay.component, { key, node: wrapper });
		return wrapper;
	}

	#pruneOverlayNodes(overlays: readonly NativeOverlay[]): void {
		if (this.#overlayNodes.size <= overlays.length) return;
		const live = new Set(overlays.map(overlay => overlay.component));
		for (const component of this.#overlayNodes.keys()) if (!live.has(component)) this.#overlayNodes.delete(component);
	}
}
