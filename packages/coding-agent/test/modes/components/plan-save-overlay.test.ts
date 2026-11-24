import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PlanSaveOverlayResult } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/plan-save-overlay";
import { signal } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { PlanSave } from "../../../src/ui/overlays/panels/plan-save";
import { mountOverlay } from "../../helpers/overlay-terminal";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("plan save overlay", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("uses the latest generated suggestion when entered empty", () => {
		let result: PlanSaveOverlayResult | undefined;
		const suggested = signal("PLAN.md");
		const term = mountOverlay(() => PlanSave({ suggestedPath: suggested, onDone: value => (result = value) }), {
			focusKind: "input",
		});
		try {
			expect(term.screen().join("\n")).toContain("PLAN.md");
			suggested.set("AUTO_QA_PLAN.md");
			term.press("enter");
		} finally {
			term.dispose();
		}
		expect(result).toEqual({ path: "AUTO_QA_PLAN.md" });
	});

	it("uses a typed path instead of the suggestion", () => {
		let result: PlanSaveOverlayResult | undefined;
		const term = mountOverlay(
			() => PlanSave({ suggestedPath: () => "AUTO_QA_PLAN.md", onDone: value => (result = value) }),
			{ focusKind: "input" },
		);
		try {
			term.paste("plans/review.md");
			term.press("enter");
		} finally {
			term.dispose();
		}
		expect(result).toEqual({ path: "plans/review.md" });
	});
});
