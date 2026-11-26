/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The interactive console: a program on a pseudo-terminal the user drives
 * (`bash` with `pty`). The head names the command and its state, the body is
 * the PTY screen replayed on a headless terminal, and the footer says keys go
 * to the program; escape force-kills it while it runs.
 *
 * {@link PtyConsoleModel} owns the screen: the runner feeds it the program's
 * output and reads `cursorAfterText()` for its input-wait heuristic; keys and
 * pastes leave through `onInput` as the bytes a terminal would send.
 */
import { type JSXNode, type KeyEvent, nativeRendering, type Signal, signal } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { ActionButton } from "./common";
import { consoleStateLabel, type PtyConsoleTerm } from "../../styles/panels/pty-console";
import { PtyReplay, styleReplayedRow } from "../../transcript/pty-replay";
import { rowsRole, type SheetAttributes } from "../sheet";

/** The run's state: running, then how it ended. */
export type PtyConsoleState = "running" | "complete" | "timed_out" | "killed";

/** Callbacks of {@link PtyConsoleModel}. */
export interface PtyConsoleHandlers {
	/** Bytes for the program (keys and pastes, encoded as a terminal sends them). */
	onInput(data: string): void;
	/** Escape while running (or the Force kill action). */
	onKill(): void;
	/** The screen changed size: resize the PTY. */
	onResize(cols: number, rows: number): void;
}

// The output sink owns the final output; this caps only the live display backlog.
const MAX_LIVE_WRITE_QUEUE_CHUNKS = 512;
/** Cells the frame takes around the screen. */
const FRAME_COLS = 2;
/** Cells Tern's sheet takes around the screen. */
const SHEET_COLS = 8;
/** Rows the head, footer and frame take around the screen. */
const FRAME_ROWS = 4;
const KILL_ACTION = "kill";

const CURSOR_KEYS: Readonly<Record<string, string>> = {
	up: "A",
	down: "B",
	right: "C",
	left: "D",
	home: "H",
	end: "F",
};
const NAMED_KEYS: Readonly<Record<string, string>> = {
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	insert: "\x1b[2~",
	delete: "\x1b[3~",
	"shift+tab": "\x1b[Z",
	enter: "\r",
	tab: "\t",
	space: " ",
	backspace: "\x7f",
	escape: "\x1b",
};
/** A kitty keyboard protocol report (`CSI … u`, or a modified functional key `CSI 1;… X`). */
const KITTY_SEQUENCE = /^\x1b\[[\d;:]*[u~A-Z]$/;

/**
 * The bytes a terminal sends a program for `key`: text as typed, cursor keys in
 * normal or application mode, control and meta letters; releases send nothing.
 */
export function ptyKeyBytes(key: KeyEvent, applicationCursorKeys: boolean): string {
	if (key.kind === "release") return "";
	const id = key.id;
	const cursor = CURSOR_KEYS[id];
	if (cursor) return applicationCursorKeys ? `\x1bO${cursor}` : `\x1b[${cursor}`;
	const named = NAMED_KEYS[id];
	if (named) return named;
	const ctrl = /^ctrl\+([a-z])$/.exec(id);
	if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
	const alt = /^alt\+(.)$/.exec(id);
	if (alt) return `\x1b${key.text ?? alt[1]!}`;
	if (key.text) return key.text;
	// Anything else a legacy terminal already encoded the way a program reads it.
	return KITTY_SEQUENCE.test(key.raw) ? "" : key.raw;
}

/** The console's screen and state (see the module docs). */
export class PtyConsoleModel {
	readonly command: string;
	readonly state = signal<PtyConsoleState>("running");
	readonly exitCode = signal<number | undefined>(undefined);
	/** The visible screen rows (SGR kept). */
	readonly screen = signal<readonly string[]>([]);
	/** The PTY grid's width in cells. */
	readonly cols: Signal<number>;
	readonly #replay: PtyReplay;
	readonly #handlers: PtyConsoleHandlers;
	#cols = 0;
	#rows = 0;
	#queue: string[] = [];
	#writing = false;
	#flushed: Array<() => void> = [];

	constructor(command: string, size: { cols: number; rows: number }, handlers: PtyConsoleHandlers) {
		this.command = command;
		this.#handlers = handlers;
		this.#cols = size.cols;
		this.#rows = size.rows;
		this.cols = signal(size.cols);
		this.#replay = new PtyReplay({ cols: size.cols, rows: size.rows });
	}

	/** The PTY grid for a terminal of `columns`×`rows` cells. */
	static gridFor(columns: number, rows: number): { cols: number; rows: number } {
		return {
			cols: Math.max(20, columns - (nativeRendering() ? SHEET_COLS : FRAME_COLS)),
			rows: Math.max(1, Math.max(5, Math.floor(rows * 0.8)) - FRAME_ROWS),
		};
	}

	/** Follow a terminal of `columns`×`rows` cells: resize the screen and the PTY. */
	fit(columns: number, rows: number): void {
		const grid = PtyConsoleModel.gridFor(columns, rows);
		if (grid.cols === this.#cols && grid.rows === this.#rows) return;
		this.#cols = grid.cols;
		this.#rows = grid.rows;
		this.cols.set(grid.cols);
		this.#replay.resize(grid.cols, grid.rows);
		this.screen.set(this.#replay.screen());
		try {
			this.#handlers.onResize(grid.cols, grid.rows);
		} catch {
			// The session may have ended.
		}
	}

	/** Queue a raw output chunk for the screen. */
	append(chunk: string): void {
		this.#queue.push(chunk);
		const overflow = this.#queue.length - MAX_LIVE_WRITE_QUEUE_CHUNKS;
		if (overflow > 0) {
			this.#queue.splice(0, overflow);
			// Dropped chunks can split an in-flight DCS/OSC/APC string (a sixel
			// payload) across the gap; a stray string terminator is a no-op in the
			// ground state but resynchronizes the parser if the terminator was dropped.
			this.#queue[0] = `\x1b\\${this.#queue[0]}`;
		}
		void this.#drain();
	}

	async #drain(): Promise<void> {
		if (this.#writing) return;
		this.#writing = true;
		while (this.#queue.length > 0) {
			await this.#replay.write(this.#queue.shift()!);
			this.screen.set(this.#replay.screen());
		}
		this.#writing = false;
		const waiters = this.#flushed;
		this.#flushed = [];
		for (const resolve of waiters) resolve();
	}

	/** Resolves once the screen has applied every queued chunk. */
	flush(): Promise<void> {
		if (!this.#writing && this.#queue.length === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#flushed.push(resolve);
		return promise;
	}

	/** Whether the cursor sits after text on its row, where a line prompt leaves it. */
	cursorAfterText(): boolean {
		return this.#replay.cursorAfterText();
	}

	/** The program ended; keys stop reaching it. */
	complete(result: { exitCode: number | undefined; cancelled: boolean; timedOut: boolean }): void {
		this.exitCode.set(result.exitCode);
		this.state.set(result.timedOut ? "timed_out" : result.cancelled ? "killed" : "complete");
	}

	key(key: KeyEvent): boolean {
		if (this.state() !== "running") return false;
		if (key.id === "escape" && key.kind !== "release") {
			this.#handlers.onKill();
			return true;
		}
		const bytes = ptyKeyBytes(key, this.#replay.applicationCursorKeys());
		if (bytes) this.#handlers.onInput(bytes);
		return true;
	}

	paste(text: string): boolean {
		if (this.state() !== "running") return false;
		this.#handlers.onInput(text);
		return true;
	}

	kill(): void {
		if (this.state() === "running") this.#handlers.onKill();
	}

	dispose(): void {
		this.#replay.dispose();
	}
}

function stateSpan(state: PtyConsoleState, exitCode: number | undefined): TspSpan {
	const label = consoleStateLabel(state, exitCode);
	return { s: label.tone, t: label.text };
}

/** Tern's sheet: a full-pane one titled Console, anchored where `ctx.ui.custom` overlays dock. */
export const CONSOLE_SHEET: SheetAttributes = {
	role: "omp.overlay.console",
	anchor: "bottom",
	size: "full",
	head: "Console",
};

/** The console view (its host keeps the model {@link PtyConsoleModel.fit fitted} to the terminal). */
export function PtyConsole(props: { readonly model: PtyConsoleModel }): JSXNode {
	const { model } = props;
	// Tern's sheet names the console in its head and fixes the screen to the PTY grid.
	const native = nativeRendering();
	return (
		<col
			role={rowsRole("omp.overlay.console")}
			gap="sm"
			term={(): PtyConsoleTerm => ({
				command: model.command,
				state: model.state(),
				exitCode: model.exitCode(),
				screen: model.screen(),
			})}
			onKey={key => model.key(key)}
			onPaste={paste => model.paste(paste.text)}
			onAction={act => {
				if (act === KILL_ACTION) model.kill();
			}}
		>
			<row key="head" gap="sm" align="baseline" justify="between">
				{native ? (
					<text wrap="none" truncate="end" spans={[{ s: "muted", t: replaceTabs(model.command) }]} />
				) : (
					<text
						lines={1}
						truncate="end"
						spans={[
							{ s: "accent", t: "Console " },
							{ s: "muted", t: model.command.replace(/\t/g, " ") },
						]}
					/>
				)}
				<text
					spans={() => [{ s: "dim", t: "[" }, stateSpan(model.state(), model.exitCode()), { s: "dim", t: "]" }]}
				/>
			</row>
			{native ? (
				<ansi
					key="screen"
					text={() =>
						model
							.screen()
							.map(row => styleReplayedRow(row, ""))
							.join("\n")
					}
					cols={model.cols}
				/>
			) : (
				<ansi key="screen" text={() => model.screen().join("\n")} />
			)}
			{() =>
				model.state() === "running" ? (
					<row key="footer" role="omp.actions" align="center" gap="sm">
						<text spans={[{ s: "dim", t: "Input forwarded to PTY" }]} />
						<spacer grow={1} />
						<ActionButton
							nodeKey="kill"
							id={KILL_ACTION}
							label="Force kill"
							title="Force kill  esc"
							tone="error"
							keys={["escape"]}
						/>
					</row>
				) : native ? (
					<row key="footer" role="omp.actions" align="center" gap="sm">
						<text spans={[{ s: "dim", t: "Session finished" }]} />
					</row>
				) : (
					<text key="footer" spans={[{ s: "dim", t: "Session finished" }]} />
				)
			}
		</col>
	);
}
