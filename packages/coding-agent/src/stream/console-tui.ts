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
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { StreamChatMessage } from "@oh-my-pi/pi-wire";
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
		const hint = chalk.dim("/title <text> · /quit · ↑/↓ history · Ctrl-C quit");

		this.#logView.setLines(this.#logLines.map(line => truncateToWidth(line, width)));
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
		this.#quitting = true;
		this.#ui.requestRender();
		void this.#host.close("stream stopped").finally(() => this.#done.resolve());
	}

	#acceptEvent(event: StreamConsoleEvent): void {
		switch (event.t) {
			case "link":
				this.#linkState = event.state;
				if (event.state === "live") {
					if (event.channel !== undefined) this.#channel = event.channel;
					if (event.detail !== undefined) this.#viewerUrl = event.detail;
				}
				if (event.user !== undefined) this.#user = event.user;
				this.#logLines.push(chalk.dim(formatLinkEvent(event)));
				break;
			case "pane":
				if (event.action === "attached") {
					this.#panes.set(event.id, event);
					this.#logLines.push(
						chalk.dim(`pane attached: #${event.id} ${safeInline(event.title)} ${event.cols}x${event.rows}`),
					);
				} else {
					this.#panes.delete(event.id);
					this.#logLines.push(chalk.dim(`pane closed: #${event.id} ${safeInline(event.title)}`));
				}
				break;
			case "viewers":
				this.#viewers = event.n;
				this.#logLines.push(chalk.dim(`viewers: ${event.n}`));
				break;
			case "chat":
				this.#logLines.push(formatChatEvent(event.msg));
				break;
			case "title":
				this.#title = event.title;
				this.#logLines.push(chalk.dim(`title: ${safeInline(event.title)}`));
				break;
			case "error":
				this.#logLines.push(chalk.red(safeInline(event.message)));
				break;
			case "notice":
				this.#logLines.push(chalk.dim(safeInline(event.message)));
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
