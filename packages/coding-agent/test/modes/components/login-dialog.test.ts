import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LoginDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/login-dialog";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { loginUrlCopyCommand } from "@oh-my-pi/pi-coding-agent/utils/login-url";
import * as openModule from "@oh-my-pi/pi-coding-agent/utils/open";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { TUI } from "@oh-my-pi/pi-tui";

let tmp: string | undefined;
function useTempAgentDir(): void {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "login-dialog-test-"));
	vi.spyOn(piUtils, "getAgentDir").mockReturnValue(tmp);
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
	vi.restoreAllMocks();
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

afterAll(() => {
	resetSettingsForTest();
});

describe("LoginDialogComponent", () => {
	it("links every wrapped authorization URL row to the complete URL", () => {
		settings.override("tui.hyperlinks", "always");
		useTempAgentDir();
		const openSpy = vi.spyOn(openModule, "openPath").mockImplementation(() => true);
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "google-antigravity", () => {});
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

	// Same defect class as the wizard panel (codex r3911391657): plain `Text`
	// word-wraps the clean-copy row and swallows the space at each break, so a
	// spaced agent dir displayed a command whose path does not exist. The row
	// wraps byte-complete by column instead.
	it("keeps the clean-copy command byte-complete across wrapped rows", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "login dialog spaced agent dir "));
		vi.spyOn(piUtils, "getAgentDir").mockReturnValue(tmp);
		vi.spyOn(openModule, "openPath").mockImplementation(() => true);
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "google-antigravity", () => {});

		dialog.showAuth("https://auth.example.com/oauth/authorize?state=narrow");
		const urlFileName = fs.readdirSync(tmp).find(name => name.startsWith("login-url-"));
		expect(urlFileName).toBeDefined();
		const expected = `Clean copy: ${loginUrlCopyCommand(path.join(tmp, urlFileName as string))}`;

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
