import { describe, expect, it } from "bun:test";
import { setPromptZonesEnabled, UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const PROMPT_START = "\x1b]133;A\x07";

class PromptCountingTerminal extends VirtualTerminal {
	promptStarts = 0;

	override write(data: string): void {
		this.promptStarts += data.split(PROMPT_START).length - 1;
		super.write(data);
	}
}

describe("user bubble prompt zones across repaints", () => {
	// #17307: a terminal drops a working/blocked OSC 7501 record at every 133;A and
	// may announce the drop as a finished command, so while the host holds such a
	// record no redraw or resize may write a prompt start.
	it("writes no prompt start on redraws while zones are off, and restores the zone once they are back on", async () => {
		const terminal = new PromptCountingTerminal(80, 8);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const messages = [new UserMessageComponent("Run sleep 15"), new UserMessageComponent("and then?")];
		tui.setFrameProvider({
			renderFrame: size => ({ viewport: [...messages.flatMap(m => m.render(size.columns)), "status"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(terminal.promptStarts).toBe(2);

			setPromptZonesEnabled(false);
			tui.requestRender();
			await scheduler.settle(terminal);
			const before = terminal.promptStarts;
			for (let i = 0; i < 3; i++) {
				tui.requestRender(true);
				await scheduler.settle(terminal);
			}
			terminal.resize(70, 8);
			await scheduler.advance(terminal, 180);
			expect(terminal.promptStarts).toBe(before);

			setPromptZonesEnabled(true);
			tui.requestRender();
			await scheduler.settle(terminal);
			expect(terminal.promptStarts).toBe(before + 2);
			tui.requestRender();
			await scheduler.settle(terminal);
			expect(terminal.promptStarts).toBe(before + 2);
		} finally {
			setPromptZonesEnabled(true);
			tui.stop();
		}
	});
});
