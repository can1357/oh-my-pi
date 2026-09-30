import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import type { TUI } from "../src/index";
import type { DescribeContext, NativeUiEvent } from "../src/native/node";
import {
	AdvisorConfigOverlayComponent,
	type AdvisorConfigDeps,
	type WatchdogConfigDoc,
} from "../src/overlays/advisor-config";
import { getThemeByName, setSymbolPreset, setThemeInstance } from "../src/theme";

const deps: AdvisorConfigDeps = {
	getAvailableModels: () => [],
	browserSource: {
		revision: 0,
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

/**
 * Open a detail field by its rendered label. Row offsets shift whenever the
 * field list grows (review cadence added three rows), so tests address fields
 * the way a user does.
 */
function openField(overlay: AdvisorConfigOverlayComponent, label: string): void {
	const rows = overlay.render(100).map(Bun.stripANSI);
	const row = rows.findIndex(line =>
		line
			.slice(38)
			.replace(/^\s*[^\s\w]?\s*/, "")
			.startsWith(label),
	);
	expect(row).toBeGreaterThan(0);
	overlay.handleInput(`\x1b[<0;60;${row + 1}M`);
}

/** Activate a roster row (advisor, "Save & apply", …) by its rendered label. */
function clickRosterRow(overlay: AdvisorConfigOverlayComponent, label: string): void {
	const rows = overlay.render(100).map(Bun.stripANSI);
	const row = rows.findIndex(line => line.slice(0, 36).includes(label));
	expect(row).toBeGreaterThan(0);
	overlay.handleInput(`\x1b[<0;5;${row + 1}M`);
}

describe("advisor config editor", () => {
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
			deps,
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
			deps,
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
			deps,
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
		const overlay = buildOverlay({ advisors: [{ name: "default" }] }, doc => {
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
			{ ...deps, availableToolNames: ["read", "bash"] },
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
			deps,
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
						...deps,
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
			deps,
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
		openField(overlay, mode === "name" ? "Name" : "Instructions");
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
			{ ...deps, availableToolNames: ["read", "bash"] },
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
		// Warnings clip the field list here, so the Tools row is addressed by
		// keyboard: Enabled, Name, Model, Tools.
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		const beforeWheel = Bun.stripANSI(overlay.render(100).join("\n"));
		expect(beforeWheel).not.toContain("[ ] read");

		overlay.handleInput("\x1b[<65;60;5M");
		const afterWheel = Bun.stripANSI(overlay.render(100).join("\n"));
		expect(afterWheel).not.toBe(beforeWheel);
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[D");
		clickRosterRow(overlay, "Save & apply");
		await Promise.resolve();

		expect(saved?.advisors[0].tools).toEqual(["read"]);
	});

	it("surfaces asynchronously loaded global warnings in the global pane", async () => {
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

		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
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
		const overlay = new AdvisorConfigOverlayComponent({} as TUI, deps, "project", projectDoc, {
			loadDoc: () => loadFailure,
			save: async (scope, doc) => {
				saves.push({ scope, doc: structuredClone(doc) });
			},
			close: () => {},
			requestRender: () => {},
			notify: message => notifications.push(message),
		});

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

describe("advisor config native page", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	const nativeDeps: AdvisorConfigDeps = { ...deps, availableToolNames: ["read", "grep", "glob", "bash"] };
	const cx: DescribeContext = {
		cols: 120,
		reduceMotion: false,
		dark: true,
		supports: () => true,
		feature: () => true,
	};

	const change = (item: string, value: Extract<NativeUiEvent, { type: "change" }>["value"]): NativeUiEvent => ({
		type: "change",
		key: "",
		item,
		value,
	});
	const action = (act: string, value?: string): NativeUiEvent => ({ type: "action", key: "", act, value, mods: [] });

	interface Harness {
		overlay: AdvisorConfigOverlayComponent;
		saves: { scope: string; doc: WatchdogConfigDoc }[];
		notices: string[];
	}

	async function open(
		userDoc: WatchdogConfigDoc = { advisors: [] },
		pendingLoad?: Promise<WatchdogConfigDoc>,
	): Promise<Harness> {
		const saves: Harness["saves"] = [];
		const notices: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			nativeDeps,
			"project",
			{ advisors: [{ name: "Reviewer", model: "anthropic/claude" }] },
			{
				loadDoc: async () => pendingLoad ?? structuredClone(userDoc),
				save: async (scope, doc) => {
					saves.push({ scope, doc: structuredClone(doc) });
				},
				close: () => {},
				requestRender: () => {},
				notify: message => notices.push(message),
			},
		);
		for (let i = 0; i < 4; i++) await Promise.resolve();
		return { overlay, saves, notices };
	}

	function props(overlay: AdvisorConfigOverlayComponent): TspPrefsProps {
		const tree = overlay.describe(cx);
		if (!tree || tree.k !== "prefs" || !tree.p) throw new Error("expected a prefs page");
		return tree.p;
	}

	function row(page: TspPrefsProps, id: string): TspPrefsRow {
		for (const section of page.sections) {
			const found = section.rows.find(candidate => candidate.id === id);
			if (found) return found;
		}
		throw new Error(`missing row ${id}`);
	}

	it("docks as a side sheet only where the terminal draws prefs with aside", async () => {
		const { overlay } = await open();
		expect(overlay.nativeSheet(cx)).toBe(true);
		expect(overlay.nativeSheet({ ...cx, feature: name => name !== "aside" })).toBe(false);
		expect(overlay.nativeSheet({ ...cx, supports: kind => kind !== "prefs" })).toBe(false);
	});

	it("keeps the three-pane frame where the terminal does not draw prefs", async () => {
		const { overlay } = await open();
		expect(overlay.describe({ ...cx, supports: kind => kind !== "prefs" })).toBeNull();
	});

	it("describes a page per advisor in both scopes with the focused advisor's typed rows", async () => {
		const { overlay } = await open({ advisors: [{ name: "Global watcher" }], instructions: "Be brief." });
		const page = props(overlay);

		expect(page.pages.map(entry => [entry.id, entry.group])).toEqual([
			["project:advisor:0", "Project · project"],
			["project:shared", "Project · project"],
			["user:advisor:0", "Global"],
			["user:shared", "Global"],
		]);
		expect(page.page).toBe("project:advisor:0");
		expect(row(page, "toggleEnabled").control).toEqual({ k: "switch", on: true });
		expect(row(page, "tools").control).toMatchObject({ k: "multi", values: ["read", "grep", "glob"] });
		expect(row(page, "model").control).toEqual({ k: "action", label: "anthropic/claude", act: "edit" });
		expect(row(page, "resetModel")).toBeDefined();
	});

	it("marks a scope's pages disabled while its file is still loading", async () => {
		const load = Promise.withResolvers<WatchdogConfigDoc>();
		const { overlay } = await open({ advisors: [] }, load.promise);
		expect(props(overlay).pages.find(entry => entry.id === "user:shared")?.disabled).toBe("Loading…");
		overlay.handleNativeEvent(action("page", "user:shared"));
		expect(props(overlay).page).toBe("project:advisor:0");

		load.resolve({ advisors: [] });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		expect(props(overlay).pages.find(entry => entry.id === "user:shared")?.disabled).toBeUndefined();
	});

	it("writes field changes through the classic rules and saves them to the right file", async () => {
		const { overlay, saves } = await open();
		overlay.handleNativeEvent(change("tools", ["read", "bash"]));
		overlay.handleNativeEvent(change("toggleEnabled", false));
		overlay.handleNativeEvent(change("name", "  Renamed  "));

		expect(props(overlay).title).toBe("Advisors · unsaved");
		overlay.handleNativeEvent(action("save"));
		await Promise.resolve();
		await Promise.resolve();

		expect(saves).toHaveLength(1);
		expect(saves[0]?.scope).toBe("project");
		const saved = saves[0]?.doc.advisors[0];
		expect(saved).toMatchObject({
			name: "Renamed",
			enabled: false,
			model: "anthropic/claude",
		});
		expect([...(saved?.tools ?? [])].sort()).toEqual(["bash", "read"]);
	});

	it("keeps the classic frame in step with native edits", async () => {
		const { overlay } = await open();
		overlay.handleNativeEvent(change("name", "Renamed"));
		expect(overlay.render(100).map(Bun.stripANSI).join("\n")).toContain("Renamed");
	});

	it("opens the other scope's advisor and shared instructions from a page action", async () => {
		const { overlay } = await open({ advisors: [{ name: "Global watcher" }], instructions: "Be brief." });
		overlay.handleNativeEvent(action("page", "user:advisor:0"));
		expect(props(overlay).page).toBe("user:advisor:0");
		expect(props(overlay).sections.some(section => section.title === "Global watcher")).toBe(true);
		expect(props(overlay).sections.find(section => section.id === "file")?.title).toBe("WATCHDOG.yml · Global");

		overlay.handleNativeEvent(action("page", "user:shared"));
		expect(props(overlay).page).toBe("user:shared");
		expect(row(props(overlay), "instructions").hint).toBe("Be brief.");
	});

	it("shows a classic editor over the page and closes it like Esc", async () => {
		const { overlay } = await open();
		expect(overlay.describe(cx)?.c ?? []).toHaveLength(0);
		overlay.handleNativeEvent(action("edit", "instructions"));
		expect(overlay.describe(cx)?.c).toHaveLength(1);
		overlay.handleNativeEvent(action("close", "editor"));
		expect(overlay.describe(cx)?.c ?? []).toHaveLength(0);
	});

	it("deletes the advisor from its page and marks the file unsaved", async () => {
		const { overlay } = await open();
		overlay.handleNativeEvent(action("delete", "delete"));
		const page = props(overlay);
		expect(page.pages.some(entry => entry.id === "project:advisor:0")).toBe(false);
		expect(page.title).toBe("Advisors · unsaved");
	});

	// The page key names the focused roster's selected row, so it doubles as a probe of where ↑/↓ landed:
	// `<scope>:advisor:0` is a roster's first row, `<scope>:shared` any of its trailing rows (add/shared/save).
	it("walks the project and global rosters as one ring, wrapping across at both ends", async () => {
		const { overlay } = await open({ advisors: [{ name: "Global watcher" }] });
		expect(props(overlay).page).toBe("project:advisor:0");

		overlay.handleInput("\x1b[A"); // above the project roster's first row → the global roster's last row
		expect(props(overlay).page).toBe("user:shared");

		overlay.handleInput("\x1b[B"); // below the global roster's last row → the project roster's first row
		expect(props(overlay).page).toBe("project:advisor:0");
	});

	it("still crosses between the rosters in the middle of the ring", async () => {
		const { overlay } = await open({ advisors: [{ name: "Global watcher" }] });
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B"); // add → shared → save
		expect(props(overlay).page).toBe("project:shared");

		overlay.handleInput("\x1b[B"); // past the project roster's end → the global roster's first row
		expect(props(overlay).page).toBe("user:advisor:0");

		overlay.handleInput("\x1b[A"); // above the global roster's first row → back where the project cursor was
		expect(props(overlay).page).toBe("project:shared");
	});

	it("does not wrap into a global roster that has not loaded yet", async () => {
		const load = Promise.withResolvers<WatchdogConfigDoc>();
		const { overlay } = await open({ advisors: [] }, load.promise);
		overlay.handleInput("\x1b[A");
		expect(props(overlay).page.startsWith("project:")).toBe(true);
	});
});

describe("advisor tools editor keyboard navigation", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	const tools = Array.from({ length: 30 }, (_, i) => `tool${String(i).padStart(2, "0")}`);

	// A 14-row terminal leaves a 6-row body, so the tools list (2 header rows + 31 rows) overflows the right pane.
	function openToolsEditor(saves: WatchdogConfigDoc[]): AdvisorConfigOverlayComponent {
		const overlay = new AdvisorConfigOverlayComponent(
			{ terminal: { rows: 14 } } as TUI,
			{ ...deps, availableToolNames: tools },
			"project",
			{ advisors: [{ name: "Reviewer", tools: [] }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => {
					saves.push(structuredClone(doc));
				},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		overlay.handleInput("\r"); // Advisor detail.
		openField(overlay, "Tools");
		return overlay;
	}

	const paneRows = (overlay: AdvisorConfigOverlayComponent): string[] =>
		overlay.render(100).map(row => Bun.stripANSI(row).slice(38));

	it("keeps the selected tool inside the visible pane, above the overflow marker", () => {
		const overlay = openToolsEditor([]);
		expect(paneRows(overlay).some(row => row.includes("↓"))).toBe(true); // The list really overflows.

		for (let i = 1; i <= 20; i++) {
			overlay.handleInput("\x1b[B");
			const rows = paneRows(overlay);
			const shown = rows.findIndex(row => row.includes(`[ ] ${tools[i]}`));
			expect(shown).toBeGreaterThanOrEqual(0);
			// The marker sits on the last pane row, never on top of the selection.
			const marker = rows.findIndex(row => /↓ \d+ more|\(end\)/.test(row));
			expect(marker).toBeGreaterThan(shown);
		}
	});

	it("keeps the wrapped-to row visible when keys arrive before the first frame of the editor", () => {
		const overlay = openToolsEditor([]);
		// openToolsEditor drew the field list only; the tools editor has not been drawn yet.
		overlay.handleInput("\x1b[A"); // Wraps from the first row to "Done".
		const rows = paneRows(overlay);
		expect(rows.some(row => row.includes("Done"))).toBe(true);
	});

	it("toggles the tool that is shown, and keeps it in view after the toggle", async () => {
		const saves: WatchdogConfigDoc[] = [];
		const overlay = openToolsEditor(saves);
		for (let i = 1; i <= 20; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Toggle the selected tool.
		expect(paneRows(overlay).some(row => row.includes(`[x] ${tools[20]}`))).toBe(true);

		overlay.handleInput("\x1b[D"); // Apply and return to the fields.
		clickRosterRow(overlay, "Save & apply");
		await Promise.resolve();
		await Promise.resolve();
		expect(saves[0]?.advisors[0]?.tools).toEqual([tools[20]]);
	});

	it("brings the last row into view above the end marker when wrapping from the top", () => {
		const overlay = openToolsEditor([]);
		overlay.handleInput("\x1b[A"); // Wraps from the first row to "Done".
		const rows = paneRows(overlay);
		const done = rows.findIndex(row => row.includes("Done"));
		expect(done).toBeGreaterThanOrEqual(0);
		expect(rows.findIndex(row => row.includes("(end)"))).toBeGreaterThan(done);
	});
});

describe("advisor config display text", () => {
	const callbacks = {
		loadDoc: async () => ({ advisors: [] }),
		save: async () => {},
		close: () => {},
		requestRender: () => {},
		notify: () => {},
	};

	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	afterAll(async () => {
		await setSymbolPreset("unicode");
	});

	it("draws no non-ASCII footer hint under the ascii symbol preset", async () => {
		await setSymbolPreset("ascii");
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Reviewer" }] },
			callbacks,
		);
		const footers: string[] = [];
		footers.push(Bun.stripANSI(overlay.render(100).at(-2) ?? ""));
		overlay.handleInput("\r"); // Advisor detail: a different footer.
		footers.push(Bun.stripANSI(overlay.render(100).at(-2) ?? ""));

		for (const footer of footers) {
			expect(footer.trim().length).toBeGreaterThan(0);
			expect(footer).not.toMatch(/[^\x20-\x7e]/);
		}
	});

	it("renders an advisor name containing tabs and escape sequences as clean single-line text", async () => {
		await setSymbolPreset("unicode");
		const hostile = "Sec\turity\x1b[31m\nred";
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: hostile }] },
			callbacks,
		);
		const frame = overlay.render(100).join("\n");

		expect(frame).not.toContain("\x1b[31m");
		expect(frame).not.toContain("\t");
		expect(Bun.stripANSI(frame)).toContain("Sec urity red");
	});

	it("renders the instructions editor title for a hostile advisor name on one clean line", async () => {
		await setSymbolPreset("unicode");
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Sec\turity\x1b[31m\nred" }] },
			callbacks,
		);
		overlay.handleInput("\r"); // The advisor's fields.
		openField(overlay, "Instructions");
		const frame = overlay.render(100).join("\n");

		expect(frame).not.toContain("\x1b[31m");
		const titleLine = Bun.stripANSI(frame)
			.split("\n")
			.find(line => line.includes("Instructions"));
		expect(titleLine).toContain("Sec urity red");
	});
});

describe("advisor config keyboard navigation", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	function mount(closed: { n: number }): AdvisorConfigOverlayComponent {
		return new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Alpha" }, { name: "Beta" }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {},
				close: () => {
					closed.n++;
				},
				requestRender: () => {},
				notify: () => {},
			},
		);
	}
	it("keeps the overlay open when Esc is pressed on an advisor's field list", () => {
		const closed = { n: 0 };
		const overlay = mount(closed);
		overlay.handleInput("\r");
		overlay.handleInput("\x1b");

		expect(closed.n).toBe(0);
		overlay.handleInput("\x1b");
		expect(closed.n).toBe(1);
	});

	it("shows the newly selected advisor's fields instead of a thinking picker bound to the previous advisor", () => {
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
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ ...deps, scopedModels: [{ model }] },
			"project",
			{ advisors: [{ name: "Alpha" }, { name: "Beta" }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		overlay.handleInput("\r"); // Alpha's fields.
		openField(overlay, "Model"); // The model picker.
		overlay.handleInput("\r"); // Choose the model with thinking levels: the thinking picker opens.
		const pane = () =>
			overlay
				.render(110)
				.map(line => Bun.stripANSI(line).slice(38))
				.join("\n");
		expect(pane()).toContain("low");

		overlay.handleInput("\x1b[D"); // Back to the rosters; the thinking picker is still mounted.
		overlay.handleInput("\x1b[B"); // Select Beta.

		expect(pane()).toContain("Beta");
		expect(pane()).not.toContain("low");
	});
});
