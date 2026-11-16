// Real ProcessTerminal + Composer retirement for the tmux height regression.
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui/tui";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

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
const terminal = new ProcessTerminal();
// Destructive resets (ED3 + repaint from row zero) the engine painted.
let resets = 0;
const composer = new Composer({
	terminal,
	preferences: { ...COMPOSER_DEFAULTS, quiet: true, resizeScrollback: "rebuild" },
});
const transcript = new TranscriptContainer();
for (let id = 0; id < 1000; id++) transcript.addChild(new Block(id));
composer.setRuntimeChildren([transcript, new Editor()]);
composer.ui.addPaintListener(paint => {
	if (paint.reset) resets++;
	if (!paint.alt) terminal.setTitle(JSON.stringify({ height: paint.rows, resets }));
});
composer.start({ playWelcomeIntro: false });
await Bun.sleep(60000);
composer.ui.stop();
