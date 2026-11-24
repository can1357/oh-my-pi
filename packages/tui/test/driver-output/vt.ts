/**
 * A real terminal (kitty's VT core, compiled to wasm) behind a FrameWriter,
 * plus helpers to inspect the screen, scrollback and every intermediate
 * screen a frame's bytes pass through.
 */
import type { FramePlan } from "@oh-my-pi/pi-tui/driver/contract";
import { FrameWriter, type FrameWriterOptions, type Invalidation } from "@oh-my-pi/pi-tui/driver/output/writer";
import { KittyTerminal } from "kitty-vt-wasm";

export interface VtOptions extends Partial<Omit<FrameWriterOptions, "sink" | "columns" | "rows">> {
	readonly columns?: number;
	readonly rows?: number;
	readonly sync?: boolean;
	/** Lines a shell printed before the program started (the cursor ends below them). */
	readonly shell?: readonly string[];
	/** Start without a cursor position report. */
	readonly blind?: boolean;
}

/** Split a byte stream into escape sequences and single characters. */
const TOKEN =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|\x1bP[^\x1b]*\x1b\\|\x1b[^[\]_P]|[\r\n]|[^\x1b\r\n]+/gu;

/** Cursor movements: CR, LF, CUU/CUD/CUF/CUB, CHA, CUP. */
const MOVEMENT = /^(?:\r|\n|\x1b\[\d*(?:;\d*)?[ABCDGH])$/;

export class Vt {
	readonly term: KittyTerminal;
	readonly writer: FrameWriter;
	/** Every write, in order. */
	readonly writes: string[] = [];
	readonly invalidations: Invalidation[] = [];
	readonly columns: number;
	readonly rows: number;
	#prelude = "";
	#shadow: KittyTerminal | undefined;
	#shadowAt = 0;
	#resized = 0;
	/** Pending scheduled callbacks (the resize settle window): run by {@link settle}. */
	readonly #timers = new Set<() => void>();
	/** Resizes applied, in order, with the write count at the time. */
	readonly #resizes: { at: number; columns: number; rows: number }[] = [];

	constructor(options: VtOptions = {}) {
		this.columns = options.columns ?? 20;
		this.rows = options.rows ?? 8;
		this.term = KittyTerminal.createSync({ columns: this.columns, rows: this.rows, scrollback: 1000 });
		if (options.shell?.length) this.#prelude = `${options.shell.join("\r\n")}\r\n`;
		this.term.write(this.#prelude);
		const sync = options.sync ?? true;
		this.writer = new FrameWriter({
			synchronizedOutput: () => sync,
			multiplexer: () => false,
			schedule: callback => {
				this.#timers.add(callback);
				return () => this.#timers.delete(callback);
			},
			queryCursor: async () => ({ row: this.term.cursor.y, col: this.term.cursor.x }),
			onInvalidate: request => this.invalidations.push(request),
			...options,
			sink: {
				write: data => {
					this.writes.push(data);
					this.term.write(data);
				},
				flush: async () => {},
			},
			columns: this.columns,
			rows: this.rows,
		});
		this.writer.start(options.blind ? null : { row: this.term.cursor.y, col: this.term.cursor.x });
	}

	present(frame: FramePlan): number | undefined {
		return this.writer.present(frame);
	}

	/** Visible rows, trailing blanks trimmed. */
	screen(): string[] {
		return Array.from({ length: this.term.rows }, (_, y) => this.term.line(y).trimEnd());
	}

	/** Scrollback lines, oldest first. */
	scrollback(): string[] {
		return Array.from({ length: this.term.scrollbackLength }, (_, i) =>
			(this.term.scrollbackLine(i) ?? "").trimEnd(),
		);
	}

	/** Scrollback then screen, trailing blank rows dropped. */
	transcript(): string[] {
		const all = [...this.scrollback(), ...this.screen()];
		while (all.length > 0 && all.at(-1) === "") all.pop();
		return all;
	}

	/** Resize the emulated terminal (it reflows), then tell the writer. */
	resize(columns: number, rows: number): void {
		this.#resizes.push({ at: this.writes.length, columns, rows });
		this.term.resize(columns, rows);
		this.writer.resize(columns, rows);
	}

	/** A second terminal that saw every write before `#shadowAt` (and the resizes between them). */
	#catchUp(): KittyTerminal {
		if (!this.#shadow) {
			this.#shadow = KittyTerminal.createSync({ columns: this.columns, rows: this.rows, scrollback: 1000 });
			this.#shadow.write(this.#prelude);
		}
		const shadow = this.#shadow;
		for (; this.#shadowAt < this.writes.length; this.#shadowAt++) {
			this.#applyResizes(shadow, this.#shadowAt);
			shadow.write(this.writes[this.#shadowAt]!);
		}
		this.#applyResizes(shadow, this.#shadowAt);
		return shadow;
	}

	#applyResizes(shadow: KittyTerminal, at: number): void {
		for (; this.#resized < this.#resizes.length && this.#resizes[this.#resized]!.at <= at; this.#resized++) {
			shadow.resize(this.#resizes[this.#resized]!.columns, this.#resizes[this.#resized]!.rows);
		}
	}

	/** End the resize settle window now, and wait for the anchor recovery it starts. */
	async settle(): Promise<void> {
		const due = [...this.#timers];
		this.#timers.clear();
		for (const callback of due) callback();
		await this.writer.whenAnchored();
	}

	/** Bytes written since `mark` (a `writes.length`). */
	since(mark: number): string {
		return this.writes.slice(mark).join("");
	}

	/**
	 * Present `frame` and return the screens a terminal without synchronized
	 * output could show while parsing its bytes: one before every cursor
	 * movement (a row's own text and erase count as one step), and the last.
	 */
	presentObserved(frame: FramePlan): { ack: number | undefined; screens: string[][] } {
		const shadow = this.#catchUp();
		const mark = this.writes.length;
		const ack = this.present(frame);
		const screens: string[][] = [];
		const snapshot = (): void => {
			screens.push(Array.from({ length: shadow.rows }, (_, y) => shadow.line(y).trimEnd()));
		};
		for (const [token] of this.since(mark).matchAll(TOKEN)) {
			if (MOVEMENT.test(token)) snapshot();
			shadow.write(token);
		}
		snapshot();
		this.#shadowAt = this.writes.length;
		return { ack, screens };
	}
}

/** Non-blank rows shown more than once. */
export function duplicated(screen: readonly string[]): string[] {
	const seen = new Set<string>();
	return screen.filter(row => row !== "" && (seen.has(row) || !seen.add(row)));
}

export const lines = (prefix: string, from: number, to: number): string[] =>
	Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
