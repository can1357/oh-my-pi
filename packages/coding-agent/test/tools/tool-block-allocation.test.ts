import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createRoot, resolveChildren } from "@oh-my-pi/pi-tui";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { ensureTheme } from "../../src/ui/theme/service";
import { ToolBlock } from "../../src/ui/transcript/tool-block";
import { toolCall } from "../helpers/tool-text";

const restoreTheme = currentTheme();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	ensureTheme();
});

afterAll(() => {
	setCurrentTheme(restoreTheme);
	resetSettingsForTest();
});

/** A task card painted at a fixed height (the transcript's viewport allocation), ANSI stripped. */
function allocatedRows(height: number | undefined): string[] {
	const call = toolCall({
		name: "task",
		args: {
			context: Array.from({ length: 20 }, (_, i) => `- Shared rule ${i}`).join("\n"),
			tasks: Array.from({ length: 3 }, (_, i) => ({ name: `Agent${i}`, task: `Task number ${i}` })),
		},
	});
	return createRoot(dispose => {
		try {
			return resolveChildren(() => ToolBlock({ call }))().flatMap(node =>
				renderBlock(node, 80, { theme: currentTheme(), height }).rows.map(row => Bun.stripANSI(row)),
			);
		} finally {
			dispose();
		}
	});
}

describe("tool block viewport allocation", () => {
	it("fills a tall allocation with the card's head and newest rows instead of a 2-row stub", () => {
		const full = allocatedRows(undefined).filter(row => row.trim().length > 0);
		expect(full.length).toBeGreaterThan(10);

		const rows = allocatedRows(8);
		expect(rows).toHaveLength(8);
		expect(rows[0]).toBe(full[0]);
		expect(rows.slice(1)).toEqual(full.slice(-7));
		expect(rows.at(-1)).toContain("╰");
	});

	it("keeps the 2-row frame edge when only two rows are allocated", () => {
		const rows = allocatedRows(2);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("╭─");
		expect(rows[1]?.trim()).toBe("╰");
	});
});
