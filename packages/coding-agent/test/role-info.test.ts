import { describe, expect, test } from "bun:test";
import { getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("getRoleInfo", () => {
	test("returns built-in role info", () => {
		const settings = Settings.isolated({});

		expect(getRoleInfo("default", settings)).toEqual({
			name: "Default",
			color: "success",
			tag: "DEFAULT",
		});
		expect(getRoleInfo("smol", settings)).toEqual({
			name: "Fast",
			color: "warning",
			tag: "SMOL",
		});
		expect(getRoleInfo("slow", settings)).toEqual({
			name: "Thinking",
			color: "accent",
			tag: "SLOW",
		});
	});

	test("returns custom role info from modelTags", () => {
		const settings = Settings.isolated({
			modelTags: {
				custom: { name: "My Custom Tag", color: "error" },
				another: { name: "Another Tag" },
			},
		});

		expect(getRoleInfo("custom", settings)).toEqual({
			name: "My Custom Tag",
			color: "error",
		});
		expect(getRoleInfo("another", settings)).toEqual({
			name: "Another Tag",
			color: undefined,
		});
	});

	test("returns fallback for unknown roles", () => {
		const settings = Settings.isolated({});

		expect(getRoleInfo("unknown-role", settings)).toEqual({
			name: "unknown-role",
			color: "muted",
		});
	});

	test("configured metadata overrides built-in role info while keeping built-in defaults", () => {
		const settings = Settings.isolated({
			modelTags: {
				smol: { name: "My Smol", color: "success" },
			},
		});

		expect(getRoleInfo("smol", settings)).toEqual({
			tag: "SMOL",
			name: "My Smol",
			color: "success",
		});
	});
});
