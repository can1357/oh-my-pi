import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ComposerPreferences } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	beginStartupComposer,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

// Every destructive reset emits one erase-scrollback (ED3). Count that
// operation without coupling this regression to the ED2/ED3 ordering.
const ERASE_SCROLLBACK = "\x1b[3J";

/** VirtualTerminal that also records every raw byte the TUI writes. */
class CapturingTerminal extends VirtualTerminal {
	readonly raw: string[] = [];
	override write(data: string): void {
		this.raw.push(data);
		super.write(data);
	}
	countResets(): number {
		const all = this.raw.join("");
		let n = 0;
		for (let i = all.indexOf(ERASE_SCROLLBACK); i !== -1; i = all.indexOf(ERASE_SCROLLBACK, i + 1)) n++;
		return n;
	}
}

// Cold launch first clears native history while painting the prepaint welcome.
// Once InteractiveMode is ready, a normal replay can offer resumed transcript
// rows and repaint the viewport without another destructive reset. On conhost a
// second ED3-then-ED2 reset would archive the prepaint frame into scrollback
// after ED3 already ran, leaving a stale welcome above the live UI (issue #9597).
describe("issue #9597 — cold-launch welcome duplication", () => {
	let settings: Settings;
	let config: ComposerPreferences;

	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: settings.get("startup.quiet"),
			composerShape: settings.get("composer.shape") ?? "box",
			showHardwareCursor: settings.get("showHardwareCursor"),
			maxInlineImages: settings.get("tui.maxInlineImages"),
			resizeScrollback: settings.get("tui.resizeScrollback"),
			imeSafeCursor: settings.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
		};
	});

	afterEach(() => {
		stopPendingStartupComposer();
		resetSettingsForTest();
	});

	// `resuming` mirrors `main.ts` `runInteractiveMode`: `false` on a plain `omp`
	// launch, `true` for --continue/--resume/--fork.
	async function coldLaunch(resuming: boolean): Promise<{
		resets: number;
		welcomeRows: number;
		scrollBuffer: string;
	}> {
		const terminal = new CapturingTerminal(100, 30);
		beginStartupComposer({ preferences: config, terminal, version: "18.0.4", cache: false });
		await terminal.waitForRender();
		const lease = takeStartupComposerLease();
		expect(lease).toBeDefined();
		const testSession = await createTestSession({ inMemory: true });
		if (resuming) {
			testSession.sessionManager.appendMessage(userMsg("resume marker question"));
			testSession.sessionManager.appendMessage(assistantMsg("resume marker answer"));
		}
		const mode = new InteractiveMode(
			testSession.session,
			"18.0.4",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease!.composer,
		);
		lease!.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		try {
			await mode.init({ suppressWelcomeIntro: resuming, clearInitialTerminalHistory: true });
			await terminal.waitForRender();
			await mode.renderInitialMessages({ preserveExistingChat: true });
			// The replay rebuild paints in idle chunks after the promise resolves;
			// settle on the frame that actually shows the replayed transcript.
			await terminal.waitForRender(
				() =>
					!resuming ||
					terminal.getScrollBuffer().some(line => Bun.stripANSI(line).includes("resume marker answer")),
			);
			const rows = terminal.getScrollBuffer().map(l => Bun.stripANSI(l));
			return {
				resets: terminal.countResets(),
				welcomeRows: rows.filter(l => l.includes("18.0.4")).length,
				scrollBuffer: rows.join("\n"),
			};
		} finally {
			mode.stop();
			await testSession.cleanup();
		}
	}

	it("clears native history once on a fresh launch, leaving one welcome header", async () => {
		const { resets, welcomeRows } = await coldLaunch(false);
		// The first clear already owns the final welcome frame; the replay must not
		// clear again, or conhost promotes that frame into scrollback (duplicate).
		expect(resets).toBe(1);
		expect(welcomeRows).toBe(1);
	});

	it("replays a resumed transcript without clearing native history again", async () => {
		const { resets, scrollBuffer, welcomeRows } = await coldLaunch(true);
		expect(resets).toBe(1);
		expect(scrollBuffer).toContain("resume marker answer");
		expect(welcomeRows).toBe(1);
	});
});
