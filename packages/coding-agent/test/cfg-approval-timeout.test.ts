import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CfgProtocolHandler, setCfgApprovalHost } from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
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
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, setProjectDir, Snowflake } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession, type TestSessionContext } from "./utilities";

describe("cfg:// approval prompt wiring", () => {
	let tmp: string;
	let originalProject: string;
	let testSession: TestSessionContext | undefined;
	let mode: InteractiveMode | undefined;
	/** When true the stubbed selector waits for the abort signal instead of answering. */
	let hangSelector = false;

	beforeEach(async () => {
		tmp = path.join(os.tmpdir(), `omp-cfg-timeout-${Snowflake.next()}`);
		await fs.mkdir(tmp, { recursive: true });
		originalProject = getProjectDir();
		setProjectDir(tmp);
		spyOn(utils, "getConfigRootDir").mockReturnValue(tmp);
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: tmp });
		hangSelector = false;
	});

	afterEach(async () => {
		setCfgApprovalHost(null);
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
		resetSessionIndexForTests();
		closeModelCache();
		await fs.rm(tmp, { recursive: true, force: true });
	});

	async function startMode(askTimeout: number | undefined): Promise<Array<number | undefined>> {
		testSession = await createTestSession(
			askTimeout === undefined ? {} : { settingsOverrides: { "ask.timeout": askTimeout } },
		);
		cfgStartupCheckUpdate.override(testSession.session.settings, false);
		cfgStartupChangelogMode.override(testSession.session.settings, "hidden");
		cfgStartupSetupWizard.override(testSession.session.settings, false);
		cfgStartupShowSplash.override(testSession.session.settings, false);
		cfgMarketplaceAutoUpdate.override(testSession.session.settings, "off");
		mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(200, 60) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		const seen: Array<number | undefined> = [];
		spyOn(ExtensionUiController.prototype, "showCollabAwareSelector").mockImplementation(
			async (_title: string, _options: unknown, dialogOptions?: { timeout?: number; signal?: AbortSignal }) => {
				seen.push(dialogOptions?.timeout);
				// Mirror the real dialog: a pre-aborted signal settles dismissed
				// without presenting; otherwise wait for the abort like a user
				// dismissal that only arrives via stop().
				if (dialogOptions?.signal?.aborted) return undefined;
				if (hangSelector) {
					const { promise, resolve } = Promise.withResolvers<undefined>();
					dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
					await promise;
					return undefined;
				}
				return "Allow once";
			},
		);
		await mode.init({ suppressWelcomeIntro: true });
		seen.length = 0;
		return seen;
	}

	function outcomeOf(result: unknown): unknown {
		return (result as { details?: { cfg?: { outcome?: string } } }).details?.cfg?.outcome;
	}

	async function waitForPrompt(seen: Array<number | undefined>): Promise<void> {
		const start = Date.now();
		while (seen.length === 0) {
			if (Date.now() - start > 10_000) throw new Error("approval prompt never appeared");
			await Bun.sleep(25);
		}
	}

	function driveWrite(signal?: AbortSignal): Promise<unknown> {
		const session: ToolSession = {
			cwd: testSession!.tempDir,
			hasUI: true,
			settingsApproval: true,
			taskDepth: 0,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: testSession!.session.settings,
		};
		return new CfgProtocolHandler().write(parseInternalUrl("cfg://advisor/enabled"), "true", { session, signal });
	}

	it("prompts without a deadline when ask.timeout is at its default", async () => {
		// Regression for #15080: the prompt used a hardcoded 10s deadline.
		// A hardcoded value here keeps a helper green but fails below,
		// because this is the timeout the dialog actually receives.
		const seen = await startMode(undefined);
		await driveWrite();
		expect(seen).toEqual([undefined]);
	}, 60_000);

	it("prompts with the ask.timeout deadline in milliseconds", async () => {
		const seen = await startMode(45);
		await driveWrite();
		expect(seen).toEqual([45_000]);
	}, 60_000);

	it("denies a pending approval when the mode stops", async () => {
		// Without a deadline the prompt would outlive the UI waiting on it.
		hangSelector = true;
		const seen = await startMode(undefined);
		const pending = driveWrite();
		await waitForPrompt(seen);
		mode!.stop();
		expect(outcomeOf(await pending)).toBe("declined");
	}, 60_000);

	it("denies approvals still queued behind the mutex when the mode stops", async () => {
		// The second write waits on approvalQueue behind the first. Stopping
		// must deny it too, not leave it prompting a torn-down UI forever.
		hangSelector = true;
		const seen = await startMode(undefined);
		const first = driveWrite();
		const second = driveWrite();
		await waitForPrompt(seen);
		mode!.stop();
		expect(outcomeOf(await first)).toBe("declined");
		expect(outcomeOf(await second)).toBe("declined");
		// Only the first write ever presented: the queued one denied on the
		// already-aborted signal without prompting.
		expect(seen).toEqual([undefined]);
	}, 60_000);

	it("denies a pending approval when the calling turn aborts", async () => {
		// A collab guest interrupting the agent aborts the turn without
		// stopping the mode; the orphaned prompt must not linger past it.
		hangSelector = true;
		const seen = await startMode(undefined);
		const turn = new AbortController();
		const pending = driveWrite(turn.signal);
		await waitForPrompt(seen);
		turn.abort();
		expect(outcomeOf(await pending)).toBe("declined");
	}, 60_000);
});
