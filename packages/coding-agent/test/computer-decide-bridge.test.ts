import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { runEvalComputerDecide } from "../src/computer/decide-bridge";
import type { ToolSession } from "../src/tools";

function session(settings: Settings): ToolSession {
	return {
		settings,
		modelRegistry: {
			authStorage: { hasAuth: () => false },
		},
		getSessionId: () => "sess-1",
	} as unknown as ToolSession;
}

describe("runEvalComputerDecide", () => {
	it("returns a rules-backed packet without Jev", async () => {
		const settings = Settings.isolated({ "computer.jev": "off" });
		const result = await runEvalComputerDecide(
			{
				state: {
					goal: "click Save",
					candidates: [{ id: "e1", label: "Save" }],
				},
			},
			{ session: session(settings) },
		);
		expect(result.data?.backend).toBe("rules");
		expect(result.data?.action).toBe("click");
		expect(result.details.jev).toBe(false);
	});

	it("validates state shape", async () => {
		const settings = Settings.isolated({});
		await expect(runEvalComputerDecide({ state: { goal: 1, candidates: [] } }, { session: session(settings) })).rejects.toThrow(
			"state.goal must be a string",
		);
	});
});
