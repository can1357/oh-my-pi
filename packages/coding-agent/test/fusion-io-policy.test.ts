import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import {
	getAutonomousRootToolBlockReason,
	getFusionIoThresholdWarning,
	isFusionIoDelegationActive,
	resolveFusionIoMinLines,
} from "../src/session/fusion-io-policy";
import { isTokenSavingsFusionActive } from "../src/session/fusion-router";

const settingsFrom = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

describe("Fusion I/O policy", () => {
	it.each([
		[false, "token-savings", undefined, false],
		[true, "delegate", undefined, false],
		[true, "escalate", undefined, false],
		[true, "off", undefined, false],
		[true, "normal", undefined, false],
		[true, "savings", undefined, true],
		[true, "token-savings", true, true],
		[true, "autonomous", undefined, true],
		[true, "autonomous", false, false],
		[true, "token-savings", false, false],
	])("composes enabled=%j mode=%j io=%j as %j", (enabled, mode, ioEnabled, expected) => {
		expect(
			isFusionIoDelegationActive(
				settingsFrom({
					"fusion.enabled": enabled,
					"fusion.mode": mode,
					"fusion.ioDelegation.enabled": ioEnabled,
				}),
			),
		).toBe(expected);
	});

	it("keeps Fusion disabled by default and autonomous out of root savings steering", () => {
		const defaults = Settings.isolated({});
		expect(isFusionIoDelegationActive(defaults)).toBe(false);
		expect(defaults.get("fusion.ioDelegation.enabled")).toBe(true);
		expect(resolveFusionIoMinLines(defaults, undefined)).toBe(350);
		const autonomous = Settings.isolated({ "fusion.enabled": true, "fusion.mode": "autonomous" });
		expect(isFusionIoDelegationActive(autonomous)).toBe(true);
		expect(isTokenSavingsFusionActive(autonomous)).toBe(false);
	});

	it.each([undefined, "0", "-1", "1.5", "nope", "", "Infinity", "1e3", "0x10", "9007199254740992"])(
		"ignores an invalid or absent environment override (%j)",
		value => {
			const settings = settingsFrom({ "fusion.ioDelegation.minLines": 275 });
			expect(resolveFusionIoMinLines(settings, value)).toBe(275);
			expect(Boolean(getFusionIoThresholdWarning(settings, value))).toBe(value !== undefined);
		},
	);

	it.each([undefined, 0, -1, 3.5, NaN, Infinity, "100", 9007199254740992])(
		"defaults invalid persisted values (%j)",
		value => {
			const settings = settingsFrom({ "fusion.ioDelegation.minLines": value });
			expect(resolveFusionIoMinLines(settings, undefined)).toBe(350);
			expect(resolveFusionIoMinLines(settings, " 123 ")).toBe(123);
			expect(Boolean(getFusionIoThresholdWarning(settings, undefined))).toBe(value !== undefined);
		},
	);

	it("uses valid environment values ahead of settings without warnings", () => {
		const settings = settingsFrom({ "fusion.ioDelegation.minLines": 99 });
		expect(resolveFusionIoMinLines(settings, "351")).toBe(351);
		expect(resolveFusionIoMinLines(settings, "1")).toBe(1);
		expect(getFusionIoThresholdWarning(settings, "351")).toBeUndefined();
	});

	it("keeps root capabilities fail-closed even when I/O delegation is opted out", () => {
		const settings = Settings.isolated({
			"fusion.enabled": true,
			"fusion.mode": "autonomous",
			"fusion.ioDelegation.enabled": false,
		});
		expect(getAutonomousRootToolBlockReason(settings, "main", "eval", {})).toContain(
			"Delegate execution through task.",
		);
		expect(getAutonomousRootToolBlockReason(settings, "sub", "eval", {})).toBeUndefined();
		expect(getAutonomousRootToolBlockReason(settings, "main", "resolve", { action: "discard" })).toBeUndefined();
		expect(getAutonomousRootToolBlockReason(settings, "main", "resolve", { action: "apply" })).toBeDefined();
	});
});
