import { describe, expect, test } from "bun:test";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui";
import { ClientTerminalBridge, HostedTerminal } from "../src/daemon/terminal-bridge";

class FakeTerminal implements Terminal {
	readonly writes: string[] = [];
	columns = 120;
	rows = 40;
	kittyProtocolActive = true;
	kittyEnableSequence = "\x1b[>7u";
	keyboardEnhancementEnterSequence = "\x1b[>7u";
	keyboardEnhancementExitSequence = "\x1b[<u";
	appearance: TerminalAppearance | undefined = "dark";
	#input?: (data: string) => void;
	#resize?: () => void;
	#appearance?: (appearance: TerminalAppearance) => void;
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#input = onInput;
		this.#resize = onResize;
	}
	stop(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(lines: number): void {
		this.write(lines > 0 ? `\x1b[${lines}B` : `\x1b[${-lines}A`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[2K");
	}
	clearFromCursor(): void {
		this.write("\x1b[0J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(title: string): void {
		this.write(`title:${title}`);
	}
	setProgress(active: boolean): void {
		this.write(`progress:${active}`);
	}
	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearance = callback;
	}
	emitInput(data: string): void {
		this.#input?.(data);
	}
	emitResize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.#resize?.();
	}
	emitAppearance(appearance: TerminalAppearance): void {
		this.appearance = appearance;
		this.#appearance?.(appearance);
	}
}

describe("daemon terminal bridge", () => {
	test("forwards the real terminal byte stream and live capabilities in both directions", () => {
		const physical = new FakeTerminal();
		const hosted = new HostedTerminal({
			columns: physical.columns,
			rows: physical.rows,
			kittyProtocolActive: physical.kittyProtocolActive,
			kittyEnableSequence: physical.kittyEnableSequence,
			keyboardEnhancementEnterSequence: physical.keyboardEnhancementEnterSequence,
			keyboardEnhancementExitSequence: physical.keyboardEnhancementExitSequence,
			appearance: physical.appearance,
		});
		const client = new ClientTerminalBridge(physical, {
			onInput: data => hosted.input(data),
			onResize: size => hosted.resize(size),
			onAppearance: appearance => hosted.setAppearance(appearance),
		});
		hosted.setOutput(data => client.output(data));

		let input = "";
		let resized = 0;
		hosted.start(
			data => {
				input += data;
			},
			() => {
				resized++;
			},
		);
		client.start();

		hosted.write("\x1b[32mOMP\x1b[0m");
		physical.emitInput("/resume\r");
		physical.emitResize(160, 50);
		physical.emitAppearance("light");

		expect(physical.writes).toContain("\x1b[32mOMP\x1b[0m");
		expect(input).toBe("/resume\r");
		expect(hosted.columns).toBe(160);
		expect(hosted.rows).toBe(50);
		expect(resized).toBe(1);
		expect(hosted.appearance).toBe("light");
	});
});
