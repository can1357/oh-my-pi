import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import analyzeFilePrompt from "../../../commit/agentic/prompts/analyze-file.md" with { type: "text" };
import type { CommitAgentState } from "../../../commit/agentic/state";
import type { NumstatEntry } from "../../../commit/types";
import type { ModelRegistry } from "../../../config/model-registry";
import type { Settings } from "../../../config/settings";
import type { CustomTool, CustomToolContext } from "../../../extensibility/custom-tools/types";
import type { AuthStorage } from "../../../session/auth-storage";
import { TaskTool } from "../../../task";
import type { TaskParams } from "../../../task/types";
import type { ToolSession } from "../../../tools";
import { getFilePriority } from "./git-file-diff";

const analyzeFileSchema = type({
	files: type("string").describe("file path").array().atLeastLength(1),
	"goal?": type("string").describe("analysis focus"),
});

const analyzeFileOutputSchema = {
	properties: {
		summary: { type: "string" },
		highlights: { elements: { type: "string" } },
		risks: { elements: { type: "string" } },
	},
};

function buildToolSession(
	ctx: CustomToolContext,
	options: {
		cwd: string;
		authStorage: AuthStorage;
		modelRegistry: ModelRegistry;
		settings: Settings;
		spawns: string;
	},
): ToolSession {
	return {
		cwd: options.cwd,
		hasUI: false,
		// Programmatic fan-out: results feed the commit agent's evidence, not a
		// model choosing further spawns, so the specialization nudge is noise here.
		suppressSpawnAdvisory: true,
		getSessionFile: () => ctx.sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => options.spawns,
		settings: options.settings,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		// The task tool no longer takes a per-call schema; the inherited session
		// schema drives structured output for every spawn from this session.
		outputSchema: analyzeFileOutputSchema,
	};
}

export function createAnalyzeFileTool(options: {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	spawns: string;
	state: CommitAgentState;
}): CustomTool<typeof analyzeFileSchema> {
	return {
		name: "analyze_files",
		label: "Analyze Files",
		description: "Spawn sonic agents to analyze files.",
		parameters: analyzeFileSchema,
		async execute(toolCallId, params, _onUpdate, ctx, signal) {
			const toolSession = buildToolSession(ctx, options);
			// The hand-built ToolSession carries no asyncJobManager, so every
			// execute() below takes the task tool's sync fallback and resolves
			// with the subagent's result inline — exactly what this flow needs.
			// The tool's session semaphore bounds the parallel fan-out.
			const taskTool = await TaskTool.create(toolSession);
			const numstat = options.state.overview?.numstat ?? [];

			const analyses = await Promise.all(
				params.files.map((file, index) => {
					const relatedFiles = formatRelatedFiles(params.files, file, numstat);
					const assignment = prompt.render(analyzeFilePrompt, {
						file,
						goal: params.goal,
						related_files: relatedFiles,
					});
					const taskParams: TaskParams = {
						name: `AnalyzeFile${index + 1}`,
						agent: "sonic",
						task: assignment,
					};
					return taskTool.execute(`${toolCallId}-${index + 1}`, taskParams, signal);
				}),
			);
			const results = analyses.flatMap(analysis => analysis.details?.results ?? []);
			const text = analyses
				.map(analysis => analysis.content.find(part => part.type === "text")?.text ?? "")
				.filter(Boolean)
				.join("\n\n");
			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details: {
					projectAgentsDir: null,
					results,
					totalDurationMs: analyses.reduce((sum, analysis) => sum + (analysis.details?.totalDurationMs ?? 0), 0),
				},
			};
		},
	};
}

function inferFileType(path: string): string {
	const priority = getFilePriority(path);
	const lowerPath = path.toLowerCase();

	if (priority === -100) return "binary file";
	if (priority === 10) return "test file";
	if (lowerPath.endsWith(".md") || lowerPath.endsWith(".txt")) return "documentation";
	if (
		lowerPath.endsWith(".json") ||
		lowerPath.endsWith(".yaml") ||
		lowerPath.endsWith(".yml") ||
		lowerPath.endsWith(".toml")
	)
		return "configuration";
	if (priority === 70) return "dependency manifest";
	if (priority === 80) return "script";
	if (priority === 100) return "implementation";

	return "source file";
}

function formatRelatedFiles(files: string[], currentFile: string, numstat: NumstatEntry[]): string | undefined {
	const others = files.filter(file => file !== currentFile);
	if (others.length === 0) return undefined;

	const numstatMap = new Map(numstat.map(entry => [entry.path, entry]));

	const lines = others.map(file => {
		const entry = numstatMap.get(file);
		const fileType = inferFileType(file);
		if (entry) {
			const lineCount = entry.additions + entry.deletions;
			return `- ${file} (${lineCount} lines): ${fileType}`;
		}
		return `- ${file}: ${fileType}`;
	});

	return `OTHER FILES IN THIS CHANGE:\n${lines.join("\n")}`;
}
