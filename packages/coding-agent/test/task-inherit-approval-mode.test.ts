import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";

describe("task.inheritApprovalMode", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("is declared as an opt-in boolean", () => {
		expect(SETTINGS_SCHEMA["task.inheritApprovalMode"]).toMatchObject({
			type: "boolean",
			default: false,
		});
	});

	it("defaults to off so unattended subagent delegation keeps working", () => {
		expect(Settings.instance.get("task.inheritApprovalMode")).toBe(false);
	});

	it("leaves the subagent default mode untouched when disabled", () => {
		expect(SETTINGS_SCHEMA["tools.approvalMode"]).toMatchObject({ default: "yolo" });
	});

	it("round-trips when a parent session opts in", () => {
		Settings.instance.set("task.inheritApprovalMode", true);
		expect(Settings.instance.get("task.inheritApprovalMode")).toBe(true);

		Settings.instance.set("task.inheritApprovalMode", false);
		expect(Settings.instance.get("task.inheritApprovalMode")).toBe(false);
	});

	it("is exposed in the tasks tab under Subagents", () => {
		const entry = getSettingsForTab("tasks").find(def => def.path === "task.inheritApprovalMode");

		expect(entry).toMatchObject({
			type: "boolean",
			label: "Inherit Approval Mode",
			group: "Subagents",
		});
	});
});
