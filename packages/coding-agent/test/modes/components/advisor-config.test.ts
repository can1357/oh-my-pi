import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
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

	const clickSave = (overlay: AdvisorConfigOverlayComponent, scope: "project" | "user") => {
		const rows = overlay.render(100).map(Bun.stripANSI);
		const saveRows = rows.flatMap((row, index) => (row.slice(0, 35).includes("Save & apply") ? [index] : []));
		const row = saveRows[scope === "project" ? 0 : 1];
		if (row === undefined) throw new Error(`Missing ${scope} save row`);
		overlay.handleInput(`\x1b[<0;5;${row + 1}M`);
	};

	it("serializes project and global saves, then permits the blocked scope after completion", async () => {
		const firstSave = Promise.withResolvers<void>();
		const saves: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async scope => {
					saves.push(scope);
					if (saves.length === 1) await firstSave.promise;
				},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		await Promise.resolve();
		await Promise.resolve();
		clickSave(overlay, "project");
		clickSave(overlay, "user");
		expect(saves).toEqual(["project"]);

		firstSave.resolve();
		await Promise.resolve();
		await Promise.resolve();
		clickSave(overlay, "user");
		await Promise.resolve();
		expect(saves).toEqual(["project", "user"]);
	});

	it("preserves edits made while a save is pending", async () => {
		const finishSave = Promise.withResolvers<void>();
		const saves: WatchdogConfigDoc[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "Reviewer" }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => {
					saves.push(structuredClone(doc));
					if (saves.length === 1) await finishSave.promise;
				},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		await Promise.resolve();
		await Promise.resolve();

		clickSave(overlay, "project");
		const rows = overlay.render(100).map(Bun.stripANSI);
		const advisorRow = rows.findIndex(row => row.slice(0, 35).includes("Reviewer"));
		expect(advisorRow).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<0;5;${advisorRow + 1}M`);
		await Promise.resolve();
		overlay.handleInput("\x1b[C");
		await Promise.resolve();
		const fieldRows = overlay.render(100).map(Bun.stripANSI);
		const enabledRow = fieldRows.findIndex(row => row.includes("Enabled"));
		expect(enabledRow).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<0;60;${enabledRow + 1}M`);
		overlay.handleInput("\r");

		finishSave.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(saves).toEqual([{ advisors: [{ name: "Reviewer" }] }]);
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).toContain("unsaved");

		overlay.handleInput("\x1b[D");
		clickSave(overlay, "project");
		await Promise.resolve();
		expect(saves).toHaveLength(2);
		expect(saves[1]?.advisors[0]).toMatchObject({ name: "Reviewer" });
		expect(saves[1]?.advisors[0].enabled).toBeUndefined();
	});

	it("releases the save guard after rejection without discarding pending edits", async () => {
		const attempts: Array<{ scope: string; doc: WatchdogConfigDoc }> = [];
		const notifications: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "Reviewer" }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (scope, doc) => {
					attempts.push({ scope, doc: structuredClone(doc) });
					if (attempts.length === 1) throw new Error("disk full");
				},
				close: () => {},
				requestRender: () => {},
				notify: message => notifications.push(message),
			},
		);
		await Promise.resolve();
		await Promise.resolve();

		overlay.handleInput("\x1b[C");
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[D");
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		for (let i = 0; i < 5; i++) await Promise.resolve();

		expect(notifications).toContain("Advisor config: disk full");
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).toContain("unsaved");

		clickSave(overlay, "project");
		await Promise.resolve();
		await Promise.resolve();
		expect(attempts).toEqual([
			{ scope: "project", doc: { advisors: [{ name: "Reviewer", enabled: false }] } },
			{ scope: "project", doc: { advisors: [{ name: "Reviewer", enabled: false }] } },
		]);
		expect(notifications).toContain("Saved Project · project advisors");
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).not.toContain("unsaved");
	});

	it("still drops the untouched seeded default row on save", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply without touching the seeded row.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([]);
	});

	it.each(["left", "click"])("preserves toggled tools across %s roster navigation", async navigation => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: ["read", "bash"] },
			"project",
			{ advisors: [{ name: "Reviewer", tools: [] }] },
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
		overlay.handleInput("\x1b[C");
		let rows = overlay.render(100).map(Bun.stripANSI);
		const toolsRow = rows.findIndex(row => row.includes("Tools"));
		expect(toolsRow).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<0;60;${toolsRow + 1}M`);
		overlay.handleInput("\r");
		if (navigation === "left") overlay.handleInput("\x1b[D");
		else {
			rows = overlay.render(100).map(Bun.stripANSI);
			const advisorRow = rows.findIndex(row => row.slice(0, 35).includes("Reviewer"));
			overlay.handleInput(`\x1b[<0;5;${advisorRow + 1}M`);
		}
		overlay.handleInput("\x1b[C");
		overlay.handleInput("\x1b[D");
		rows = overlay.render(100).map(Bun.stripANSI);
		const saveRow = rows.findIndex(row => row.slice(0, 35).includes("Save & apply"));
		expect(saveRow).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<0;5;${saveRow + 1}M`);
		await Promise.resolve();
		expect(saved?.advisors[0].tools).toEqual(["read"]);
	});

	it("clears the saved scope's load warnings after normalization succeeds", async () => {
		const overlay = buildOverlay({ advisors: [], warnings: ["Malformed entry dropped"] }, () => {});
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).toContain("Malformed entry dropped");
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		await Bun.sleep(0);
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).not.toContain("Malformed entry dropped");
	});

	it("maps a visible field click below wrapped warnings to that field", async () => {
		const overlay = buildOverlay(
			{ advisors: [{ name: "Reviewer" }], warnings: ["Malformed configuration entry was dropped. ".repeat(3)] },
			() => {},
		);
		await Bun.sleep(0);
		overlay.handleInput("\r");
		const rows = overlay.render(100).map(Bun.stripANSI);
		const nameRow = rows.findIndex(row => row.includes("Name") && row.includes("Reviewer"));
		expect(nameRow).toBeGreaterThan(3);
		overlay.handleInput(`\x1b[<0;60;${nameRow + 1}M`);
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).toContain("Type a name");
	});

	it("recomputes the clicked field after restoring a scrolled editor from roster focus", async () => {
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer" }] }, () => {});
		await Bun.sleep(0);
		overlay.handleInput("\x1b[C");
		const original = overlay.render(100).map(Bun.stripANSI);
		const nameRow = original.findIndex(row => row.includes("Name") && row.includes("Reviewer"));
		overlay.handleInput("\x1b[<65;60;5M");
		overlay.handleInput("\x1b[D");
		overlay.handleInput(`\x1b[<0;60;${nameRow + 1}M`);
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).toContain("Type a name");
	});

	it("does not activate a hidden field through the editor overflow marker", async () => {
		const overlay = new AdvisorConfigOverlayComponent(
			{ terminal: { rows: 14 } } as unknown as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "Reviewer" }], warnings: Array.from({ length: 5 }, (_, i) => `Warning ${i + 1}`) },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		await Bun.sleep(0);
		overlay.handleInput("\x1b[C");
		const rows = overlay.render(100).map(Bun.stripANSI);
		const markerRow = rows.findIndex(row => row.includes("more") || row.includes("(end)"));
		expect(markerRow).toBeGreaterThan(0);

		overlay.handleInput(`\x1b[<0;60;${markerRow + 1}M`);

		expect(Bun.stripANSI(overlay.render(100).join("\n"))).not.toContain("Type a name");
	});

	it.each([
		["name", 1, false],
		["instructions", 4, false],
		["model", 2, false],
		["thinking", 2, true],
		["tools", 3, false],
	] as const)(
		"keeps the %s editor bound to its advisor when either roster is wheeled",
		async (_mode, fieldIndex, openThinking) => {
			const model = buildModel({
				id: "thinking-model",
				name: "Thinking model",
				api: "openai-completions",
				provider: "test",
				baseUrl: "https://example.com",
				reasoning: true,
				thinking: { efforts: [Effort.Low, Effort.High], mode: "effort" },
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 1024,
			});

			for (const advisorName of ["First", "Global First"] as const) {
				const overlay = new AdvisorConfigOverlayComponent(
					{} as TUI,
					{
						modelRegistry: {} as ModelRegistry,
						settings,
						scopedModels: [{ model }],
						availableToolNames: ["read", "bash"],
					},
					"project",
					{ advisors: [{ name: "First" }, { name: "Second" }] },
					{
						loadDoc: async () => ({ advisors: [{ name: "Global First" }, { name: "Global Second" }] }),
						save: async () => {},
						close: () => {},
						requestRender: () => {},
						notify: () => {},
					},
				);
				await Bun.sleep(0);

				let rows = overlay.render(100).map(Bun.stripANSI);
				const advisorRow = rows.findIndex(row => row.slice(0, 35).includes(advisorName));
				expect(advisorRow).toBeGreaterThan(0);
				overlay.handleInput(`\x1b[<0;5;${advisorRow + 1}M`);
				overlay.handleInput("\x1b[C");
				for (let i = 0; i < fieldIndex; i++) overlay.handleInput("\x1b[B");
				overlay.handleInput("\r");
				if (openThinking) overlay.handleInput("\r");

				rows = overlay.render(100).map(Bun.stripANSI);
				const editorHeader = rows[1]?.slice(38);
				overlay.handleInput(`\x1b[<65;5;${advisorRow + 1}M`);
				expect(overlay.render(100).map(Bun.stripANSI)[1]?.slice(38)).toBe(editorHeader);
			}
		},
	);

	it("still scrolls a roster when no field editor is open", async () => {
		const overlay = buildOverlay({ advisors: [{ name: "First" }, { name: "Second" }] }, () => {});
		await Bun.sleep(0);
		const rows = overlay.render(100).map(Bun.stripANSI);
		const firstRow = rows.findIndex(row => row.slice(0, 35).includes("First"));
		const before = rows[1]?.slice(38);

		overlay.handleInput(`\x1b[<65;5;${firstRow + 1}M`);

		const after = overlay.render(100).map(Bun.stripANSI)[1]?.slice(38);
		expect(after).not.toBe(before);
		expect(after).toContain("Second");
	});

	it.each(["name", "instructions"] as const)("keeps an unsubmitted %s draft when the roster is clicked", mode => {
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "First" }, { name: "Second" }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		overlay.handleInput("\x1b[C");
		const fieldIndex = mode === "name" ? 1 : 4;
		for (let i = 0; i < fieldIndex; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		if (mode === "name") overlay.handleInput(" Draft");
		else overlay.pasteText("Draft instructions");

		const rows = overlay.render(100).map(Bun.stripANSI);
		const secondRow = rows.findIndex(row => row.slice(0, 35).includes("Second"));
		expect(secondRow).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<0;5;${secondRow + 1}M`);

		const afterClick = Bun.stripANSI(overlay.render(100).join("\n"));
		expect(afterClick).toContain(mode === "name" ? "Type a name" : "Instructions — First");
		overlay.handleInput(mode === "name" ? "\r" : "\x11");
		const afterSave = Bun.stripANSI(overlay.render(100).join("\n"));
		expect(afterSave).toContain(mode === "name" ? "First Draft" : "Draft instructions");
	});

	it("scrolls the outer editor when warnings clip the nested tools editor", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{ terminal: { rows: 14 } } as unknown as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: ["read", "bash"] },
			"project",
			{
				advisors: [{ name: "Reviewer", tools: [] }],
				warnings: Array.from({ length: 8 }, (_, i) => `Warning ${i + 1}`),
			},
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
		await Bun.sleep(0);
		overlay.handleInput("\x1b[C");
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		const beforeWheel = Bun.stripANSI(overlay.render(100).join("\n"));
		expect(beforeWheel).not.toContain("[ ] read");

		overlay.handleInput("\x1b[<65;60;5M");
		const afterWheel = Bun.stripANSI(overlay.render(100).join("\n"));
		expect(afterWheel).not.toBe(beforeWheel);
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[D");
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		await Promise.resolve();

		expect(saved?.advisors[0].tools).toEqual(["read"]);
	});

	it("surfaces sanitized warnings when the background scope finishes loading", async () => {
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

	it("keeps a background scope read-only after loading fails", async () => {
		const notifications: string[] = [];
		const saves: Array<{ scope: string; doc: WatchdogConfigDoc }> = [];
		const projectDoc: WatchdogConfigDoc = { advisors: [{ name: "Reviewer" }] };
		const loadFailure = Promise.reject<WatchdogConfigDoc>(new Error("permission denied"));
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			projectDoc,
			{
				loadDoc: () => loadFailure,
				save: async (scope, doc) => {
					saves.push({ scope, doc: structuredClone(doc) });
				},
				close: () => {},
				requestRender: () => {},
				notify: message => notifications.push(message),
			},
		);

		await loadFailure.catch(() => {});
		await Promise.resolve();

		expect(notifications).toContain("Advisor config: permission denied");
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[C");
		overlay.handleInput("\r");
		expect(saves).toEqual([]);

		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[A");
		overlay.handleInput("\x1b[C");
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[D");
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		await Promise.resolve();

		expect(saves).toEqual([{ scope: "project", doc: { advisors: [{ name: "Reviewer", enabled: false }] } }]);
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
