import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BUILTIN_TOOL_HELP, BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

describe("BUILTIN_TOOL_HELP", () => {
	// `omp --help` groups tools by this map; it must match what a default session actually gets.
	test("matches the tools a top-level session allows under default settings", async () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			skipPythonPreflight: true,
		};
		const plan = await resolveBuiltinToolPlan(session);
		// `detected` tools depend on the host (an IDA install, a judge model), not on settings.
		const settled = BUILTIN_TOOL_NAMES.filter(name => BUILTIN_TOOL_HELP[name].defaultState !== "detected");
		const actual = Object.fromEntries(settled.map(name => [name, plan.isAllowed(name) ? "on" : "off"]));
		const declared = Object.fromEntries(settled.map(name => [name, BUILTIN_TOOL_HELP[name].defaultState]));
		expect(actual).toEqual(declared);
	});
});
