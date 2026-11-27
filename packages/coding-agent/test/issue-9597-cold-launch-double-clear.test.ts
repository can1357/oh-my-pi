import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	applyStartupComposerPreferences,
	beginStartupComposer,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import type { StartupPreferences } from "../src/modes/interactive/startup-cache";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

import {
	cfgAutocompleteMaxVisible,
	cfgComposerShape,
	cfgStartupQuiet,
	cfgTuiImeSafeCursor,
	cfgTuiResizeScrollback,
	cfgTuiVimMode,
} from "@oh-my-pi/pi-coding-agent/modes/settings";

// Every destructive reset emits one erase-scrollback (ED3). Count that
// operation without coupling this regression to the ED2/ED3 ordering.
const ERASE_SCROLLBACK = "\x1b[3J";

/** Erase-scrollback operations in `output`. */
function countResets(output: readonly string[]): number {
	const all = output.join("");
	let n = 0;
	for (let i = all.indexOf(ERASE_SCROLLBACK); i !== -1; i = all.indexOf(ERASE_SCROLLBACK, i + 1)) n++;
	return n;
}

// Cold launch clears native history once the inline presentation is authoritative.
// Once InteractiveMode is ready, a normal replay can offer resumed transcript
// rows and repaint the viewport without another destructive reset. On conhost a
// second ED3-then-ED2 reset would archive the prepaint frame into scrollback
// after ED3 already ran, leaving a stale welcome above the live UI (issue #9597).
describe("issue #9597 — cold-launch welcome duplication", () => {
	let settings: Settings;
	let config: StartupPreferences;
	let savedPresentationEnv: string | undefined;

	beforeEach(async () => {
		savedPresentationEnv = Bun.env.PI_TUI_MODE;
		delete Bun.env.PI_TUI_MODE;
		resetSettingsForTest();
		initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: cfgStartupQuiet.get(settings),
			composerShape: cfgComposerShape.get(settings),
			resizeScrollback: cfgTuiResizeScrollback.get(settings),
			autocompleteMaxVisible: cfgAutocompleteMaxVisible.get(settings),
			vim: cfgTuiVimMode.get(settings),
			imeSafeCursor: cfgTuiImeSafeCursor.get(settings),
			mode: "inline",
		};
	});

	afterEach(() => {
		stopPendingStartupComposer();
		resetSettingsForTest();
		if (savedPresentationEnv === undefined) delete Bun.env.PI_TUI_MODE;
		else Bun.env.PI_TUI_MODE = savedPresentationEnv;
	});

	// `resuming` mirrors `main.ts` `runInteractiveMode`: `false` on a plain `omp`
	// launch, `true` for --continue/--resume/--fork.
	async function coldLaunch(
		resuming: boolean,
		cachedMode: StartupPreferences["mode"] = "inline",
	): Promise<{
		resets: number;
		welcomeRows: number;
		scrollBuffer: string;
	}> {
		const terminal = createModeTerminal({ columns: 100, rows: 30 });
		const exit = Promise.withResolvers<number>();
		beginStartupComposer({
			preferences: { ...config, mode: cachedMode },
			exit: exit.resolve,
			driver: terminal.memory.options,
			version: "18.0.4",
			cache: false,
		});
		terminal.press("ctrl+d");
		expect(await exit.promise).toBe(0);
		terminal.type("startup draft");
		await terminal.waitFor(
			rows => rows.some(row => row.includes("18.0.4")) && rows.some(row => row.includes("startup draft")),
		);
		expect(terminal.engine.isMainScreen).toBe(false);
		const draftRow = () => terminal.screen().findIndex(row => row.includes("startup draft"));
		const previewRow = draftRow();
		expect(countResets(terminal.memory.output)).toBe(0);
		applyStartupComposerPreferences({
			...config,
			presentation: config.mode,
			pointer: "select",
			copyOnRelease: true,
			theme: {},
		});
		const lease = takeStartupComposerLease();
		expect(lease).toBeDefined();
		await lease!.ready;
		await terminal.waitFor(() => terminal.engine.isMainScreen && draftRow() >= 0);
		// An inline preview uses the inline layout: only the underlying buffer changes.
		if (cachedMode === "inline") expect(draftRow()).toBe(previewRow);
		else expect(draftRow()).toBeLessThan(previewRow);
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
			lease!.frame,
		);
		lease!.adopt();
		try {
			await mode.init({ suppressWelcomeIntro: resuming, clearInitialTerminalHistory: true });
			await mode.renderInitialMessages({ preserveExistingChat: true });
			if (resuming) await terminal.waitFor(() => terminal.text().includes("resume marker answer"));
			await terminal.settle();
			const rows = terminal.text().split("\n");
			return {
				resets: countResets(terminal.memory.output),
				welcomeRows: rows.filter(l => l.includes("18.0.4")).length,
				scrollBuffer: rows.join("\n"),
			};
		} finally {
			mode.stop();
			await mode.shell.stop();
			terminal.dispose();
			await testSession.cleanup();
		}
	}

	it.each(["inline", "fullscreen"] as const)(
		"clears once on a fresh inline launch after %s prepaint",
		async cached => {
			const { resets, welcomeRows } = await coldLaunch(false, cached);
			// The first clear already owns the final welcome frame; the replay must not
			// clear again, or conhost promotes that frame into scrollback (duplicate).
			expect(resets).toBe(1);
			expect(welcomeRows).toBe(1);
		},
	);

	it("replays a resumed transcript without clearing native history again", async () => {
		const { resets, scrollBuffer, welcomeRows } = await coldLaunch(true);
		expect(resets).toBe(1);
		expect(scrollBuffer).toContain("resume marker answer");
		expect(welcomeRows).toBe(1);
	});
});
