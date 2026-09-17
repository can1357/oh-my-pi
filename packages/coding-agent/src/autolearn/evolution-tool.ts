import type { AgentToolResult } from "@pk-nerdsaver-ai/pi-agent-core";
import { completeSimple } from "@pk-nerdsaver-ai/pi-ai";
import type { ToolSession } from "../tools";
import { evolveSkill, promoteEvolution } from "./evolution";
import type { EvolutionInput, EvolutionReport } from "./evolution-types";
import { writeVaultEvolution } from "./vault";

export interface EvolutionActionParams {
	action: "evolve" | "promote";
	name: string;
	evolution?: EvolutionInput;
	runId?: string;
}

export async function executeSkillEvolution(
	session: ToolSession,
	params: EvolutionActionParams,
	signal?: AbortSignal,
): Promise<AgentToolResult> {
	if (!session.settings.get("autolearn.enabled") || !session.settings.get("autolearn.evolution.enabled")) {
		throw new Error("Skill evolution requires autolearn.enabled and autolearn.evolution.enabled.");
	}
	const agentDir = session.settings.getAgentDir();
	signal?.throwIfAborted();
	let report: EvolutionReport;
	let auditPath: string;
	if (params.action === "promote") {
		if (!params.runId) throw new Error("Promotion requires runId from an eligible evolution result.");
		// Name binding is checked by the promotion helper before any managed file is changed.
		const result = await promoteEvolution(agentDir, params.runId, params.name);
		report = result.report;
		auditPath = result.path;
	} else {
		if (!params.evolution) throw new Error("Evolution requires lessons, training cases and held-out cases.");
		const model = session.getActiveModel?.();
		if (!model) throw new Error("Skill evolution requires an active session model.");
		const maxTokens = session.settings.get("autolearn.evolution.maxOutputTokens");
		const seconds = session.settings.get("autolearn.evolution.timeoutSeconds");
		if (
			!Number.isInteger(maxTokens) ||
			maxTokens < 1 ||
			maxTokens > 8192 ||
			!Number.isInteger(seconds) ||
			seconds < 1 ||
			seconds > 600
		) {
			throw new Error("Evolution output cap must be 1–8192 tokens and timeout 1–600 seconds.");
		}
		const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(seconds * 1000)]);
		const apiKey = await session.modelRegistry?.getApiKey(model, session.getSessionId?.() ?? undefined);
		const result = await evolveSkill(params.name, params.evolution, {
			agentDir,
			model: `${model.provider}/${model.id}`,
			maxCalls: session.settings.get("autolearn.evolution.maxCalls"),
			signal: combined,
			complete: async (system, user, requestSignal) => {
				const answer = await completeSimple(
					model,
					{
						systemPrompt: [system],
						messages: [{ role: "user", content: user, timestamp: Date.now() }],
						tools: [],
					},
					{ apiKey, signal: requestSignal, maxTokens },
				);
				if (answer.stopReason !== "stop")
					throw new Error(answer.errorMessage || `Evolution completion stopped with ${answer.stopReason}.`);
				return answer.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join("\n");
			},
		});
		report = result.report;
		auditPath = result.path;
	}
	let vaultPath: string | undefined;
	const root = session.settings.get("autolearn.vaultPath");
	if (root) {
		try {
			vaultPath = await writeVaultEvolution(
				{ root, project: session.settings.get("autolearn.vaultProject"), cwd: session.settings.getCwd() },
				report,
				auditPath,
			);
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Evolution ${report.state}; local result retained at ${auditPath}. Obsidian mirror failed: ${error instanceof Error ? error.message : String(error)}. Do not replay promotion to repair a mirror.`,
					},
				],
				isError: true,
				details: { runId: report.id, state: report.state, auditPath },
			};
		}
	}
	return {
		content: [
			{
				type: "text",
				text: `Skill evolution ${report.state}. Run: ${report.id}. Local result: ${auditPath}.${report.state === "eligible" ? " Candidate is not installed; use manage_skill action=promote with this name and runId to explicitly promote." : ""}${report.error ? ` ${report.error}` : ""}${vaultPath ? ` Obsidian: ${vaultPath}` : ""}`,
			},
		],
		isError: report.state === "failed",
		details: { runId: report.id, state: report.state, calls: report.calls, auditPath, vaultPath },
	};
}
