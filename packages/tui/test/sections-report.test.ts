import { beforeAll, describe, expect, it } from "bun:test";
import { getKeybindings, setKeybindings, Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { SectionsReport } from "@oh-my-pi/pi-tui/overlays/sections-report";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

function mount() {
	let closed = 0;
	const panel = new SectionsReport(
		{
			summary: "SUMMARY_TEXT",
			sections: [
				{ id: "notes", label: "Notes", markdown: "# Notes\n\nMARKDOWN_SECTION" },
				{ id: "files", label: "Files", markdown: "unused", body: new Text("COMPONENT_SECTION", 0, 0) },
			],
		},
		{ title: "Report", closeKey: "Esc", onClose: () => closed++ },
	);
	const screen = () => Bun.stripANSI(panel.render(80).join("\n"));
	return { panel, screen, closed: () => closed };
}

describe("SectionsReport", () => {
	it("opens the chosen section in place and Esc returns to the list before it closes the report", () => {
		const { panel, screen, closed } = mount();
		expect(screen()).toContain("SUMMARY_TEXT");
		expect(screen()).toContain("Notes");
		expect(screen()).not.toContain("MARKDOWN_SECTION");

		panel.handleInput(ENTER);
		expect(screen()).toContain("MARKDOWN_SECTION");
		expect(screen()).not.toContain("SUMMARY_TEXT");

		panel.handleInput(ESCAPE);
		expect(screen()).toContain("SUMMARY_TEXT");
		expect(closed()).toBe(0);

		panel.handleInput(ESCAPE);
		expect(closed()).toBe(1);
	});

	it("opens and leaves a section with the configured selector keys", () => {
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+g" }));
		try {
			const { panel, screen, closed } = mount();
			panel.handleInput("\x19");
			expect(screen()).toContain("MARKDOWN_SECTION");
			panel.handleInput("\x07");
			expect(screen()).toContain("SUMMARY_TEXT");
			expect(closed()).toBe(0);
		} finally {
			setKeybindings(previous);
		}
	});

	it("draws a section's component instead of its markdown", () => {
		const { panel, screen } = mount();
		panel.handleInput(DOWN);
		panel.handleInput(ENTER);
		expect(screen()).toContain("COMPONENT_SECTION");
		expect(screen()).not.toContain("unused");
	});
});
