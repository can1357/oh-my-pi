import { stripVTControlCharacters } from "node:util";
import {
	Input,
	matchesKey,
	ProcessTerminal,
	replaceTabs,
	ScrollView,
	truncateToWidth,
	type Component,
	type Focusable,
	TUI,
} from "@oh-my-pi/pi-tui";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-tui/app-keybindings";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { StreamChatMessage, TspSpan } from "@oh-my-pi/pi-wire";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { col, kbd, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { StreamConsoleEvent, StreamMuxHost } from "./streamer";

const HISTORY_LIMIT = 50;
const PURPLE = chalk.hex("#a855f7");
const CHAT_COLORS: readonly ((text: string) => string)[] = [
	chalk.cyan,
	chalk.green,
	chalk.yellow,
	chalk.blue,
	chalk.magenta,
];
/** Semantic tokens standing in for {@link CHAT_COLORS}, index for index. */
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

class StreamConsoleComponent implements Component, Focusable {
	readonly #ui: TUI;
	readonly #host: StreamMuxHost;
	readonly #done = Promise.withResolvers<void>();
	readonly #logView = new ScrollView([], { height: 1, followTail: true, anchor: "end" });
	readonly #input = new Input();
	readonly #logLines: string[] = [];
	/** Native twin of {@link #logLines}: one keyed text node per entry, built once. */
	readonly #logNodes: NativeNode[] = [];
	/** {@link #logLines} truncated to {@link #logWidth}; rebuilt only when the width changes. */
	#logRendered: string[] = [];
	#logWidth: number | undefined;
	/** True when {@link #logRendered} changed since it was last handed to the scroll view. */
	#logDirty = false;
	#native: { revision: number; node: NativeNode } | undefined;
	#revision = 0;
	readonly #panes = new Map<number, PaneSummary>();
	readonly #history: string[] = [];
	readonly #unsubscribe: () => void;
	#historyIndex = 0;
	#historyDraft = "";
	#linkState: Extract<StreamConsoleEvent, { t: "link" }>["state"] = "connecting";
	#channel = "";
	#viewerUrl = "";
	#title: string;
	#user: string | undefined;
	#viewers = 0;
	#quitting = false;
	#focused = false;

	constructor(ui: TUI, host: StreamMuxHost, info: StreamTuiInfo) {
		this.#ui = ui;
		this.#host = host;
		this.#title = info.title;
		this.#input.prompt = "> ";
		this.#input.onSubmit = value => this.#submit(value);
		this.#unsubscribe = info.subscribe(event => this.#acceptEvent(event));
		for (const event of info.initialEvents) this.#acceptEvent(event);
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(focused: boolean) {
		this.#focused = focused;
		this.#input.focused = focused;
	}

	get debugChildren(): readonly Component[] {
		return [this.#logView, this.#input];
	}

	run(): Promise<void> {
		return Promise.race([this.#done.promise, this.#host.wait().then(() => undefined)]);
	}

	dispose(): void {
		this.#unsubscribe();
		this.#logView.dispose();
		this.#input.focused = false;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#quit();
			return;
		}
		if (matchesKey(data, "up")) {
			this.#recall(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.#recall(1);
			return;
		}
		this.#input.handleInput(data);
		this.#ui.requestRender();
	}

	/**
	 * Native console: status and details lines, the log (the terminal scrolls
	 * and keeps the tail), the chat input and the key hints.
	 */
	describe(): NativeNode {
		if (this.#native?.revision === this.#revision) return this.#native.node;
		const header: TspSpan[] = [
			this.#linkState === "live"
				? span("● LIVE", "accent strong")
				: span(`○ ${this.#linkState === "stopped" ? "offline" : this.#linkState}`, "dim"),
			span(" "),
			this.#channel ? span(`#${safeInline(this.#channel)}`) : span("identifying channel", "dim"),
			span(" · ", "dim"),
			span(safeInline(this.#title)),
		];
		if (this.#user) {
			header.push(span(" · ", "dim"), span("streaming as "), span(`@${safeInline(this.#user)}`, "accent"));
		}
		const paneList =
			this.#panes.size === 0
				? "none"
				: [...this.#panes.values()].map(pane => `${pane.id}:${safeInline(pane.title)}`).join(" ");
		const details: TspSpan[] = [
			this.#viewerUrl
				? span(safeInline(this.#viewerUrl), "link", { href: safeInline(this.#viewerUrl) })
				: span("waiting for stream server", "dim"),
			span(" · ", "dim"),
			span(`👁 ${this.#viewers} watching`),
			span(" · ", "dim"),
			span(`panes: ${paneList}`),
		];
		const hint = row(
			[
				text([span("/title <text> · /quit ·", "dim")]),
				kbd("up", "up"),
				kbd("down", "down"),
				text([span("history ·", "dim")]),
				kbd("ctrl+c", "quit"),
				text([span("quit", "dim")]),
			],
			{ gap: "xs", align: "center", role: "omp.hint" },
		);
		const consoleNode = col(
			[
				text(header, { wrap: "none" }),
				text(details, { wrap: "none" }),
				col(this.#logNodes.slice(), { grow: 1, role: "omp.stream.log" }),
				this.#input,
				hint,
			],
			{ role: "omp.stream.console" },
		);
		this.#native = { revision: this.#revision, node: consoleNode };
		return consoleNode;
	}

	/** Append one log entry in both presentations. */
	#log(ansi: string, spans: readonly TspSpan[]): void {
		this.#logLines.push(ansi);
		this.#logNodes.push(node("text", { spans }, undefined, `${this.#logNodes.length}`));
		if (this.#logWidth !== undefined) this.#logRendered.push(truncateToWidth(ansi, this.#logWidth));
		this.#logDirty = true;
	}

	render(width: number): readonly string[] {
		const height = Math.max(4, this.#ui.terminal.rows);
		const bodyHeight = Math.max(0, height - 4);
		const status =
			this.#linkState === "live"
				? PURPLE.bold("● LIVE")
				: chalk.dim(`○ ${this.#linkState === "stopped" ? "offline" : this.#linkState}`);
		const identity = this.#user ? ` ${chalk.dim("·")} streaming as ${PURPLE(`@${safeInline(this.#user)}`)}` : "";
		const channel = this.#channel ? `#${safeInline(this.#channel)}` : chalk.dim("identifying channel");
		const header = `${status} ${channel} ${chalk.dim("·")} ${safeInline(this.#title)}${identity}`;
		const paneList =
			this.#panes.size === 0
				? "none"
				: [...this.#panes.values()].map(pane => `${pane.id}:${safeInline(pane.title)}`).join(" ");
		const viewerUrl = this.#viewerUrl ? safeInline(this.#viewerUrl) : chalk.dim("waiting for stream server");
		const details = `${viewerUrl} ${chalk.dim("·")} 👁 ${this.#viewers} watching ${chalk.dim("·")} panes: ${paneList}`;
		const hint = chalk.dim(
			`/title <text> · /quit · ${formatKeyHints(["up", "down"])} history · ${formatKeyHint("ctrl+c")} quit`,
		);

		if (width !== this.#logWidth) {
			this.#logRendered = this.#logLines.map(line => truncateToWidth(line, width));
			this.#logWidth = width;
			this.#logDirty = true;
		}
		if (this.#logDirty) {
			this.#logView.setLines(this.#logRendered);
			this.#logDirty = false;
		}
		this.#logView.setHeight(bodyHeight);
		return [
			truncateToWidth(header, width),
			truncateToWidth(details, width),
			...this.#logView.render(width).map(line => truncateToWidth(line, width)),
			...this.#input.render(width).map(line => truncateToWidth(line, width)),
			truncateToWidth(hint, width),
		];
	}

	#submit(value: string): void {
		this.#revision++;
		const text = value.trim();
		this.#input.setValue("");
		if (!text) {
			this.#historyIndex = this.#history.length;
			this.#historyDraft = "";
			this.#ui.requestRender();
			return;
		}
		this.#history.push(text);
		if (this.#history.length > HISTORY_LIMIT) this.#history.shift();
		this.#historyIndex = this.#history.length;
		this.#historyDraft = "";
		if (text === "/quit") {
			this.#quit();
			return;
		}
		if (text.startsWith("/title ")) {
			this.#host.setTitle(text.slice(7));
		} else {
			this.#host.sendChat(text);
		}
		this.#ui.requestRender();
	}

	#recall(delta: -1 | 1): void {
		if (this.#history.length === 0) return;
		if (delta < 0) {
			if (this.#historyIndex === this.#history.length) this.#historyDraft = this.#input.getValue();
			this.#historyIndex = Math.max(0, this.#historyIndex - 1);
			this.#input.setValue(this.#history[this.#historyIndex] ?? "");
		} else {
			this.#historyIndex = Math.min(this.#history.length, this.#historyIndex + 1);
			this.#input.setValue(
				this.#historyIndex === this.#history.length
					? this.#historyDraft
					: (this.#history[this.#historyIndex] ?? ""),
			);
		}
		this.#ui.requestRender();
	}

	#quit(): void {
		if (this.#quitting) return;
		this.#revision++;
		this.#quitting = true;
		this.#ui.requestRender();
		void this.#host.close("stream stopped").finally(() => this.#done.resolve());
	}

	#acceptEvent(event: StreamConsoleEvent): void {
		this.#revision++;
		const dim = (line: string): void => this.#log(chalk.dim(line), [span(line, "dim")]);
		switch (event.t) {
			case "link":
				this.#linkState = event.state;
				if (event.state === "live") {
					if (event.channel !== undefined) this.#channel = event.channel;
					if (event.detail !== undefined) this.#viewerUrl = event.detail;
				}
				if (event.user !== undefined) this.#user = event.user;
				dim(formatLinkEvent(event));
				break;
			case "pane":
				if (event.action === "attached") {
					this.#panes.set(event.id, event);
					dim(`pane attached: #${event.id} ${safeInline(event.title)} ${event.cols}x${event.rows}`);
				} else {
					this.#panes.delete(event.id);
					dim(`pane closed: #${event.id} ${safeInline(event.title)}`);
				}
				break;
			case "viewers":
				this.#viewers = event.n;
				dim(`viewers: ${event.n}`);
				break;
			case "chat":
				this.#log(formatChatEvent(event.msg), describeChatEvent(event.msg));
				break;
			case "title":
				this.#title = event.title;
				dim(`title: ${safeInline(event.title)}`);
				break;
			case "error":
				this.#log(chalk.red(safeInline(event.message)), [span(safeInline(event.message), "error")]);
				break;
			case "notice":
				dim(safeInline(event.message));
				break;
		}
		this.#ui.requestRender();
	}
}

function safeInline(text: string): string {
	return replaceTabs(stripVTControlCharacters(text)).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function formatLinkEvent(event: Extract<StreamConsoleEvent, { t: "link" }>): string {
	const detail = event.detail ? ` · ${safeInline(event.detail)}` : "";
	const user = event.user ? ` · @${safeInline(event.user)}` : "";
	return `link: ${event.state}${detail}${user}`;
}

function formatChatEvent(message: StreamChatMessage): string {
	const time = new Date(message.ts);
	const timestamp = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
	const name = safeInline(message.name);
	const coloredName = message.host
		? chalk.bold(PURPLE(name))
		: (CHAT_COLORS[stableNameHash(name) % CHAT_COLORS.length]?.(name) ?? name);
	return `${chalk.dim(timestamp)} ${coloredName}: ${safeInline(message.text)}`;
}

/** Native {@link formatChatEvent}: the same line as styled spans. */
function describeChatEvent(message: StreamChatMessage): TspSpan[] {
	const time = new Date(message.ts);
	const timestamp = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
	const name = safeInline(message.name);
	const nameToken = message.host ? "accent strong" : CHAT_TOKENS[stableNameHash(name) % CHAT_TOKENS.length];
	return [span(timestamp, "dim"), span(" "), span(name, nameToken), span(`: ${safeInline(message.text)}`)];
}

function stableNameHash(name: string): number {
	let hash = 0;
	for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
	return hash;
}

/** Run the fullscreen interactive stream chat console until the stream or user exits. */
export async function runStreamTui(host: StreamMuxHost, info: StreamTuiInfo): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const component = new StreamConsoleComponent(ui, host, info);
	const overlay = ui.showOverlay(component, {
		fullscreen: true,
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		mouseTracking: false,
	});
	ui.setFocus(component);
	ui.start();
	try {
		await component.run();
	} finally {
		component.dispose();
		overlay.hide();
		ui.stop();
	}
}
