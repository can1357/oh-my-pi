import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgAuthAccountPolicies } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { createAccountPriorityHost } from "@oh-my-pi/pi-coding-agent/session/account-priority";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const HOUR_MS = 60 * 60 * 1000;

let geometryStub: { restore(): void } | undefined;
let authStorage: AuthStorage;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.credentials.set("anthropic", [
		{
			type: "oauth",
			access: "access-a",
			refresh: "refresh-a",
			expires: Date.now() + HOUR_MS,
			accountId: "acct-a",
			email: "a@example.com",
		},
		{
			type: "oauth",
			access: "access-b",
			refresh: "refresh-b",
			expires: Date.now() + HOUR_MS,
			accountId: "acct-b",
			email: "b@example.com",
		},
		{
			type: "oauth",
			access: "access-c",
			refresh: "refresh-c",
			expires: Date.now() + HOUR_MS,
			accountId: "acct-c",
			email: "c@example.com",
		},
	]);
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
			accountPriority: createAccountPriorityHost(authStorage, settings, id =>
				id === "anthropic" ? "Anthropic" : id,
			),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

function rendered(component: SettingsSelectorComponent): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

function expectRow(component: SettingsSelectorComponent, needle: string): void {
	expect(rendered(component)).toContain(needle);
}

it("edits account priorities from the settings panel and persists them", () => {
	const comp = createSelector();

	for (const ch of "account priority") comp.handleInput(ch);
	comp.handleInput("\n");
	expectRow(comp, "Anthropic");
	expectRow(comp, "Round-robin");

	comp.handleInput("\n");
	expectRow(comp, "a@example.com");
	expectRow(comp, " 1. b@example.com");
	expectRow(comp, " 1. c@example.com");

	comp.handleInput("\x1b[B");
	comp.handleInput("3");
	expectRow(comp, " 3. b@example.com");
	expectRow(comp, " 1. a@example.com");
	const stored = cfgAuthAccountPolicies.get(settings);
	expect(stored.find(policy => policy.account.email === "b@example.com")?.priority).toBe(3);
	expect(stored.find(policy => policy.account.email === "a@example.com")?.priority).toBe(1);
	expect(stored.find(policy => policy.account.email === "c@example.com")?.priority).toBe(1);

	comp.handleInput("\x1b[B");
	comp.handleInput("3");
	expectRow(comp, " 3. c@example.com");

	comp.handleInput("\x1b");
	expectRow(comp, "1 · 3 · 3");

	comp.handleInput("\x1b");
	expectRow(comp, "anthropic");
	expect(cfgAuthAccountPolicies.get(settings)).toHaveLength(3);
});

it("lower/raise priorities via SS3 and CSI-parameter arrows on the cursor account", () => {
	const comp = createSelector();

	for (const ch of "account priority") comp.handleInput(ch);
	comp.handleInput("\n");
	comp.handleInput("\n"); // enter the account editor, cursor on a@example.com

	const storedPriority = (email: string): number | undefined =>
		cfgAuthAccountPolicies.get(settings).find(policy => policy.account.email === email)?.priority;

	// SS3 right (application-mode arrows) raises the cursor account.
	comp.handleInput("\x1bOC");
	comp.handleInput("\x1bOC");
	expect(storedPriority("a@example.com")).toBe(3);

	// CSI-parameter right raises the next account after moving down.
	comp.handleInput("\x1b[B");
	comp.handleInput("\x1b[1;1C");
	expect(storedPriority("b@example.com")).toBe(2);

	// SS3 left lowers it.
	comp.handleInput("\x1bOD");
	expect(storedPriority("b@example.com")).toBe(1);

	// CSI-parameter left clamps at 1.
	comp.handleInput("\x1b[1;1D");
	expect(storedPriority("b@example.com")).toBe(1);

	// Neighbors keep their values: the arrow hit only the cursor account.
	expect(storedPriority("a@example.com")).toBe(3);
	expect(storedPriority("c@example.com")).toBe(1);

	// Raise clamps at 9.
	for (let i = 0; i < 9; i++) comp.handleInput("\x1bOC");
	expect(storedPriority("b@example.com")).toBe(9);
});
