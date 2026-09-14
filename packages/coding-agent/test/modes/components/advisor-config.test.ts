import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { WatchdogConfigDoc } from "../../../src/advisor/config";
import type { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { AdvisorConfigOverlayComponent } from "../../../src/modes/components/advisor-config";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

describe("advisor config editor warnings and synthetic default row", () => {
	let settings: Settings;

	beforeAll(async () => {
		settings = await Settings.init({ inMemory: true });
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	const buildOverlay = (doc: WatchdogConfigDoc, onSave: (doc: WatchdogConfigDoc) => void) =>
		new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			doc,
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => onSave(doc),
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);

	it("still drops the untouched seeded default row on save", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply without touching the seeded row.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([]);
	});

	it("surfaces the newly active file's warnings on scope switch, and only there", async () => {
		const warnings: string[] = [];
		let pendingLoad: Promise<WatchdogConfigDoc> | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "Reviewer" }] },
			{
				loadDoc: () => {
					pendingLoad = Promise.resolve({
						advisors: [],
						warnings: [
							`${path.join(os.homedir(), ".omp", "WATCHDOG.yml")}: advisor "\x1b[31mBad\tName\x1b[0m" dropped — boom`,
						],
					});
					return pendingLoad;
				},
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
				warn: message => warnings.push(message),
			},
		);

		// Opening the project file shows nothing — the host owns initial warnings.
		expect(warnings).toEqual([]);

		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Switch scope to user.
		// The overlay awaits the same promise; awaiting it here runs after its continuation.
		await pendingLoad;

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('advisor "Bad   Name" dropped');
		expect(warnings[0]).toContain("~/.omp/WATCHDOG.yml");
		expect(warnings[0]).not.toContain(path.join(os.homedir(), ".omp", "WATCHDOG.yml"));
		// The toast is chat-mounted behind the fullscreen overlay, so the warning
		// must also render inside the editor itself.
		const frame = overlay.render(100).join("\n");
		expect(frame).toContain('advisor "Bad   Name" dropped');
	});

	it("renders the opening file's warnings inside the overlay without re-notifying", () => {
		const warnings: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "Good" }], warnings: ['/repo/WATCHDOG.yml: advisor "Bad" dropped — boom'] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
				warn: message => warnings.push(message),
			},
		);

		const frame = overlay.render(100).join("\n");
		expect(frame).toContain('advisor "Bad" dropped');
		expect(warnings).toEqual([]);
	});
});
