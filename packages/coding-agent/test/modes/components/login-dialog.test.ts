import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cellGrid } from "@oh-my-pi/pi-tui/testing/cells";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { LoginDialog, LoginDialogState } from "../../../src/ui/overlays/panels/login-dialog";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

describe("login dialog", () => {
	it("opens the authorization URL and links every wrapped URL row to the complete URL", () => {
		const opened: string[] = [];
		const state = new LoginDialogState(
			"anthropic",
			() => {},
			url => opened.push(url),
		);
		const authorizationUrl =
			"https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Foauth-callback&scope=cloud-platform&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

		state.showAuth(authorizationUrl);
		const term = createTestTerminal(() => ({ layer: LoginDialog({ state }) }), {
			columns: 40,
			rows: 40,
			theme: loadThemeSync("dark"),
			capabilities: { hyperlinks: true },
		});
		try {
			// Rows whose cells link to the URL: the URL itself, wrapped over several rows, plus the open hint.
			const grid = cellGrid(term.rows());
			const urlRows = grid
				.filter(row => row.some(cell => cell.link === authorizationUrl))
				.map(row =>
					row
						.filter(cell => cell.link === authorizationUrl)
						.map(cell => cell.ch)
						.join(""),
				)
				.filter(text => !text.includes("click to open"));

			expect(urlRows.length).toBeGreaterThan(1);
			expect(urlRows.map(text => text.trim()).join("")).toBe(authorizationUrl);
			expect(opened).toEqual([authorizationUrl]);
		} finally {
			term.dispose();
		}
	});
});
