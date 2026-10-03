import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTuiHyperlinks } from "@oh-my-pi/pi-coding-agent/modes/settings";
import * as openModule from "@oh-my-pi/pi-coding-agent/utils/open";
import type { TUI } from "@oh-my-pi/pi-tui";
import { loginUrlCopyCommand, loginUrlWritesSettled } from "@oh-my-pi/pi-tui/login-url";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as piUtils from "@oh-my-pi/pi-utils";

let tmp: string | undefined;
function useTempAgentDir(prefix = "login-dialog-test-"): string {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	vi.spyOn(piUtils, "getAgentDir").mockReturnValue(tmp);
	return tmp;
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(async () => {
	// A persisted-URL write still in flight would re-create the temp dir
	// after the rm below.
	await loginUrlWritesSettled();
	cfgTuiHyperlinks.clearOverride(settings);
	vi.restoreAllMocks();
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

afterAll(() => {
	resetSettingsForTest();
});

describe("LoginDialogComponent", () => {
	it("links every wrapped authorization URL row to the complete URL", () => {
		cfgTuiHyperlinks.override(settings, "always");
		useTempAgentDir();
		const openSpy = vi.spyOn(openModule, "openPath").mockImplementation(() => true);
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "google-antigravity", () => {}, openModule.openPath);
		const authorizationUrl =
			"https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Foauth-callback&scope=cloud-platform&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

		dialog.showAuth(authorizationUrl);
		const linkTarget = `${authorizationUrl}\x07`;
		const urlRows = dialog
			.renderContent(40)
			.filter(line => line.includes(linkTarget) && !Bun.stripANSI(line).includes("click to open"));

		expect(urlRows.length).toBeGreaterThan(1);
		expect(urlRows.map(line => Bun.stripANSI(line).trim()).join("")).toBe(authorizationUrl);
		expect(urlRows.every(line => line.includes(linkTarget))).toBe(true);
		expect(openSpy).toHaveBeenCalledWith(authorizationUrl);
	});

	// Plain `Text` word-wraps the clean-copy row and swallows the space at each
	// break, so a spaced agent dir displayed a command whose path does not
	// exist. The row wraps byte-complete by column instead.
	it("keeps the clean-copy command byte-complete across wrapped rows", async () => {
		const dir = useTempAgentDir("login dialog spaced agent dir ");
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(
			tui,
			"google-antigravity",
			() => {},
			() => true,
		);

		dialog.showAuth("https://auth.example.com/oauth/authorize?state=narrow");
		// The persisted-URL write is fire-and-forget off the render path.
		await loginUrlWritesSettled();
		const urlFileName = fs.readdirSync(dir).find(name => name.startsWith("login-url-"));
		expect(urlFileName).toBeDefined();
		const expected = `Clean copy: ${loginUrlCopyCommand(path.join(dir, urlFileName as string))}`;

		const width = 40;
		// Premise: the spaced agent dir must actually overflow the row.
		expect(expected.length).toBeGreaterThan(width);
		const plain = dialog.renderContent(width).map(line => Bun.stripANSI(line));
		const first = plain.findIndex(line => line.startsWith("Clean copy: "));
		expect(first).toBeGreaterThanOrEqual(0);
		const rows = plain.slice(first, first + Math.ceil(expected.length / width));
		for (const row of rows) {
			expect(row.length).toBeLessThanOrEqual(width);
		}
		// Full rows carry no padding; only the final row is padded to width.
		expect(rows.join("").trimEnd()).toBe(expected);
	});
});
