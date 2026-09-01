import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type Component, type OverlayHandle, setKeybindings, TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { KeybindingsManager } from "../../../src/config/keybindings";
import { Settings } from "../../../src/config/settings";
import { SessionInfoOverlay } from "../../../src/modes/components/session-info-overlay";
import { getThemeByName, setThemeInstance, type Theme } from "../../../src/modes/theme/theme";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;
	output = "";

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.#onInput = onInput;
	}

	stop(): void {
		this.#onInput = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.output += data;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}

	sendInput(data: string): void {
		this.#onInput?.(data);
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	constructor(readonly label: string) {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(_width: number): string[] {
		return [this.label];
	}
}

let uiTheme: Theme;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	uiTheme = loaded;
	setThemeInstance(uiTheme);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

describe("SessionInfoOverlay", () => {
	it("renders session details, footer help, and fixed-width box rows", () => {
		const overlay = new SessionInfoOverlay(
			{ terminal: { rows: 12 } },
			"File: /tmp/session.jsonl\nProvider: openai\nTokens: 42",
			() => {},
		);

		const lines = overlay.render(48);
		const plain = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
		const text = plain.join("\n");

		expect(text).toContain("Session Info");
		expect(text).toContain("File: /tmp/session.jsonl");
		expect(text).toContain("↑/↓ scroll · Esc close");
		expect(lines.map(line => visibleWidth(line))).toEqual(Array(lines.length).fill(48));
		expect(plain[0]).toContain(uiTheme.boxRound.topLeft);
		expect(plain.at(-1)).toContain(uiTheme.boxRound.bottomLeft);
		expect(lines).toHaveLength(7);
	});

	it("preserves exact-width details when the scrollbar is visible", () => {
		const exactWidthDetail = `${"A".repeat(43)}Z`;
		const overlay = new SessionInfoOverlay(
			{ terminal: { rows: 8 } },
			[exactWidthDetail, "line 2", "line 3", "line 4", "line 5"].join("\n"),
			() => {},
		);

		const text = overlay
			.render(48)
			.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");

		expect(text).toContain("Z");
	});

	it("keeps narrow panels within the terminal height", () => {
		const overlay = new SessionInfoOverlay(
			{ terminal: { rows: 8 } },
			Array.from({ length: 20 }, (_, index) => `Detail ${index}`).join("\n"),
			() => {},
		);

		const lines = overlay.render(12);
		const plain = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

		expect(lines.length).toBeLessThanOrEqual(8);
		expect(plain[0]).toContain(uiTheme.boxRound.topLeft);
		expect(plain.at(-1)).toContain(uiTheme.boxRound.bottomLeft);
	});

	it("scrolls long details and closes on the configured cancel key", () => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		const onClose = vi.fn();
		const overlay = new SessionInfoOverlay(
			{ terminal: { rows: 8 } },
			Array.from({ length: 20 }, (_, index) => `Detail ${index}`).join("\n"),
			onClose,
		);

		const initial = overlay
			.render(40)
			.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");
		overlay.handleInput("\x1b[B");
		const scrolled = overlay
			.render(40)
			.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");

		expect(scrolled).not.toBe(initial);
		expect(onClose).not.toHaveBeenCalled();
		overlay.handleInput("\x07");
		expect(onClose).toHaveBeenCalledTimes(1);
		overlay.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("owns Escape through TUI focus and restores the editor without forwarding it", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new InputRecorder("editor");
		let handle: OverlayHandle | undefined;
		const onClose = vi.fn(() => handle?.hide());
		const overlay = new SessionInfoOverlay(tui, "File: in-memory", onClose);

		tui.addChild(editor);
		tui.setFocus(editor);
		try {
			tui.start();
			handle = tui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			});

			expect(tui.getFocused()).toBe(overlay);
			terminal.sendInput("\x1b");

			expect(onClose).toHaveBeenCalledTimes(1);
			expect(editor.inputs).toEqual([]);
			expect(tui.getFocused()).toBe(editor);
		} finally {
			handle?.hide();
			tui.stop();
		}
	});
});
