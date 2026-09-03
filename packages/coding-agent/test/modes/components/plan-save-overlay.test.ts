import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { PlanSaveOverlay, type PlanSaveOverlayResult } from "../../../src/modes/components/plan-save-overlay";
import { getThemeByName, setThemeInstance, type Theme, theme } from "../../../src/modes/theme/theme";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("PlanSaveOverlay", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	it("renders the generated filename as a dim empty-input suggestion", () => {
		const overlay = new PlanSaveOverlay("AUTO_QA_PLAN.md", () => {});
		overlay.focused = true;
		const lines = overlay.render(80);

		expect(lines.join("\n")).toContain(theme.fg("dim", "AUTO_QA_PLAN.md"));
		expect(lines.map(visibleWidth)).toEqual(Array(lines.length).fill(80));
		expect(stripAnsi(lines.join("\n"))).toContain("Enter save and quit · Esc cancel");
	});

	it("uses the latest generated suggestion when entered empty", () => {
		let result: PlanSaveOverlayResult | undefined;
		const overlay = new PlanSaveOverlay("PLAN.md", value => {
			result = value;
		});

		overlay.setSuggestedPath("AUTO_QA_PLAN.md");
		overlay.handleInput("\r");

		expect(result).toEqual({ path: "AUTO_QA_PLAN.md" });
	});

	it("uses a typed path instead of the suggestion", () => {
		let result: PlanSaveOverlayResult | undefined;
		const overlay = new PlanSaveOverlay("AUTO_QA_PLAN.md", value => {
			result = value;
		});

		overlay.pasteText("plans/review.md");
		overlay.handleInput("\r");

		expect(result).toEqual({ path: "plans/review.md" });
	});
});
