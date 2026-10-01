import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as openModule from "@oh-my-pi/pi-coding-agent/utils/open";
import type { TUI } from "@oh-my-pi/pi-tui";

import { cfgTuiHyperlinks } from "@oh-my-pi/pi-coding-agent/modes/settings";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	cfgTuiHyperlinks.clearOverride(settings);
});

afterAll(() => {
	resetSettingsForTest();
});

describe("LoginDialogComponent", () => {
	it("links every wrapped authorization URL row to the complete URL", () => {
		cfgTuiHyperlinks.override(settings, "always");
		const openSpy = spyOn(openModule, "openPath").mockImplementation(() => {});
		try {
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
		} finally {
			openSpy.mockRestore();
		}
	});
});
