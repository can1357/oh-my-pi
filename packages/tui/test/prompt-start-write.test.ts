import { describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const PROMPT_START = "\x1b]133;A\x07";

class StatusTerminal extends VirtualTerminal {
	status: string | undefined;
	reports = 0;
	promptStarts = 0;

	override write(data: string): void {
		for (const match of data.matchAll(/\x1b\]7501;state=([a-z]+):app=test\x1b\\|\x1b\]133;A\x07/g)) {
			if (match[1] !== undefined) {
				this.status = match[1];
				this.reports++;
			} else {
				this.promptStarts++;
				if (this.status === "working" || this.status === "blocked") this.status = undefined;
			}
		}
		super.write(data);
	}

	report(status: string): void {
		this.write(`\x1b]7501;state=${status}:app=test\x1b\\`);
	}
}

describe("prompt-zone paints and program status lifetime", () => {
	it("restores working and blocked after real redraws, not identical diff paints", async () => {
		const terminal = new StatusTerminal(80, 8);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const message = new UserMessageComponent("Run sleep 15");
		tui.setFrameProvider({
			renderFrame: size => ({ viewport: [...message.render(size.columns), "status"] }),
			acknowledgeHistory() {},
		});
		let currentStatus = "idle";
		const unsubscribe = tui.addFrameWriteListener(frame => {
			if (frame.includes(PROMPT_START)) terminal.report(currentStatus);
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			for (const state of ["working", "blocked"]) {
				currentStatus = state;
				terminal.report(state);
				const before = terminal.reports;
				tui.requestRender(true);
				await scheduler.settle(terminal);
				expect(terminal.status).toBe(state);
				expect(terminal.reports).toBe(before + 1);

				tui.requestRender();
				await scheduler.settle(terminal);
				expect(terminal.reports).toBe(before + 1);
			}
			currentStatus = "working";
			terminal.report(currentStatus);
			terminal.resize(70, 8);
			await scheduler.advance(terminal, 180);
			expect(terminal.status).toBe("working");
			expect(terminal.promptStarts).toBeGreaterThanOrEqual(3);
		} finally {
			unsubscribe();
			tui.stop();
		}
	});
});
