import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type EvalPreludeDefinition, invokeEvalPrelude } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const definition: EvalPreludeDefinition = {
	name: "fixture",
	documentation: "fixture",
	javascript: "",
	python: "",
	exports: [],
	approval: { tier: "exec", policy: "prompt" },
	async invoke() {
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: true,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: Settings.isolated(),
	getEvalPreludes: () => [definition],
};

describe("eval prelude approval prompt", () => {
	it("announces the approval, since the eval call blocks on it", async () => {
		const selects: Array<ExtensionUIDialogOptions | undefined> = [];
		const ui = {
			select: async (_title: string, _options: unknown, dialogOptions?: ExtensionUIDialogOptions) => {
				selects.push(dialogOptions);
				return "Approve";
			},
		} as unknown as ExtensionUIContext;
		const settings = Settings.isolated();
		settings.set("tools.approvalMode", "always-ask");
		const context = { ui, hasUI: true, settings } as unknown as AgentToolContext;

		const result = await invokeEvalPrelude("fixture", {}, { session, toolCallId: "call-1", context });

		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(selects).toHaveLength(1);
		expect(selects[0]?.announce).toBe(true);
	});
});
