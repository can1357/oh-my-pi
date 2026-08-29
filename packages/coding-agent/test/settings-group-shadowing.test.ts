import { describe, expect, it } from "bun:test";
import { dropSettingsGroupShadows } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("dropSettingsGroupShadows", () => {
	it("drops a non-object leaf that would shadow a settings group", () => {
		// `.claude/settings.json` is shared with other tools; Claude Code's own
		// `"tui": "fullscreen"` must not replace omp's whole `tui.*` group.
		const result = dropSettingsGroupShadows({ tui: "fullscreen" }, "/proj/.claude/settings.json");
		expect(result).toEqual({});
	});

	it("keeps well-formed nested objects for a settings group", () => {
		const result = dropSettingsGroupShadows({ tui: { resizeScrollback: "preserve" } }, "/proj/.claude/settings.json");
		expect(result).toEqual({ tui: { resizeScrollback: "preserve" } });
	});

	it("drops nested non-object shadows without discarding valid siblings", () => {
		const result = dropSettingsGroupShadows(
			{ auth: { broker: "nonsense" }, autoResume: true },
			"/proj/.claude/settings.json",
		);
		expect(result).toEqual({ auth: {}, autoResume: true });
	});

	it("drops Claude Code's top-level model string, which would shadow omp's model.* group", () => {
		// Claude Code writes `"model": "opus"` at the top level; omp has no bare
		// `model` leaf, only `model.*` settings, so the string is a shadow too.
		const result = dropSettingsGroupShadows({ model: "opus" }, "/proj/.claude/settings.json");
		expect(result).toEqual({});
	});
	it("passes unknown keys through untouched", () => {
		const result = dropSettingsGroupShadows(
			{ permissions: { allow: ["Bash"] }, $schema: "https://json.schemastore.org/claude-code-settings.json" },
			"/proj/.claude/settings.json",
		);
		expect(result).toEqual({
			permissions: { allow: ["Bash"] },
			$schema: "https://json.schemastore.org/claude-code-settings.json",
		});
	});

	it("preserves arrays at non-group paths", () => {
		const result = dropSettingsGroupShadows({ cycleOrder: ["a", "b"] }, "/proj/.claude/settings.json");
		expect(result).toEqual({ cycleOrder: ["a", "b"] });
	});
});
