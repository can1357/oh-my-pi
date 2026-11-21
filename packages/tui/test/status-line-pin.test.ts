import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme, theme } from "../src/theme";
import { getSessionAccentAnsi, getSessionAccentHex } from "../src/theme/session-color";

const SETTINGS: StatusLineSettings = {
	preset: "minimal",
	leftSegments: ["session_name"],
	rightSegments: [],
	sessionAccent: true,
};

function createSession(id: string, name: string): StatusLineSession {
	return {
		state: { messages: [] },
		isFastModeEnabled: () => false,
		modelRegistry: { isUsingSubscription: () => false },
		sessionManager: {
			getSessionId: () => id,
			getSessionName: () => name,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as StatusLineSession;
}

const HOST = {
	getSettings: () => SETTINGS,
	gitEnabled: () => false,
	codexResetFireworksEnabled: () => false,
	getSettingsRevision: () => 0,
	getSessionSettingsIdentity: () => null,
	getSessionSettingsRevision: () => 0,
	goalStatusInFooter: () => false,
	activeAccount: () => undefined,
	canFetchUsageReports: () => false,
	fetchUsageReports: () => Promise.resolve(null),
	calculateTokensPerSecond: () => null,
	limitMatchesActiveAccount: () => false,
	computeCompactionBoundaries: () => null,
	lookupPullRequest: () => Promise.resolve({ stdout: "", exitCode: 0 }),
	resolveActiveRepo: () => null,
} as unknown as StatusLineHost<StatusLineSession>;

describe("status line session pin", () => {
	let component: StatusLineComponent | undefined;
	let originalProjectDir: string;
	beforeAll(async () => {
		await initTheme();
		// The border shows the project path beside the title; the filesystem root keeps the title's room
		// independent of where the repository is checked out.
		originalProjectDir = getProjectDir();
		setProjectDir(path.parse(originalProjectDir).root);
	});
	afterAll(() => {
		setProjectDir(originalProjectDir);
	});
	afterEach(() => {
		component?.dispose();
		component = undefined;
	});

	it("shows the pin only beside the pinned session's title, across subagent focus swaps", () => {
		const main = createSession("main-id", "CHROME: Audit Outreach Leads Status");
		const subagent = createSession("sub-id", "Subagent Worker");
		component = new StatusLineComponent(main, HOST);
		component.updateSettings(SETTINGS);
		const border = () => Bun.stripANSI(component!.getTopBorder(80).content);

		component.setSessionPinned("main-id", true);
		expect(border()).toContain(`${theme.icon.pin} CHROME: Audit Outreach Leads Status`);

		const expectedTitleAnsi = getSessionAccentAnsi(
			getSessionAccentHex("CHROME: Audit Outreach Leads Status", theme.sessionAccentInputs),
		);
		expect(component.getTopBorder(80).content).toContain(
			`${theme.fg("accent", theme.icon.pin)} ${expectedTitleAnsi}CHROME: Audit Outreach Leads Status\x1b[39m`,
		);

		component.setSession(subagent, "worker");
		expect(border()).toContain("Subagent Worker");
		expect(border()).not.toContain(theme.icon.pin);

		component.setSession(main, undefined);
		expect(border()).toContain(`${theme.icon.pin} CHROME: Audit Outreach Leads Status`);
		expect(component.getTopBorder(80).content).toContain(
			`${theme.fg("accent", theme.icon.pin)} ${expectedTitleAnsi}CHROME: Audit Outreach Leads Status\x1b[39m`,
		);
		component.setSessionPinned("main-id", false);
		expect(border()).not.toContain(theme.icon.pin);
	});
});
