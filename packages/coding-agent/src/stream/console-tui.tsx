/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `omp stream`'s console: the link status and channel, the viewer URL,
 * audience and attached panes, the event log (chat, link and pane events;
 * the newest at the bottom), the chat input and the key hints.
 *
 * Enter sends chat (`/title <text>` retitles the stream, `/quit` stops it),
 * ↑/↓ recall sent lines, Ctrl+C stops the stream.
 */
import { stripVTControlCharacters } from "node:util";
import { type Accessor, batch, type JSXNode, type KeyEvent, type Signal, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { StreamChatMessage, TspSpan } from "@oh-my-pi/pi-wire";
import { runStandalone } from "../ui/apps/fullscreen";
import { formatKeyHint, formatKeyHints } from "../ui/keys/hints";
import { applyEdit, type LineValue } from "../ui/overlays/panels/common";
import { replaceTabs } from "../utils/text-width";
import type { StreamConsoleEvent, StreamMuxHost } from "./streamer";

const HISTORY_LIMIT = 50;
/** Rows the console takes besides the log: header, details, input, hints. */
const CHROME_ROWS = 4;
/** Span tokens chat names take, by a stable hash of the name. */
const CHAT_TOKENS: readonly string[] = ["info", "success", "warning", "link", "accent"];

interface PaneSummary {
	id: number;
	title: string;
	cols: number;
	rows: number;
}

export interface StreamTuiInfo {
	title: string;
	initialEvents: readonly StreamConsoleEvent[];
	subscribe(listener: (event: StreamConsoleEvent) => void): () => void;
}

function safeInline(text: string): string {
	return replaceTabs(stripVTControlCharacters(text)).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function formatLinkEvent(event: Extract<StreamConsoleEvent, { t: "link" }>): string {
	const detail = event.detail ? ` · ${safeInline(event.detail)}` : "";
	const user = event.user ? ` · @${safeInline(event.user)}` : "";
	return `link: ${event.state}${detail}${user}`;
}

function stableNameHash(name: string): number {
	let hash = 0;
	for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
	return hash;
}

/** A chat line: `HH:MM name: text`, the host's name accented, others colored by name. */
function chatSpans(message: StreamChatMessage): TspSpan[] {
	const time = new Date(message.ts);
	const timestamp = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
	const name = safeInline(message.name);
	const token = message.host ? "accent strong" : CHAT_TOKENS[stableNameHash(name) % CHAT_TOKENS.length]!;
	return [{ s: "dim", t: timestamp }, { t: " " }, { s: token, t: name }, { t: `: ${safeInline(message.text)}` }];
}

/** State of the console. */
class StreamConsole {
	readonly log = signal<readonly (readonly TspSpan[])[]>([]);
	readonly line = signal<LineValue>({ text: "", cursor: 0 });
	readonly linkState = signal<Extract<StreamConsoleEvent, { t: "link" }>["state"]>("connecting");
	readonly channel = signal("");
	readonly viewerUrl = signal("");
	readonly title: Signal<string>;
	readonly user = signal<string | undefined>(undefined);
	readonly viewers = signal(0);
	readonly panes = signal<ReadonlyMap<number, PaneSummary>>(new Map());
	readonly #host: StreamMuxHost;
	readonly #done = Promise.withResolvers<void>();
	readonly #unsubscribe: () => void;
	readonly #history: string[] = [];
	#historyIndex = 0;
	#historyDraft = "";
	#quitting = false;

	constructor(host: StreamMuxHost, info: StreamTuiInfo) {
		this.#host = host;
		this.title = signal(info.title);
		this.#unsubscribe = info.subscribe(event => this.#accept(event));
		for (const event of info.initialEvents) this.#accept(event);
	}

	/** Settles when the user quits or the stream ends. */
	run(): Promise<void> {
		return Promise.race([this.#done.promise, this.#host.wait().then(() => undefined)]);
	}

	dispose(): void {
		this.#unsubscribe();
	}

	key(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		switch (key.id) {
			case "ctrl+c":
				this.#quit();
				return true;
			case "up":
				this.#recall(-1);
				return true;
			case "down":
				this.#recall(1);
				return true;
			case "enter":
				this.#submit(this.line.peek().text);
				return true;
		}
		return false;
	}

	#setText(text: string): void {
		this.line.set({ text, cursor: text.length });
	}

	#append(spans: readonly TspSpan[]): void {
		this.log.update(log => [...log, spans]);
	}

	#submit(value: string): void {
		const text = value.trim();
		this.#setText("");
		if (!text) {
			this.#historyIndex = this.#history.length;
			this.#historyDraft = "";
			return;
		}
		this.#history.push(text);
		if (this.#history.length > HISTORY_LIMIT) this.#history.shift();
		this.#historyIndex = this.#history.length;
		this.#historyDraft = "";
		if (text === "/quit") this.#quit();
		else if (text.startsWith("/title ")) this.#host.setTitle(text.slice(7));
		else this.#host.sendChat(text);
	}

	#recall(delta: -1 | 1): void {
		if (this.#history.length === 0) return;
		if (delta < 0) {
			if (this.#historyIndex === this.#history.length) this.#historyDraft = this.line.peek().text;
			this.#historyIndex = Math.max(0, this.#historyIndex - 1);
			this.#setText(this.#history[this.#historyIndex] ?? "");
		} else {
			this.#historyIndex = Math.min(this.#history.length, this.#historyIndex + 1);
			this.#setText(
				this.#historyIndex === this.#history.length
					? this.#historyDraft
					: (this.#history[this.#historyIndex] ?? ""),
			);
		}
	}

	#quit(): void {
		if (this.#quitting) return;
		this.#quitting = true;
		void this.#host.close("stream stopped").finally(() => this.#done.resolve());
	}

	#accept(event: StreamConsoleEvent): void {
		const dim = (line: string): void => this.#append([{ s: "dim", t: line }]);
		batch(() => {
			switch (event.t) {
				case "link":
					this.linkState.set(event.state);
					if (event.state === "live") {
						if (event.channel !== undefined) this.channel.set(event.channel);
						if (event.detail !== undefined) this.viewerUrl.set(event.detail);
					}
					if (event.user !== undefined) this.user.set(event.user);
					dim(formatLinkEvent(event));
					break;
				case "pane": {
					const panes = new Map(this.panes.peek());
					if (event.action === "attached") {
						panes.set(event.id, event);
						dim(`pane attached: #${event.id} ${safeInline(event.title)} ${event.cols}x${event.rows}`);
					} else {
						panes.delete(event.id);
						dim(`pane closed: #${event.id} ${safeInline(event.title)}`);
					}
					this.panes.set(panes);
					break;
				}
				case "viewers":
					this.viewers.set(event.n);
					dim(`viewers: ${event.n}`);
					break;
				case "chat":
					this.#append(chatSpans(event.msg));
					break;
				case "title":
					this.title.set(event.title);
					dim(`title: ${safeInline(event.title)}`);
					break;
				case "error":
					this.#append([{ s: "error", t: safeInline(event.message) }]);
					break;
				case "notice":
					dim(safeInline(event.message));
					break;
			}
		});
	}
}

function ConsoleView(props: {
	readonly console: StreamConsole;
	readonly native: Accessor<boolean>;
	readonly rows: Accessor<number>;
	readonly inputRef: (node: UiNode) => void;
}): JSXNode {
	const c = props.console;
	const header = (): TspSpan[] => {
		const state = c.linkState();
		const channel = c.channel();
		const user = c.user();
		const spans: TspSpan[] = [
			state === "live"
				? { s: "accent strong", t: "● LIVE" }
				: { s: "dim", t: `○ ${state === "stopped" ? "offline" : state}` },
			{ t: " " },
			channel ? { t: `#${safeInline(channel)}` } : { s: "dim", t: "identifying channel" },
			{ s: "dim", t: " · " },
			{ t: safeInline(c.title()) },
		];
		if (user) spans.push({ s: "dim", t: " · " }, { t: "streaming as " }, { s: "accent", t: `@${safeInline(user)}` });
		return spans;
	};
	const details = (): TspSpan[] => {
		const url = c.viewerUrl();
		const panes = [...c.panes().values()];
		return [
			url ? { s: "link", t: safeInline(url), href: safeInline(url) } : { s: "dim", t: "waiting for stream server" },
			{ s: "dim", t: " · " },
			{ t: `👁️ ${c.viewers()} watching` },
			{ s: "dim", t: " · " },
			{
				t: `panes: ${panes.length === 0 ? "none" : panes.map(pane => `${pane.id}:${safeInline(pane.title)}`).join(" ")}`,
			},
		];
	};
	// The terminal shows the newest entries that fit, bottom-aligned; Tern scrolls the whole log.
	const logRows = (): JSXNode => {
		const log = c.log();
		const entries = log.map((spans, index) => ({ spans, index }));
		if (props.native()) return entries.map(({ spans, index }) => <text key={String(index)} spans={[...spans]} />);
		const height = Math.max(0, Math.max(CHROME_ROWS, props.rows()) - CHROME_ROWS);
		const shown = entries.slice(Math.max(0, entries.length - height));
		const blank = Math.max(0, height - shown.length);
		return [
			...Array.from({ length: blank }, (_, index) => <text key={`blank:${index}`} text=" " />),
			...shown.map(({ spans, index }) => <text key={String(index)} spans={[...spans]} wrap="none" truncate="end" />),
		];
	};
	return (
		<col role="omp.stream.console" onKey={key => c.key(key)}>
			<text key="header" spans={header} wrap="none" truncate="end" />
			<text key="details" spans={details} wrap="none" truncate="end" />
			<col key="log" grow={1} role="omp.stream.log">
				{logRows}
			</col>
			<input
				key="input"
				ref={props.inputRef}
				prompt="> "
				sendable={false}
				text={() => c.line().text}
				cursor={() => c.line().cursor}
				onEdit={edit => {
					const next = applyEdit(c.line.peek(), edit);
					if (next) c.line.set(next);
				}}
			/>
			{() =>
				props.native() ? (
					<row key="hint" gap="xs" align="center" role="omp.hint">
						<text spans={[{ s: "dim", t: "/title <text> · /quit ·" }]} />
						<kbd keys={["up"]} />
						<kbd keys={["down"]} />
						<text spans={[{ s: "dim", t: "history ·" }]} />
						<kbd keys={["ctrl+c"]} />
						<text spans={[{ s: "dim", t: "quit" }]} />
					</row>
				) : (
					<text
						key="hint"
						spans={[
							{
								s: "dim",
								t: `/title <text> · /quit · ${formatKeyHints(["up", "down"])} history · ${formatKeyHint("ctrl+c")} quit`,
							},
						]}
						wrap="none"
						truncate="end"
					/>
				)
			}
		</col>
	);
}

/** Run the fullscreen interactive stream chat console until the stream or user exits. */
export async function runStreamTui(host: StreamMuxHost, info: StreamTuiInfo): Promise<void> {
	await runStandalone({ title: info.title }, screen => {
		const stream = new StreamConsole(host, info);
		let input: UiNode | undefined;
		return {
			view: () => (
				<ConsoleView
					console={stream}
					native={screen.shell.native}
					rows={screen.rows}
					inputRef={node => (input = node)}
				/>
			),
			focus: root => input ?? root,
			done: stream.run(),
			dispose: () => stream.dispose(),
		};
	});
}
