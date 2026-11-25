/**
 * The native backend: renders a {@link Surface} on a Tern terminal over the
 * Surface Protocol.
 *
 * Lifecycle: {@link NativeBackend.start} opens the surface (`o`) on a
 * negotiated {@link TspConnection}, adopting it when this backend opened it
 * before and the terminal lists `adopt` (a `gone` for the surface reopens it
 * fresh and describes everything again); {@link NativeBackend.stop} sends
 * any pending change and closes it (`x`).
 *
 * Frames: large reconciliations go out as ordered, byte-bounded batches.
 * Each batch spends a credit and gets its own sequence number. Changes made
 * while blocked coalesce behind the unsent ops. If the oldest frame stays
 * unanswered for {@link STALLED_ACK_MS}, the credits reset (one warning per stall).
 * Tern acknowledges a frame once it draws it and draws no hidden pane (a
 * background tab), so silence while the pane is hidden resets them without one.
 * A frame that echoes user input (a key, a paste, an `edit`, `undo` or `send`)
 * may overdraw them by {@link INPUT_OVERDRAFT}, and frames unanswered for
 * {@link INPUT_STALLED_ACK_MS} stop counting against it, so typing stays live
 * while the terminal is slow to acknowledge.
 *
 * Events: the terminal's UI events become {@link UiEvent}s delivered to the
 * node they name and bubbled to the nearest handler; keys and pastes the
 * driver decodes go up the focus path (`onKey`/`onPaste`), then to the
 * focused node's widget (Tern forwards keys raw: an `editor` edits as in a
 * terminal and reports `edit` events), then to `options.onKey`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { TspEvent, TspFrame, TspOp, TspOpen } from "@oh-my-pi/pi-wire";
import { bubbleEvent, bubbleKey, bubblePaste, keypathOf, pathTo } from "../dispatch";
import type { InputEvent } from "../driver/contract";
import type { KeyEvent, UiEvent } from "../events";
import type { UiNode } from "../node";
import { batch } from "../reactive";
import type { Surface } from "../surface";
import { type WidgetContext, widgetContext, widgetFor } from "../term/widgets";
// The widgets register with their painters.
import "../term/painters";
import type { NativeClock, TspConnection } from "./connection";
import { Reconciler } from "./reconcile";

/** How long the oldest unacknowledged frame may wait before the credits reset. */
export const STALLED_ACK_MS = 5000;
/** Frames past the credits a frame echoing user input may leave unacknowledged. */
export const INPUT_OVERDRAFT = 2;
/** How long an unacknowledged frame counts against a frame echoing user input. */
export const INPUT_STALLED_ACK_MS = 250;

// APC chunking is separate: Tern still applies and draws each reassembled frame as one unit.
const MAX_FRAME_BYTES = 24 * 1024 * 1024;

interface PendingOps {
	readonly ops: TspOp[];
	start: number;
	overflow: { readonly json: string; readonly bytes: number } | undefined;
}

/** Options of a {@link NativeBackend}. */
export interface NativeBackendOptions {
	readonly surface: Surface;
	/** Surface id. Default `s:<n>`, unique in the process. */
	readonly id?: string;
	readonly mode?: TspOpen["mode"];
	readonly title?: string;
	readonly role?: string;
	/** Keys nothing on the focus path consumed (global shortcuts). Return true when handled. */
	readonly onKey?: (key: KeyEvent) => boolean;
	/** Sees every decoded input event before routing; true consumes it. */
	readonly intercept?: (event: InputEvent) => boolean;
	/** Delay before a requested frame, ms. Default 0. */
	readonly frameInterval?: number;
	/** Timers; defaults to the connection's clock. */
	readonly clock?: NativeClock;
	/** Sees every frame after it is sent (the `OMP_TUI_DEBUG` server's `tsp` log). */
	readonly onFrame?: (frame: TspFrame) => void;
	/**
	 * Whether this surface is the one the user sees and types into (default: always). While false it
	 * sends no frame and takes no input: a page's screen surface covers it. Call
	 * {@link NativeBackend.requestFrame} when it turns true.
	 */
	readonly active?: () => boolean;
	/**
	 * The undescribed node a path's first node stands under (a page overlay, the wrapper of a sheet
	 * drawn bare), or the one that takes the keys when nothing is focused (`top` undefined). Its
	 * handlers see the keys and events of everything under it, as if it were described.
	 */
	readonly parentOf?: (top: UiNode | undefined) => UiNode | undefined;
}

let nextSurface = 1;

/** Map a terminal UI event to the {@link UiEvent} it means, with `key` the node's keypath. */
function toUiEvent(
	event: Extract<TspEvent, { id: string; sf: string }>,
	key: string,
	item: (item: string) => string,
): UiEvent {
	switch (event.ev) {
		case "toggle": {
			const name = "open" in event ? event.item : event.key;
			return {
				type: "toggle",
				key,
				collapsed: "open" in event ? !event.open : event.collapsed,
				...(name === undefined ? {} : { item: name }),
			};
		}
		case "select":
			return { type: "select", key, item: item(event.item) };
		case "activate":
			return { type: "activate", key, item: item(event.item) };
		case "action":
			return {
				type: "action",
				key,
				act: event.act,
				mods: event.mods ?? [],
				...(event.value === undefined ? {} : { value: event.value }),
				...(event.checked === undefined ? {} : { checked: event.checked }),
			};
		case "change":
			if ("text" in event) return { type: "docChange", key, text: event.text };
			return "item" in event
				? { type: "change", key, item: event.item, value: event.value }
				: { type: "change", key, value: event.value };
		case "comment":
			return "comment" in event
				? { type: "commentNote", key, comment: event.comment, note: event.note }
				: { type: "comment", key, quote: event.quote, at: event.at, note: event.note };
		case "uncomment":
			return { type: "uncomment", key, comment: event.comment };
		case "editing":
			return { type: "editing", key, on: event.on };
		case "edit":
			return {
				type: "edit",
				key,
				from: event.from,
				to: event.to,
				text: event.text,
				cursor: event.cursor,
				len: event.len,
			};
		case "undo":
			return { type: "undo", key };
		case "send":
			return { type: "send", key, text: event.text };
		case "focus":
			return { type: "focus", key };
		default:
			return event satisfies never;
	}
}

/** See the module docs. */
export class NativeBackend {
	readonly id: string;
	readonly #options: NativeBackendOptions;
	readonly #surface: Surface;
	readonly #framePrefix: string;
	#connection: TspConnection | undefined;
	#clock: NativeClock | undefined;
	#reconciler: Reconciler | undefined;
	#running = false;
	#opened = false;
	#seq = 0;
	#pending: PendingOps | undefined;
	#unacked: { readonly s: number; readonly sentAt: number }[] = [];
	#cancelFrame: (() => void) | undefined;
	#cancelStall: (() => void) | undefined;
	#stalledSince: number | undefined;
	#stallResets = 0;
	/** Unsent changes echo user input (the next frame may overdraw the credits). */
	#inputPending = false;
	/** Input is being routed: whatever it changes is an echo. */
	#echoing = false;
	#unsubscribe: (() => void)[] = [];

	constructor(options: NativeBackendOptions) {
		this.#options = options;
		this.#surface = options.surface;
		this.id = options.id ?? `s:${nextSurface++}`;
		this.#framePrefix = `{"sf":${JSON.stringify(this.id)},"s":`;
	}

	/** Whether the surface is open and rendering. */
	get running(): boolean {
		return this.#running;
	}

	/** Frames sent and not yet acknowledged. */
	get unacknowledged(): number {
		return this.#unacked.length;
	}

	/** The wire id `node` is described under, if it is. */
	idOf(node: UiNode): string | undefined {
		return this.#reconciler?.idOf(node);
	}

	/** Describe again the settled block holding `node` (see {@link Host.redescribe}). */
	redescribe(node: UiNode): void {
		this.#reconciler?.redescribe(node);
	}

	/** Open (or adopt) the surface on `connection` and send the first frame. */
	start(connection: TspConnection): void {
		if (this.#running) return;
		const adopt = this.#opened && this.#connection !== undefined && connection.hasFeature("adopt");
		if (!adopt) this.#reconciler?.reset();
		this.#connection = connection;
		this.#clock = this.#options.clock ?? connection.clock;
		this.#reconciler ??= new Reconciler(
			this.#surface,
			this.id,
			{ cols: connection.cols, rows: () => connection.driver.rows, hasFeature: name => connection.hasFeature(name) },
			() => {
				if (this.#echoing) this.#inputPending = true;
				this.requestFrame();
			},
		);
		this.#running = true;
		this.#unacked = [];
		this.#unsubscribe.push(
			connection.onEvent(event => this.#onEvent(event)),
			connection.driver.onInput(event => {
				if (this.#options.active?.() === false) return;
				if (!this.#options.intercept?.(event)) this.#onInput(event);
			}),
		);
		this.#open(adopt);
		this.flush();
	}

	/**
	 * Close the surface. `keep` flushes pending changes regardless of credits
	 * and leaves `main` in scrollback (and the surface adoptable).
	 */
	stop(keep = true): void {
		if (!this.#running) return;
		try {
			// A discarded surface needs no final frame (or ack); on a fatal
			// handoff its failing renderer must not be evaluated again.
			if (keep) this.#send(true);
		} finally {
			try {
				this.#connection!.sendJson("x", { id: this.id, keep });
			} finally {
				this.#halt();
			}
		}
		if (keep) this.#reconciler?.dropLiveRegions();
		else {
			this.#opened = false;
			this.#reconciler?.reset();
		}
	}

	/** Stop without closing (the connection is gone) and release every watcher. */
	dispose(): void {
		this.#halt();
		this.#reconciler?.dispose();
		this.#reconciler = undefined;
	}

	/** Schedule a frame. */
	requestFrame(): void {
		if (!this.#running || this.#cancelFrame) return;
		this.#cancelFrame = this.#clock!.setTimeout(() => {
			this.#cancelFrame = undefined;
			this.flush();
		}, this.#options.frameInterval ?? 0);
	}

	/** Send a frame now if something changed and a credit is free; returns whether one went out. */
	flush(): boolean {
		this.#cancelFrame?.();
		this.#cancelFrame = undefined;
		if (!this.#running) return false;
		return this.#send(false);
	}

	#halt(): void {
		this.#running = false;
		this.#pending = undefined;
		this.#cancelFrame?.();
		this.#cancelFrame = undefined;
		this.#cancelStall?.();
		this.#cancelStall = undefined;
		for (const off of this.#unsubscribe.splice(0)) off();
	}

	#open(adopt: boolean): void {
		const open: TspOpen = {
			id: this.id,
			mode: this.#options.mode ?? "inline",
			...(this.#options.title === undefined ? {} : { title: this.#options.title }),
			...(this.#options.role === undefined ? {} : { role: this.#options.role }),
			...(adopt ? { adopt: true } : {}),
		};
		this.#connection!.sendJson("o", open);
		this.#opened = true;
	}

	#send(force: boolean): boolean {
		const reconciler = this.#reconciler!;
		const active = this.#options.active?.() !== false;
		if (!active && !force) return false;
		if (!this.#pending && (!active || !reconciler.dirty)) {
			// Input that changed nothing has no echo to send.
			this.#inputPending = false;
			return false;
		}
		if (!force && !this.#hasCredit()) return false;
		const connection = this.#connection!;
		let sent = false;
		let reconciled = false;
		do {
			if (!this.#pending) {
				reconciled = true;
				const { ops, blobs } = reconciler.reconcile();
				if (ops.length === 0) break;
				this.#pending = { ops, start: 0, overflow: undefined };
				connection.ensureBlobs(blobs);
			}
			this.#writeFrame(connection, this.#pending);
			sent = true;
		} while ((this.#pending || (force && active && !reconciled && reconciler.dirty)) && (force || this.#hasCredit()));
		if (!this.#pending) {
			// A split can finish with input routed during it still unsent: its echo goes next.
			if (!reconciler.dirty) this.#inputPending = false;
			else if (this.#inputPending) this.requestFrame();
		}
		return sent;
	}

	#writeFrame(connection: TspConnection, pending: PendingOps): void {
		const { ops, start } = pending;
		const s = ++this.#seq;
		let body = `${this.#framePrefix}${s},"ops":[`;
		let bytes = Buffer.byteLength(body) + 2; // Closing `]}`.
		let end = start;
		for (; end < ops.length; end++) {
			const json = pending.overflow?.json ?? JSON.stringify(ops[end]!);
			const size = pending.overflow?.bytes ?? Buffer.byteLength(json);
			const separator = end === start ? "" : ",";
			// A wire op is indivisible; send an oversized op by itself.
			if (separator && bytes + 1 + size > MAX_FRAME_BYTES) {
				pending.overflow = { json, bytes: size };
				break;
			}
			pending.overflow = undefined;
			body += separator + json;
			bytes += separator.length + size;
		}
		pending.start = end;
		if (end === ops.length) this.#pending = undefined;
		// Account for the frame before writing: an ack can arrive on the write stack.
		this.#unacked.push({ s, sentAt: this.#clock!.now() });
		// Slice before sending: an eviction handled on the write stack compacts `ops`.
		const onFrame = this.#options.onFrame;
		const sent = onFrame ? ops.slice(start, end) : undefined;
		connection.send("f", `${body}]}`);
		if (sent) onFrame?.({ sf: this.id, s, ops: sent });
	}

	#forget(ids: readonly string[]): void {
		const pending = this.#pending;
		const reconciler = this.#reconciler!;
		if (!pending) {
			reconciler.forget(ids);
			return;
		}
		const gone = new Map<string, string | null>();
		reconciler.forget(ids, gone);
		// An evicted id the reconciler still holds (a changed settled block queued
		// as del + add) keeps its ops so the add recreates it; drop the rest.
		for (const id of ids) if (!gone.has(id) && !reconciler.resolve({ id })) gone.set(id, null);
		if (gone.size === 0) return;
		// The terminal can evict between batches. Skip ops for lost nodes and
		// keep surviving insertions in order if their `before` sibling was lost.
		const { ops, start } = pending;
		let end = start;
		for (let i = start; i < ops.length; i++) {
			let op = ops[i]!;
			if (op[1] != null && gone.has(op[1])) continue;
			if (op[0] === "add" || op[0] === "move") {
				if (gone.has(op[2])) continue;
				const before = op[3];
				if (before !== null && gone.has(before)) {
					const next = gone.get(before) ?? null;
					op = op[0] === "add" ? ["add", op[1], op[2], next, op[4]] : ["move", op[1], op[2], next];
				}
			}
			ops[end++] = op;
		}
		ops.length = end;
		if (end === start) this.#pending = undefined;
		else pending.overflow = undefined;
	}

	#hasCredit(): boolean {
		// Let retention events from one batch reach us before continuing a split reconciliation.
		const credits = this.#pending ? 1 : this.#connection!.credits;
		if (this.#unacked.length < credits) return true;
		const oldest = this.#unacked[0]!;
		const now = this.#clock!.now();
		const waited = now - oldest.sentAt;
		if (waited >= STALLED_ACK_MS) {
			if (this.#stalledSince === undefined && this.#connection!.visible.peek()) {
				this.#stalledSince = oldest.sentAt;
				logger.warn("TSP: terminal stopped acknowledging frames; resetting credits", {
					sf: this.id,
					unacked: this.#unacked.length,
				});
			}
			if (this.#stalledSince !== undefined) this.#stallResets++;
			this.#unacked = [];
			return true;
		}
		let wait = STALLED_ACK_MS - waited;
		// A split reconciliation still waits for its retention events, input or not.
		if (this.#inputPending && !this.#pending) {
			// An echo counts only the frames younger than INPUT_STALLED_ACK_MS against
			// `credits + INPUT_OVERDRAFT`. `#unacked` is in send order: the frame that
			// many from the newest decides.
			const deciding = this.#unacked.at(-(credits + INPUT_OVERDRAFT));
			if (!deciding || now - deciding.sentAt >= INPUT_STALLED_ACK_MS) return true;
			// Retry the held echo once that frame stops counting, not when the credits reset.
			wait = Math.min(wait, deciding.sentAt + INPUT_STALLED_ACK_MS - now);
			this.#cancelStall?.();
			this.#cancelStall = undefined;
		}
		if (!this.#cancelStall) {
			this.#cancelStall = this.#clock!.setTimeout(() => {
				this.#cancelStall = undefined;
				this.flush();
			}, wait);
		}
		return false;
	}

	#onEvent(event: TspEvent): void {
		switch (event.ev) {
			case "ack": {
				if (event.sf !== this.id) return;
				this.#unacked = this.#unacked.filter(frame => frame.s > event.s);
				if (this.#stalledSince !== undefined) {
					logger.debug("TSP: terminal acknowledges frames again", {
						sf: this.id,
						stalledMs: this.#clock!.now() - this.#stalledSince,
						resets: this.#stallResets,
					});
					this.#stalledSince = undefined;
					this.#stallResets = 0;
				}
				this.#cancelStall?.();
				this.#cancelStall = undefined;
				this.flush();
				return;
			}
			case "gone":
				if (event.sf !== undefined && event.sf !== this.id) return;
				if (!event.ids.includes(this.id)) {
					if (event.sf === this.id) this.#forget(event.ids);
					return;
				}
				// The terminal no longer has the surface: open it fresh and describe everything again.
				this.#reconciler!.reset();
				this.#pending = undefined;
				this.#unacked = [];
				this.#open(false);
				this.flush();
				return;
			case "resize":
			case "theme":
			case "motion":
			case "features":
			case "visible":
			case "checkout":
			case "error":
				return;
		}
		if (event.sf !== this.id) return;
		const resolved = this.#reconciler!.resolve(event);
		if (!resolved) {
			logger.debug("TSP: event for an unknown node", { ev: event.ev, id: event.id });
			return;
		}
		const path = this.#rooted(resolved);
		if (event.ev === "send") {
			// A delayed send must still address a live, willing field, not merely
			// a node whose ancestor happens to have an onSend handler.
			const field = path.at(-1)!;
			if (field.kind !== "editor" && field.kind !== "input") return;
			const props = field.props();
			if (
				!("sendable" in props) ||
				props.sendable !== true ||
				props.readonly ||
				props.hidden ||
				("disabled" in props && props.disabled === true) ||
				event.text.trim() === ""
			)
				return;
		}
		const reconciler = this.#reconciler!;
		const ui = toUiEvent(event, keypathOf(path), item => reconciler.itemKey(event.id, item));
		// The field is controlled: it shows the change once a frame echoes it.
		this.#route(event.ev === "edit" || event.ev === "undo" || event.ev === "send", () => {
			// A native caret move/replacement ends a raw-key selection, even if
			// the text and cursor happen to be unchanged (e.g. clicking its end).
			const field = path.at(-1)!;
			const selection = field.fieldSelection;
			if (selection && selection.anchor !== null && (ui.type === "edit" || ui.type === "undo")) {
				const props = field.props();
				const text = "text" in props && typeof props.text === "string" ? props.text : "";
				if (ui.type === "undo" || ui.len === text.length) selection.anchor = null;
			}
			const handled = bubbleEvent(path, ui);
			if (!handled && ui.type === "focus") {
				// A pointer focus request can arrive after a modal took the keys.
				// Sheets without a modal barrier (e.g. docked prefs) still yield focus.
				const modal = this.#focusPath().findLast(node => {
					if (node.kind !== "overlay") return false;
					const props = node.props();
					return "modal" in props && props.modal === true && !props.hidden;
				});
				if (!modal || path.includes(modal)) this.#surface.focus(path.at(-1)!);
			}
			if (!handled && ui.type === "action")
				logger.debug("TSP: unhandled node action", { sf: event.sf, id: event.id, act: ui.act });
		});
	}

	/** `path` under the undescribed node its first node stands under, when there is one. */
	#rooted(path: readonly UiNode[]): readonly UiNode[] {
		const parent = this.#options.parentOf?.(path[0]);
		return parent && path[0] !== parent ? [parent, ...path] : path;
	}

	#focusPath(): readonly UiNode[] {
		const focused = this.#surface.focused();
		if (!focused) return this.#rooted([]);
		const id = this.#reconciler?.idOf(focused);
		const described = id === undefined ? null : this.#reconciler!.resolve({ id });
		if (described) return this.#rooted(described);
		const surface = this.#surface;
		for (const roots of [surface.layer(), surface.dock(), surface.main()]) {
			const path = pathTo(roots, focused);
			if (path.length > 0) return this.#rooted(path);
		}
		return this.#rooted([focused]);
	}

	/** Route `event` as if the terminal sent it (no interception). */
	dispatch(event: InputEvent): void {
		this.#onInput(event);
	}

	#onInput(event: InputEvent): void {
		if (event.type === "key") {
			this.#route(true, () => {
				const path = this.#focusPath();
				if (bubbleKey(path, event.key)) return;
				// Tern forwards keys raw (it leaves editing to the program): the focused node's widget
				// edits, moves or selects as in a terminal, its events bubbling like Tern's own.
				const focused = path.at(-1);
				if (focused && widgetFor(focused)?.key?.(focused, event.key, this.#widgetContext(path))) return;
				this.#options.onKey?.(event.key);
			});
		} else if (event.type === "paste") {
			this.#route(true, () => {
				const path = this.#focusPath();
				if (bubblePaste(path, event.paste)) return;
				const focused = path.at(-1);
				if (focused) widgetFor(focused)?.paste?.(focused, event.paste, this.#widgetContext(path));
			});
		}
	}

	/** Run `route` in one batch; with `echo`, whatever it changes is an echo that may overdraw the credits. */
	#route(echo: boolean, route: () => void): void {
		const outer = this.#echoing;
		this.#echoing ||= echo;
		try {
			batch(route);
		} finally {
			this.#echoing = outer;
		}
	}

	#widgetContext(path: readonly UiNode[]): WidgetContext {
		return widgetContext(path, {
			focus: next => this.#surface.focus(next),
			pageRows: Math.max(1, (this.#connection?.driver.rows ?? 24) - 2),
		});
	}
}
