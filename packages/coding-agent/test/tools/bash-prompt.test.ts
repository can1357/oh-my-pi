import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(overrides),
	};
}

describe("BashTool description", () => {
	it("always advises against habitual output-truncation pipes and names local://<N>.log", () => {
		const tool = new BashTool(createSession({ "tools.approvalMode": "yolo" }));
		expect(tool.description).toContain("local://<N>.log");
		expect(tool.description).not.toContain("disqualify allow rules");
	});

	it("omits approval-operator guidance when bash.patterns is empty", () => {
		const tool = new BashTool(createSession({ "tools.approvalMode": "write" }));
		expect(tool.description).not.toContain("disqualify allow rules");
	});

	it("includes approval-operator guidance when bash pattern approval is active", () => {
		const tool = new BashTool(
			createSession({
				"tools.approvalMode": "write",
				"bash.patterns": [{ match: "git status*", approval: "allow" }],
				"bash.allowCompoundCommands": true,
			}),
		);
		expect(tool.description).toContain("disqualify allow rules");
		expect(tool.description).toContain("&&");
	});

	it("omits && hint when allowCompoundCommands is false", () => {
		const tool = new BashTool(
			createSession({
				"tools.approvalMode": "write",
				"bash.patterns": [{ match: "git status*", approval: "allow" }],
				"bash.allowCompoundCommands": false,
			}),
		);
		expect(tool.description).toContain("disqualify allow rules");
		expect(tool.description).not.toContain("&&");
	});

	it("omits approval-operator guidance in yolo mode unless bash policy explicitly prompts", () => {
		const yoloTool = new BashTool(
			createSession({
				"tools.approvalMode": "yolo",
				"bash.patterns": [{ match: "git status*", approval: "allow" }],
			}),
		);
		expect(yoloTool.description).not.toContain("disqualify allow rules");

		const promptOverrideTool = new BashTool(
			createSession({
				"tools.approvalMode": "yolo",
				"tools.approval": { bash: "prompt" },
				"bash.patterns": [{ match: "git status*", approval: "allow" }],
			}),
		);
		expect(promptOverrideTool.description).toContain("disqualify allow rules");
	});

	it("omits approval-operator guidance when bash.patterns has no allow rules", () => {
		const tool = new BashTool(
			createSession({
				"tools.approvalMode": "write",
				"bash.patterns": [
					{ match: "rm -rf *", approval: "deny" },
					{ match: "git push*", approval: "prompt" },
				],
			}),
		);
		expect(tool.description).not.toContain("disqualify allow rules");
	});

	it("normalizes bash policy case and whitespace", () => {
		const allowTool = new BashTool(
			createSession({
				"tools.approvalMode": "write",
				"tools.approval": { bash: " ALLOW " },
				"bash.patterns": [{ match: "git status*", approval: "allow" }],
			}),
		);
		expect(allowTool.description).not.toContain("disqualify allow rules");

		const denyTool = new BashTool(
			createSession({
				"tools.approvalMode": "write",
				"tools.approval": { bash: "DENY" },
				"bash.patterns": [{ match: "git status*", approval: "allow" }],
			}),
		);
		expect(denyTool.description).not.toContain("disqualify allow rules");

		const promptTool = new BashTool(
			createSession({
				"tools.approvalMode": "yolo",
				"tools.approval": { bash: " PROMPT " },
				"bash.patterns": [{ match: "git status*", approval: "allow" }],
			}),
		);
		expect(promptTool.description).toContain("disqualify allow rules");
	});
});
