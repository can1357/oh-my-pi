import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { toolText } from "../helpers/tool-text";
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

describe("read tool card framing", () => {
	it("renders framed read results inside the standard tool container", () => {
		const lines = toolText({
			name: "read",
			args: { path: "src/example.ts" },
			result: {
				content: [{ type: "text", text: "export const x = 1;" }],
				details: {
					displayContent: { text: "export const x = 1;", startLine: 1 },
					contentType: "text/plain",
				},
			},
			width: 80,
		}).split("\n");
		const topBorderIndex = lines.findIndex(line => line.includes("╭") && line.includes("Read"));
		const bottomBorderIndex = lines.findIndex((line, index) => index > topBorderIndex && line.includes("╰"));

		expect(topBorderIndex).toBeGreaterThanOrEqual(0);
		expect(lines[topBorderIndex + 1]).toContain("export const x = 1;");
		expect(bottomBorderIndex).toBeGreaterThan(topBorderIndex);
	});
});
