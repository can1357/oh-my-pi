import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as oauth from "@oh-my-pi/pi-ai/oauth";
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
	it("uses a grouped method's sign-in title and keeps its browser link usable", async () => {
		const opened: string[] = [];
		const title = "Sign in to Example with your subscription";
		const providers = spyOn(oauth, "getOAuthProviders").mockReturnValue([
			{
				id: "example-subscription",
				name: title,
				available: true,
				loginGroup: { title: "Example", label: "Choose an Example sign-in method", order: 1 },
			},
		]);
		let state: LoginDialogState;
		try {
			state = new LoginDialogState(
				"example-subscription",
				() => {},
				url => opened.push(url),
			);
		} finally {
			providers.mockRestore();
		}
		const url = "https://accounts.example.com/authorize?client_id=test";
		const prompt = "Paste the address from your browser (or the code it shows):";
		state.showAuth(url);
		const answer = state.showManualInput(prompt);
		const term = createTestTerminal(() => ({ layer: LoginDialog({ state }) }), {
			columns: 80,
			rows: 24,
			theme: loadThemeSync("dark"),
			capabilities: { hyperlinks: true },
		});
		try {
			const screen = term.screen().join("\n");
			expect(screen).toContain(title);
			expect(screen).not.toContain(`Login to ${title}`);
			expect(screen).not.toContain("client_id");
			expect(screen).toContain(prompt);
			expect(cellGrid(term.rows()).some(row => row.some(cell => cell.link === url))).toBe(true);
			expect(opened).toEqual([url]);

			const pastedAddress = "http://127.0.0.1:3210/oauth2callback?code=example";
			state.paste(pastedAddress);
			state.submit();
			expect(await answer).toBe(pastedAddress);
		} finally {
			term.dispose();
		}
	});

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
