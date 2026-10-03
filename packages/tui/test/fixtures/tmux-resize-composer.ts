// Real ProcessTerminal + Composer retirement for the tmux height regression.
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui/tui";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

class RecordingTerminal extends ProcessTerminal {
	resets = 0;
	override write(data: string): void {
		this.resets += data.split("\x1b[3J").length - 1;
		super.write(data);
	}
}

class Block {
	constructor(readonly id: number) {}
	render(width: number): string[] {
		return [`block-${String(this.id).padStart(5, "0")}`.padEnd(Math.max(0, width - 1), ".")];
	}
}

class Editor {
	render(): string[] {
		return ["EDITOR-TOP", `input${CURSOR_MARKER}`, "EDITOR-BOTTOM"];
	}
}

setTerminalHeadless(false);
const terminal = new RecordingTerminal();
const composer = new Composer({
	terminal,
	preferences: { ...COMPOSER_DEFAULTS, quiet: true, resizeScrollback: "rebuild" },
});
const transcript = new TranscriptContainer();
for (let id = 0; id < 1000; id++) transcript.addChild(new Block(id));
composer.setRuntimeChildren([transcript, new Editor()]);
composer.ui.addPaintListener(paint => {
	if (!paint.alt) terminal.setTitle(JSON.stringify({ height: paint.rows, resets: terminal.resets }));
});
composer.start({ playWelcomeIntro: false });
await Bun.sleep(60000);
composer.ui.stop();
