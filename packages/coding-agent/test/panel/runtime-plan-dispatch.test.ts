import { expect, mock, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createPanelPersonaAgent, type PanelPersona, renderPanelAssignment } from "@oh-my-pi/pi-coding-agent/panel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { StructuredSubagentRequest, StructuredSubagentResult } from "../../src/task/structured-subagent";

const dispatched: StructuredSubagentRequest[] = [];

mock.module("../../src/task/structured-subagent", () => ({
	runStructuredSubagent: async (request: StructuredSubagentRequest) => {
		dispatched.push(request);
		return {
			result: {
				index: request.index ?? 0,
				id: `panelist-${request.index ?? 0}`,
				agent: "panelist",
				agentSource: "bundled",
				task: request.assignment,
				exitCode: 0,
				output: `response-${request.index ?? 0}`,
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 1,
				requests: 1,
			},
		} as StructuredSubagentResult;
	},
}));

const { preparePanelRun, runPanel } = await import("../../src/panel/runtime");

const reviewer: PanelPersona = {
	label: "Initial reviewer",
	modes: ["answer"],
	instructions: "Assess the initial design for risks.",
	tools: "workspace-read",
};

const implementer: PanelPersona = {
	label: "Initial implementer",
	modes: ["answer"],
	instructions: "Assess the initial design for implementation constraints.",
	tools: "none",
};

test("runtime dispatches the reviewed plan after settings and model availability change", async () => {
	const claude = getBundledModel("anthropic", "claude-sonnet-4-5");
	const gpt = getBundledModel("openai", "gpt-5.4");
	if (!claude || !gpt) throw new Error("Test models not found");

	const settings = Settings.isolated({
		panel: {
			roles: {
				reviewed: {
					strategy: "personas",
					members: [
						{ model: "anthropic/claude-sonnet-4-5", persona: "reviewer" },
						{ model: "openai/gpt-5.4", persona: "implementer" },
					],
				},
			},
			personas: { reviewer, implementer },
		},
	});
	let available = [claude, gpt];
	const session = {
		settings,
		modelRegistry: {
			getAvailable: () => available,
			hasConfiguredAuth: () => true,
		},
	} as unknown as ToolSession;
	const request = "Review this exact design.";
	const plan = preparePanelRun({ session, taskMode: "answer", request, requestedRole: "reviewed" });

	settings.set("panel", {
		roles: {
			changed: {
				strategy: "independent",
				members: [{ model: "anthropic/claude-sonnet-4-5" }, { model: "openai/gpt-5.4" }],
			},
		},
		personas: {},
	});
	available = [];
	dispatched.length = 0;

	const result = await runPanel({ session, taskMode: "answer", request, requestedRole: "reviewed", plan });

	expect(dispatched).toHaveLength(2);
	expect(
		dispatched.map(({ session: dispatchedSession, model, thinkingLevel, assignment, agentDefinition }) => ({
			session: dispatchedSession,
			model,
			thinkingLevel,
			assignment,
			agentDefinition,
		})),
	).toEqual([
		{
			session,
			model: plan.preview.members[0]!.selector,
			thinkingLevel: plan.preview.members[0]!.thinking,
			assignment: renderPanelAssignment({ taskMode: "answer", strategy: "personas", request, persona: reviewer }),
			agentDefinition: createPanelPersonaAgent("reviewer", reviewer),
		},
		{
			session,
			model: plan.preview.members[1]!.selector,
			thinkingLevel: plan.preview.members[1]!.thinking,
			assignment: renderPanelAssignment({ taskMode: "answer", strategy: "personas", request, persona: implementer }),
			agentDefinition: createPanelPersonaAgent("implementer", implementer),
		},
	]);
	expect(result.cancelled).toBe(false);
	expect(result.members).toBe(plan.preview.members);
});
