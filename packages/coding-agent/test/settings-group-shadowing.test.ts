import { describe, expect, it } from "bun:test";
import { dropSettingsGroupShadows } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("dropSettingsGroupShadows", () => {
	it("drops a non-object leaf that would shadow a settings group", () => {
		// A stray `"tui": "fullscreen"` must not replace omp's whole `tui.*` group.
		const result = dropSettingsGroupShadows({ tui: "fullscreen" }, "/proj/.omp/settings.json");
		expect(result).toEqual({});
	});

	it("keeps well-formed nested objects for a settings group", () => {
		const result = dropSettingsGroupShadows({ tui: { resizeScrollback: "preserve" } }, "/proj/.omp/settings.json");
		expect(result).toEqual({ tui: { resizeScrollback: "preserve" } });
	});

	it("drops nested non-object shadows without discarding valid siblings", () => {
		const result = dropSettingsGroupShadows(
			{ auth: { broker: "nonsense" }, autoResume: true },
			"/proj/.omp/settings.json",
		);
		expect(result).toEqual({ auth: {}, autoResume: true });
	});

	it("drops a top-level model string, which would shadow omp's model.* group", () => {
		// omp has no bare `model` leaf, only `model.*` settings, so the string is a shadow too.
		const result = dropSettingsGroupShadows({ model: "opus" }, "/proj/.omp/settings.json");
		expect(result).toEqual({});
	});
	it("passes unknown keys through untouched", () => {
		const result = dropSettingsGroupShadows(
			{ permissions: { allow: ["Bash"] }, $schema: "https://example.com/settings.schema.json" },
			"/proj/.omp/settings.json",
		);
		expect(result).toEqual({
			permissions: { allow: ["Bash"] },
			$schema: "https://example.com/settings.schema.json",
		});
	});

	it("preserves arrays at non-group paths", () => {
		const result = dropSettingsGroupShadows({ cycleOrder: ["a", "b"] }, "/proj/.omp/settings.json");
		expect(result).toEqual({ cycleOrder: ["a", "b"] });
	});
});
