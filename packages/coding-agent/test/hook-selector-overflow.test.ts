import { beforeAll, describe, expect, it } from "bun:test";
import { HookSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});
describe("HookSelectorComponent", () => {
	it("keeps outlined options within render width", () => {
		const options = [
			"aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;b",
			"bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;a",
			"a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b",
		];
		const component = new HookSelectorComponent(
			"Which pattern do you prefer?",
			options,
			() => {},
			() => {},
			{ outline: true, initialIndex: 0 },
		);

		const width = 80;
		const lines = component.render(width);
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});

	it("renders a multiline title in the border and body without dropping detail", () => {
		const component = new HookSelectorComponent(
			"Delete session?\nsession-2026-08-20",
			["Delete", "Cancel"],
			() => {},
			() => {},
		);

		const lines = component.render(80).map(line => Bun.stripANSI(line));
		expect(lines[0]).toContain("Delete session?");
		expect(lines.some(line => line.includes("session-2026-08-20"))).toBe(true);
	});

	it("wraps outlined option text without omitting the tail", () => {
		const options = [
			"Option A: Move to OMP-native only by migrating reusable shared AI instructions into .omp/AGENTS.md, .omp/rules, .omp/skills, and .omp/agents while deliberately not creating a root .github directory.",
			"Option B: Keep dual support by migrating canonical instructions into .omp while also maintaining a root .github/copilot-instructions.md compatibility bridge for editors that do not understand OMP resources yet.",
		];
		const component = new HookSelectorComponent(
			"Which migration stance should be used?",
			options,
			() => {},
			() => {},
			{ outline: true, initialIndex: 0 },
		);

		const width = 72;
		const lines = component.render(width);
		const plain = lines.map(line => Bun.stripANSI(line)).join("\n");
		const normalizedPlain = plain.replace(/[\u2500-\u257f]/g, " ").replace(/\s+/g, " ");
		expect(normalizedPlain).toContain("not creating a root .github directory");
		expect(normalizedPlain).toContain("do not understand OMP resources yet");
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});

	it("renders option descriptions as separate wrapped rows", () => {
		const options = [
			{
				label: "Use existing local credentials",
				description:
					"Authenticate via the provider keys and OAuth state already configured under ~/.omp without opening a new browser-based setup flow.",
			},
			{
				label: "Set up Oh My Pi in terminal",
				description:
					"Launch the local terminal UI to add provider keys, select models, and keep the current editor session waiting for the configured credentials.",
			},
		];
		const component = new HookSelectorComponent(
			"How should authentication continue?",
			options,
			() => {},
			() => {},
			{ outline: true, initialIndex: 0 },
		);

		const width = 76;
		const lines = component.render(width);
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const normalizedPlain = plainLines
			.join("\n")
			.replace(/[\u2500-\u257f]/g, " ")
			.replace(/\s+/g, " ");
		const labelLineIndex = plainLines.findIndex(line => line.includes("Use existing local credentials"));
		const descriptionLineIndex = plainLines.findIndex(line => line.includes("Authenticate via the provider keys"));
		expect(labelLineIndex).toBeGreaterThanOrEqual(0);
		expect(descriptionLineIndex).toBeGreaterThan(labelLineIndex);
		expect(normalizedPlain).toContain("without opening a new browser-based setup flow");
		expect(normalizedPlain).toContain("keep the current editor session waiting for the configured credentials");
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});

	it("collapses to labels with only the highlighted description when descriptions overflow", () => {
		const options = [
			{ label: "Path A", description: "Reuse existing credentials." },
			{ label: "Path B", description: "Authorize a provider in the browser." },
			{ label: "Path C", description: "Edit provider keys manually." },
			{ label: "Path D", description: "Continue with offline-only tools." },
		];
		const component = new HookSelectorComponent(
			"Which setup path should be used?",
			options,
			() => {},
			() => {},
			{ outline: true, initialIndex: 0, maxVisible: 6 },
		);

		const plain = component
			.render(76)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		// Every option label stays on screen so the user can see the whole menu...
		expect(plain).toContain("Path A");
		expect(plain).toContain("Path B");
		expect(plain).toContain("Path C");
		expect(plain).toContain("Path D");
		// ...but only the highlighted option expands its description.
		expect(plain).toContain("Reuse existing credentials.");
		expect(plain).not.toContain("Authorize a provider in the browser.");
		expect(plain).not.toContain("Edit provider keys manually.");
		expect(plain).toContain("(1/4)");

		// The detail pane follows the cursor: moving down expands Path B and
		// collapses Path A's description.
		component.handleInput("\x1b[B");
		const afterDown = component
			.render(76)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(afterDown).toContain("Path A");
		expect(afterDown).toContain("Path D");
		expect(afterDown).toContain("Authorize a provider in the browser.");
		expect(afterDown).not.toContain("Reuse existing credentials.");
		expect(afterDown).toContain("(2/4)");
	});

	it("counts wrapped outlined rows toward the visible row cap", () => {
		const options = [
			"Option A: Use the existing terminal session and preserve the current credentials while the setup prompt remains open for the editor.",
			"Option B: Open a browser authorization flow and wait for the provider callback before returning to the editor.",
			"Option C: Edit the local provider configuration file manually and retry the current request afterward.",
			"Option D: Continue without provider access and keep only offline tools enabled for the session.",
		];
		const component = new HookSelectorComponent(
			"Which setup path should be used?",
			options,
			() => {},
			() => {},
			{ outline: true, initialIndex: 0, maxVisible: 3 },
		);

		const plainLines = component.render(50).map(line => Bun.stripANSI(line));
		const plain = plainLines.join("\n");
		expect(plain).toContain("Option A");
		expect(plain).not.toContain("Option B");
		expect(plain).toContain("(1/4)");
		for (const line of plainLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(50);
		}
	});

	it("filters options by description text", () => {
		const component = new HookSelectorComponent(
			"Which setup path should be used?",
			[
				{ label: "Path A", description: "Reuse the credentials already available in the environment." },
				{ label: "Path B", description: "Launch a browser flow to authorize a new provider account." },
				{ label: "Path C", description: "Open the local settings file and edit provider keys manually." },
				{ label: "Path D", description: "Skip provider setup and continue with offline-only tools." },
			],
			() => {},
			() => {},
			{ outline: true, maxVisible: 3 },
		);

		for (const key of "browser") {
			component.handleInput(key);
		}

		const plain = component
			.render(76)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(plain).toContain("Path B");
		expect(plain).toContain("Launch a browser flow");
		expect(plain).not.toContain("Path A");
	});

	it("skips disabled options during keyboard navigation", () => {
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			"Pick one",
			["First", "Disabled", "Third"],
			option => {
				selected = option;
			},
			() => {},
			{ disabledIndices: [1] },
		);

		component.handleInput("j");
		component.handleInput("\n");

		expect(selected).toBe("Third");
	});

	it("does not select disabled options", () => {
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			"Pick one",
			["Disabled"],
			option => {
				selected = option;
			},
			() => {},
			{ disabledIndices: [0] },
		);

		component.handleInput("\n");

		expect(selected).toBeUndefined();
	});

	it("selects the matching numbered option after an unnumbered row", () => {
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			"Pick one",
			["Detected item", "1. First", "2. Second", "3. Third"],
			option => {
				selected = option;
			},
			() => {},
		);

		component.handleInput("3");

		expect(selected).toBe("3. Third");
	});

	it("ignores a digit that targets a disabled option", () => {
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			"Pick one",
			["1. First", "2. Disabled", "3. Third"],
			option => {
				selected = option;
			},
			() => {},
			{ disabledIndices: [1] },
		);

		component.handleInput("2");

		expect(selected).toBeUndefined();
	});

	it("ignores a digit without a matching numbered option", () => {
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			"Pick one",
			["1. First", "2. Second"],
			option => {
				selected = option;
			},
			() => {},
		);

		component.handleInput("9");

		expect(selected).toBeUndefined();
	});

	it("does not turn an unnumbered menu into implicit numeric shortcuts", () => {
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			"Pick one",
			["First", "Second", "Third"],
			option => {
				selected = option;
			},
			() => {},
		);

		component.handleInput("3");

		expect(selected).toBeUndefined();
	});

	it("moves the cursor without confirming on checkbox menus", () => {
		let selected: string | undefined;
		const component = new HookSelectorComponent(
			"Pick many",
			["1. First", "2. Second", "3. Third"],
			option => {
				selected = option;
			},
			() => {},
			{ selectionMarker: "checkbox" },
		);

		component.handleInput("2");
		expect(selected).toBeUndefined();

		component.handleInput("\n");
		expect(selected).toBe("2. Second");
	});

	it("treats digits as search text once the list overflows", () => {
		let selected: string | undefined;
		const options = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);
		const component = new HookSelectorComponent(
			"Pick one",
			options,
			option => {
				selected = option;
			},
			() => {},
			{ maxVisible: 5 },
		);

		component.handleInput("1");

		expect(selected).toBeUndefined();
		expect(component.render(80).join("\n")).toContain("Search: 1");
	});

	it("renders disabled options dimmed", () => {
		const component = new HookSelectorComponent(
			"Pick one",
			["First", "Disabled"],
			() => {},
			() => {},
			{ disabledIndices: [1] },
		);

		expect(component.render(80).join("\n")).toContain(theme.fg("dim", "Disabled"));
	});

	it("renders radio markers instead of a cursor arrow for single-choice markable rows", () => {
		const component = new HookSelectorComponent(
			"Pick one",
			["Apple", "Banana", "Other (type your own)"],
			() => {},
			() => {},
			{ selectionMarker: "radio", markableCount: 2, initialIndex: 0 },
		);

		const lines = Bun.stripANSI(component.render(80).join("\n")).split("\n");
		const apple = lines.find(line => line.includes("Apple"));
		const banana = lines.find(line => line.includes("Banana"));
		expect(apple).toBeDefined();
		expect(banana).toBeDefined();
		// Cursor row shows the filled radio; the legacy cursor arrow is gone.
		expect(apple).toContain(theme.radio.selected);
		expect(apple).not.toContain(theme.nav.cursor);
		// Non-cursor markable row shows the empty radio.
		expect(banana).toContain(theme.radio.unselected);
	});

	it("keeps the cursor arrow on control rows beyond markableCount", () => {
		const component = new HookSelectorComponent(
			"Pick one",
			["Apple", "Banana", "Other (type your own)"],
			() => {},
			() => {},
			{ selectionMarker: "radio", markableCount: 2, initialIndex: 2 },
		);

		const lines = Bun.stripANSI(component.render(80).join("\n")).split("\n");
		const other = lines.find(line => line.includes("Other"));
		expect(other).toBeDefined();
		// The trailing action keeps the classic cursor and gets no radio marker.
		expect(other).toContain(theme.nav.cursor);
		expect(other).not.toContain(theme.radio.selected);
	});

	it("renders checkbox markers reflecting checked state and exempts control rows", () => {
		const component = new HookSelectorComponent(
			"Pick many",
			["Apple", "Banana", "Done selecting", "Other (type your own)"],
			() => {},
			() => {},
			{ selectionMarker: "checkbox", markableCount: 2, checkedIndices: [0], initialIndex: 1 },
		);

		const lines = Bun.stripANSI(component.render(80).join("\n")).split("\n");
		const apple = lines.find(line => line.includes("Apple"));
		const banana = lines.find(line => line.includes("Banana"));
		const done = lines.find(line => line.includes("Done selecting"));
		expect(apple).toBeDefined();
		expect(banana).toBeDefined();
		expect(done).toBeDefined();
		expect(apple).toContain(theme.checkbox.checked);
		expect(banana).toContain(theme.checkbox.unchecked);
		// Control rows beyond markableCount carry no checkbox marker.
		expect(done).not.toContain(theme.checkbox.checked);
		expect(done).not.toContain(theme.checkbox.unchecked);
	});

	it("paints a selectedBg focus band across the highlighted checkbox row (outlined)", () => {
		// Bug #4157: multi-select checkbox picker used only an accent fg to signal
		// focus, which vanished on themes where accent ≈ text. The focused row
		// must now carry the selectedBg band regardless of accent/text contrast.
		const component = new HookSelectorComponent(
			"Pick many",
			["Apple", "Banana", "Cherry", "Done selecting", "Other (type your own)"],
			() => {},
			() => {},
			{
				outline: true,
				selectionMarker: "checkbox",
				markableCount: 3,
				checkedIndices: [],
				initialIndex: 0,
			},
		);
		const bgProbe = theme.bg("selectedBg", "|");
		const openBg = bgProbe.slice(0, bgProbe.indexOf("|"));

		const rendered = component.render(80);
		const appleRow = rendered.find(line => Bun.stripANSI(line).includes("Apple"));
		const bananaRow = rendered.find(line => Bun.stripANSI(line).includes("Banana"));
		const otherRow = rendered.find(line => Bun.stripANSI(line).includes("Other"));
		expect(appleRow).toBeDefined();
		expect(bananaRow).toBeDefined();
		expect(otherRow).toBeDefined();
		expect(appleRow).toContain(openBg);
		expect(bananaRow).not.toContain(openBg);
		expect(otherRow).not.toContain(openBg);
	});

	it("moves the selectedBg band with the cursor and paints control rows too", () => {
		const build = (initialIndex: number) =>
			new HookSelectorComponent(
				"Pick many",
				["Apple", "Banana", "Cherry", "Done selecting", "Other (type your own)"],
				() => {},
				() => {},
				{
					outline: true,
					selectionMarker: "checkbox",
					markableCount: 3,
					checkedIndices: [],
					initialIndex,
				},
			);
		const bgProbe = theme.bg("selectedBg", "|");
		const openBg = bgProbe.slice(0, bgProbe.indexOf("|"));
		const bandedLabel = (component: HookSelectorComponent) => {
			const rendered = component.render(80);
			const banded = rendered.filter(line => line.includes(openBg));
			const labels = ["Apple", "Banana", "Cherry", "Done selecting", "Other"];
			return labels.find(label => banded.some(line => Bun.stripANSI(line).includes(label)));
		};
		expect(bandedLabel(build(1))).toBe("Banana");
		// Control rows past markableCount ("Other") still receive the focus band
		// even though they carry no checkbox marker.
		expect(bandedLabel(build(4))).toBe("Other");
	});

	it("highlights the whole selected block including wrapped description rows", () => {
		const component = new HookSelectorComponent(
			"Choose",
			[
				{
					label: "Alpha",
					description:
						"Detailed first-choice explanation long enough to wrap across multiple rendered rows once outlined inside a tight width.",
				},
				{ label: "Beta", description: "Second." },
			],
			() => {},
			() => {},
			{ outline: true, initialIndex: 0 },
		);
		const bgProbe = theme.bg("selectedBg", "|");
		const openBg = bgProbe.slice(0, bgProbe.indexOf("|"));

		const rendered = component.render(60);
		const bandedRows = rendered.filter(line => line.includes(openBg));
		// Label row plus at least one wrapped description continuation, all under
		// the Alpha option; Beta must stay unbanded.
		expect(bandedRows.length).toBeGreaterThanOrEqual(2);
		const bandedContainsBeta = bandedRows.some(line => Bun.stripANSI(line).includes("Beta"));
		expect(bandedContainsBeta).toBe(false);
	});

	it("paints the selectedBg band on the non-outlined plain list too", () => {
		const component = new HookSelectorComponent(
			"Pick",
			["Apple", "Banana", "Cherry"],
			() => {},
			() => {},
			{ initialIndex: 1 },
		);
		const bgProbe = theme.bg("selectedBg", "|");
		const openBg = bgProbe.slice(0, bgProbe.indexOf("|"));

		const rendered = component.render(80);
		const appleRow = rendered.find(line => Bun.stripANSI(line).includes("Apple"));
		const bananaRow = rendered.find(line => Bun.stripANSI(line).includes("Banana"));
		const cherryRow = rendered.find(line => Bun.stripANSI(line).includes("Cherry"));
		expect(appleRow).toBeDefined();
		expect(bananaRow).toBeDefined();
		expect(cherryRow).toBeDefined();
		expect(bananaRow).toContain(openBg);
		expect(appleRow).not.toContain(openBg);
		expect(cherryRow).not.toContain(openBg);
	});
});
