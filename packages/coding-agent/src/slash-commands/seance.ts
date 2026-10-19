import type { TextContent } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import type { TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { discoverAgents } from "../task/discovery";
import { isBundledSeance, resolveSeanceSource } from "../task/seance";
import { SEANCE_AGENT_NAME } from "../task/seance-policy";
import seanceCommandPrompt from "../prompts/system/seance-command.md" with { type: "text" };
import seanceCommandSolutionSpace from "../prompts/system/seance-command-solution-space.md" with { type: "text" };
import { parseCommandArgs } from "../utils/command-args";
import { clearSubmittedText } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";
import type { InteractiveModeContext } from "../modes/types";

type ParsedSeanceArgs = { source: string | undefined; model: string | undefined } | { error: string };

function parseSeanceArgs(args: string): ParsedSeanceArgs {
	const tokens = parseCommandArgs(args, { strict: false });
	let source: string | undefined;
	let model: string | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--model" || token.startsWith("--model=")) {
			if (model !== undefined) return { error: "Use --model only once." };
			const selector = token === "--model" ? tokens[++index] : token.slice("--model=".length);
			if (!selector || selector.startsWith("--")) {
				return { error: "Usage: /seance [session id|path] [--model selector]" };
			}
			model = selector;
			continue;
		}
		if (token.startsWith("-")) return { error: `Unknown /seance option: ${token}` };
		if (source !== undefined) return { error: "Usage: /seance [session id|path] [--model selector]" };
		source = token;
	}
	return { source, model };
}

async function launchSeance(ctx: InteractiveModeContext, sourceSession: string, model?: string): Promise<void> {
	const taskTool = ctx.session.agent.state.tools.find(tool => tool.name === "task");
	if (!taskTool) {
		ctx.showError("The task tool is not available for /seance.");
		return;
	}
	const params: TaskParams = {
		agent: SEANCE_AGENT_NAME,
		sourceSession,
		task: seanceCommandPrompt,
		solutionSpace: seanceCommandSolutionSpace.trim(),
		...(model !== undefined ? { model } : {}),
	};
	const taskIds = new Set<string>();
	let jobId: string | undefined;
	let selectedModel: string | undefined;
	const collect = (details: TaskToolDetails | undefined): void => {
		if (!details) return;
		for (const progress of details.progress ?? []) {
			taskIds.add(progress.id);
			if (progress.resolvedModel) selectedModel = progress.resolvedModel;
		}
		for (const item of details.results ?? []) {
			taskIds.add(item.id);
			if (item.resolvedModel) selectedModel = item.resolvedModel;
		}
		jobId = details.async?.jobId ?? jobId;
	};
	try {
		const result = await taskTool.execute(`seance-${Snowflake.next()}`, params, undefined, update => {
			collect(update.details as TaskToolDetails | undefined);
		});
		const details = result.details as TaskToolDetails | undefined;
		collect(details);
		const content = result.content
			.filter((part): part is TextContent => part.type === "text")
			.map(part => part.text)
			.join("\n")
			.trim();
		const failedResult = details?.results?.find(item => item.error || item.aborted || item.exitCode !== 0);
		if (
			result.isError ||
			details?.async?.state === "failed" ||
			failedResult ||
			(!details?.async && (details?.results?.length ?? 0) === 0)
		) {
			const failureMessage = failedResult?.aborted
				? failedResult.abortReason || content || failedResult.error || "Seance preflight failed."
				: content || failedResult?.error || "Seance preflight failed.";
			ctx.showError(sanitizeErrorLine(failureMessage));
			return;
		}
		const state = details?.async?.state === "running" ? "running" : "completed";
		const taskLabel = taskIds.size > 0 ? [...taskIds].join(", ") : jobId;
		const modelLabel = selectedModel ? ` · ${selectedModel}` : "";
		ctx.showStatus(sanitizeErrorLine(`Seance ${state}${taskLabel ? `: ${taskLabel}` : ""}${modelLabel}`));
	} catch (error) {
		ctx.showError(sanitizeErrorLine(error));
	}
}

async function chooseSeanceModel(
	ctx: InteractiveModeContext,
	selector: string,
	model: string | undefined,
	sessionDirHint?: string,
): Promise<void> {
	try {
		const { agents } = await discoverAgents(
			ctx.sessionManager.getCwd(),
			undefined,
			ctx.session.effectiveExtensionRoots,
		);
		const seanceAgent = agents.find(agent => agent.name === SEANCE_AGENT_NAME);
		if (!seanceAgent || !isBundledSeance(seanceAgent)) {
			throw new Error("A custom `seance` agent overrides the bundled one; rename it to use /seance.");
		}
		const source = await resolveSeanceSource(selector, {
			cwd: ctx.sessionManager.getCwd(),
			sessionDirHint,
			includeGlobal: true,
		});
		const sourceSession = source.file;
		if (model !== undefined) {
			void launchSeance(ctx, sourceSession, model);
			return;
		}
		// No saved model to offer: go straight to the one-off model picker.
		const choice =
			source.modelSelectors.length === 0
				? "Choose another model"
				: await ctx.showHookSelector("Consult this session with", [
						{
							label: "Use saved model",
							description: "Use the active role or default model saved with this session",
						},
						{ label: "Choose another model", description: "Select a one-off model for this consultation" },
					]);
		if (choice === "Use saved model") {
			void launchSeance(ctx, sourceSession);
		} else if (choice === "Choose another model") {
			ctx.showModelSelector({
				selectOnly: {
					onSelect: picked => launchSeance(ctx, sourceSession, picked),
				},
			});
		}
	} catch (error) {
		ctx.showError(sanitizeErrorLine(error));
	}
}

export const SEANCE_SLASH_COMMAND: SlashCommandSpec = {
	name: "seance",
	icon: "ghost",
	description: "Consult a saved session without resuming it",
	inlineHint: "[session id|path] [--model selector]",
	allowArgs: true,
	handleTui: async (command, runtime) => {
		clearSubmittedText(runtime);
		const parsed = parseSeanceArgs(command.args);
		if ("error" in parsed) {
			runtime.ctx.showError(sanitizeErrorLine(parsed.error));
			return;
		}
		if (!parsed.source) {
			runtime.ctx.showSessionSelector(undefined, session =>
				chooseSeanceModel(runtime.ctx, session.path, parsed.model),
			);
			return;
		}
		await chooseSeanceModel(runtime.ctx, parsed.source, parsed.model, runtime.ctx.sessionManager.getSessionDir());
	},
};
