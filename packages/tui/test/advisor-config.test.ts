import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "../src/index";
import {
	AdvisorConfigOverlayComponent,
	type AdvisorConfigDeps,
	type WatchdogConfigDoc,
} from "../src/overlays/advisor-config";
import { getThemeByName, setThemeInstance } from "../src/theme";

const deps: AdvisorConfigDeps = {
	getAvailableModels: () => [],
	browserSource: {
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: [],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => undefined,
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
	},
	defaultToolNames: new Set(["read", "grep", "glob"]),
	scopedModels: [],
	availableToolNames: [],
};

describe("advisor review mode picker", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	it("preserves configured mode when accepting current selection and saving", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Reviewer", reviewMode: "agent-end", reviewInterval: 3 }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => {
					saved = structuredClone(doc);
				},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Review mode.
		overlay.handleInput("\r"); // Accept current mode without navigating.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer", reviewMode: "agent-end", reviewInterval: 3 }]);
	});
});

describe("advisor sync backlog picker", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	const buildOverlay = (doc: WatchdogConfigDoc, onSave: (doc: WatchdogConfigDoc) => void) =>
		new AdvisorConfigOverlayComponent({} as TUI, deps, "project", doc, {
			loadDoc: async () => ({ advisors: [] }),
			save: async (_scope, doc) => onSave(doc),
			close: () => {},
			requestRender: () => {},
			notify: () => {},
		});

	it("applies an explicit strict override through the picker and saves it", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer" }] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (inherit selected).
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Pick strict.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer", syncBacklog: "strict" }]);
	});

	it("clears an explicit override back to inherit", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer", syncBacklog: "off" }] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (off selected).
		overlay.handleInput("\x1b[A"); // Up to inherit.
		overlay.handleInput("\r"); // Pick inherit.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer" }]);
	});

	it("keeps a sync backlog edit on the seeded default row instead of discarding the roster", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Seeded "default" advisor detail.
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (inherit selected).
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Pick strict.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		// A real edit must survive: the seeded row is no longer synthetic, so the
		// save must not collapse the roster to empty (which would delete the file).
		expect(saved?.advisors).toEqual([{ name: "default", syncBacklog: "strict" }]);
	});

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

	it("preserves a real default advisor carrying only maxNotesPerUpdate on save", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "default", maxNotesPerUpdate: 2 }] }, doc => {
			saved = structuredClone(doc);
		});

		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply without touching the row.
		await Promise.resolve();

		// The row is a real roster entry (per-advisor budget, not editable in the
		// overlay), not the synthetic seed: save must not collapse the roster to
		// empty, which would silently delete the entry from the file.
		expect(saved?.advisors).toEqual([{ name: "default", maxNotesPerUpdate: 2 }]);
	});

	it("surfaces the newly active file's warnings on scope switch, and only there", async () => {
		const warnings: string[] = [];
		let pendingLoad: Promise<WatchdogConfigDoc> | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
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
			deps,
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
