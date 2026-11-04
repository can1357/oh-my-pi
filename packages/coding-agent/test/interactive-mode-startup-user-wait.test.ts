/**
 * Contract: a dialog only a person can answer, raised while the startup hooks
 * run (a `session_start` extension's `ctx.ui.confirm`), reports the run as
 * blocked. `user_wait_start` is published once, when the dialog opens, and the
 * dialog holds `InteractiveMode.init()` inside the hook step, so the event
 * controller must already be subscribed when the hooks run — otherwise the
 * title and the OSC 7501 record say idle for as long as the dialog stands.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, setProjectDir, Snowflake } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession, type TestSessionContext } from "./utilities";

describe("InteractiveMode startup dialogs", () => {
	let tmp: string;
	let originalProject: string;
	let testSession: TestSessionContext | undefined;
	let mode: InteractiveMode | undefined;

	beforeEach(async () => {
		tmp = path.join(os.tmpdir(), `omp-startup-wait-${Snowflake.next()}`);
		await fs.mkdir(tmp, { recursive: true });
		originalProject = getProjectDir();
		setProjectDir(tmp);
		spyOn(utils, "getConfigRootDir").mockReturnValue(tmp);
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: tmp });
	});

	afterEach(async () => {
		mode?.stop();
		mode = undefined;
		if (testSession) {
			await testSession.cleanup();
			testSession = undefined;
		}
		vi.restoreAllMocks();
		resetSettingsForTest();
		setProjectDir(originalProject);
		AgentStorage.close();
		HistoryStorage.close();
		closeSessionIndex();
		closeModelCache();
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("reports a dialog raised by a startup hook as blocked, not as an idle session", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		testSession = await createTestSession();
		const session = testSession.session;
		cfgStartupCheckUpdate.override(session.settings, false);
		cfgStartupChangelogMode.override(session.settings, "hidden");
		cfgStartupSetupWizard.override(session.settings, false);
		cfgStartupShowSplash.override(session.settings, false);
		cfgMarketplaceAutoUpdate.override(session.settings, "off");
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(200, 60) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const prompt = "an extension confirm dialog";
		const answered = Promise.withResolvers<void>();
		const opened = Promise.withResolvers<void>();
		// Stand in for a `session_start` hook whose untimed `ctx.ui.confirm` runs
		// through AgentSession.waitForUser: the dialog is open while the hook step
		// is awaited, and it is still open when init returns.
		const dialog = spyOn(mode, "initHooksAndCustomTools").mockImplementation(async () => {
			void session.waitForUser(() => {
				opened.resolve();
				return answered.promise;
			}, prompt);
			await opened.promise;
		});

		await mode.init({ suppressWelcomeIntro: true });
		// The subscription dispatches each event through a serialized async run.
		for (let i = 0; i < 50; i++) await Promise.resolve();

		expect(dialog).toHaveBeenCalled();
		expect(report.mock.calls.map(call => call[0])).toContainEqual({
			state: "blocked",
			kind: "question",
			msg: prompt,
		});

		answered.resolve();
	});
});
