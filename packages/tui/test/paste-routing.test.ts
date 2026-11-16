import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class Recorder implements Component {
	readonly events: string[] = [];
	onPaste?: () => void;

	constructor(readonly name: string) {}

	handleInput(data: string): void {
		this.events.push(`${this.name}:key:${JSON.stringify(data)}`);
	}

	handlePaste(text: string, enter?: string): void {
		this.events.push(`${this.name}:paste:${JSON.stringify(text)}:${JSON.stringify(enter ?? null)}`);
		this.onPaste?.();
	}

	render(): readonly string[] {
		return [this.name];
	}
}

async function drainNextTick(): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
}

describe("TUI paste routing", () => {
	it("delivers a decoded paste and its same-read Enter to the component that took the paste", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const first = new Recorder("first");
		const second = new Recorder("second");
		tui.addChild(first);
		tui.addChild(second);
		tui.setFocus(first);
		// The paste itself moves focus (a large-paste menu); the Enter still belongs to `first`.
		first.onPaste = () => tui.setFocus(second);
		const keys: string[] = [];
		tui.addInputListener(data => {
			keys.push(data);
			return undefined;
		});

		try {
			tui.start();
			await drainNextTick();
			terminal.sendInput("\x1b[200~line1\x1b[27;5;106~line2\x1b[201~\r");

			expect(first.events).toEqual(['first:paste:"line1\\nline2":"\\r"', 'first:key:"\\r"']);
			expect(second.events).toEqual([]);
			// Key listeners never see the paste, nor the Enter that rode along with it.
			expect(keys).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("offers pastes to paste listeners first; a consumed paste's Enter takes the key path", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const editor = new Recorder("editor");
		tui.addChild(editor);
		tui.setFocus(editor);
		const pastes: string[] = [];
		const keys: string[] = [];
		let consume = true;
		tui.addPasteListener(text => {
			pastes.push(text);
			return consume ? { consume: true } : undefined;
		});
		tui.addInputListener(data => {
			keys.push(data);
			return { consume: true };
		});

		try {
			tui.start();
			await drainNextTick();
			terminal.sendInput("\x1b[200~to the pty\x1b[201~\r");
			expect(pastes).toEqual(["to the pty"]);
			expect(keys).toEqual(["\r"]);
			expect(editor.events).toEqual([]);

			consume = false;
			terminal.sendInput("\x1b[200~to the editor\x1b[201~");
			expect(pastes).toEqual(["to the pty", "to the editor"]);
			expect(editor.events).toEqual(['editor:paste:"to the editor":null']);
		} finally {
			tui.stop();
		}
	});

	it("routes debug-injected pastes through the same path", () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const editor = new Recorder("editor");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.injectDebugPaste("\x1b[200~kept literally");
		expect(editor.events).toEqual(['editor:paste:"\\u001b[200~kept literally":null']);
	});
});
