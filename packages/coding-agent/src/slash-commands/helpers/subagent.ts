import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { getSupportedEfforts } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import type { Component } from "@pk-nerdsaver-ai/pi-tui";
import { logger, prompt, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { formatModelString, parseModelPattern } from "../../config/model-resolver";
import { mergeSubagentModelAliases, resolveSubagentModelAlias } from "../../config/subagent-model-aliases";
import type { ExtensionUISelectItem } from "../../extensibility/extensions";
import type { LocalProtocolOptions } from "../../internal-urls";
import { ModelSelectorComponent } from "../../modes/components/model-selector";
import { isValidThemeColor, type ThemeColor } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { loadOverallPlanReference } from "../../plan-mode/plan-handoff";
import subagentUserPromptTemplate from "../../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { discoverAgents, getAgent } from "../../task/discovery";
import { runSubprocess } from "../../task/executor";
import { generateTaskName } from "../../task/name-generator";
import { AgentOutputManager } from "../../task/output-manager";
import { getThinkingLevelMetadata } from "../../thinking";

export interface ParsedUsingForm {
	modelInput: string;
	task: string;
}

export interface SubagentModelSelection {
	model: Model<Api>;
	selector: string;
}

export async function resolveSlashSubagentModel(
	ctx: InteractiveModeContext,
	input: string,
): Promise<{ model: Model<Api>; selector: string } | null> {
	const aliases = mergeSubagentModelAliases(ctx.settings.get("subagent.modelAliases"));
	const resolved = resolveSubagentModelAlias(input, aliases, ctx.session.modelRegistry);
	if (!resolved) return null;
	const model = parseResolvedModel(resolved, ctx.session.modelRegistry);
	if (!model) return null;
	return { model, selector: resolved };
}

export interface SubagentWizardState {
	modelOverride: string;
	thinkingLevel: ThinkingLevel;
	name?: string;
	color?: ThemeColor;
	task: string;
	/**
	 * Marks this spawn as the Fusion warm sidekick (set only by
	 * `ensureFusionSidekick`). Gates `fusion.sidekickRequestBudget` — the cap
	 * applies to the sidekick's delegated turns only, never to ordinary
	 * subagents spawned while fusion happens to be enabled.
	 */
	fusionSidekick?: boolean;
}

const SUBAGENT_COLOR_OPTIONS: readonly ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"toolTitle",
	"mdLink",
	"syntaxFunction",
	"syntaxString",
	"statusLineSubagents",
];

interface ConsumedSlashValue {
	value: string;
	rest: string;
}

function consumeSlashValue(input: string): ConsumedSlashValue {
	const source = input.trimStart();
	const quote = source[0];
	if (quote !== '"' && quote !== "'") {
		const boundary = source.search(/\s/);
		return boundary === -1
			? { value: source, rest: "" }
			: { value: source.slice(0, boundary), rest: source.slice(boundary).trimStart() };
	}

	let value = "";
	for (let index = 1; index < source.length; index++) {
		const character = source[index];
		if (character === "\\" && index + 1 < source.length) {
			value += source[++index];
			continue;
		}
		if (character === quote) {
			return { value, rest: source.slice(index + 1).trimStart() };
		}
		value += character;
	}
	return { value, rest: "" };
}

export function parseUsingForm(args: string): ParsedUsingForm | null {
	const trimmed = args.trim();
	if (!/^using(?:\s|$)/i.test(trimmed)) return null;
	const source = trimmed.slice("using".length).trimStart();
	if (!source) return { modelInput: "", task: "" };

	const model = consumeSlashValue(source);
	if (!model.rest) return { modelInput: model.value.trim(), task: "" };

	const task =
		model.rest[0] === '"' || model.rest[0] === "'" ? consumeSlashValue(model.rest) : { value: model.rest, rest: "" };
	return {
		modelInput: model.value.trim(),
		task: `${task.value}${task.rest ? ` ${task.rest}` : ""}`.trim(),
	};
}

function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, { assignment });
}

export function parseResolvedModel(selector: string, registry: ModelRegistry): Model<Api> | undefined {
	return parseModelPattern(selector, registry.getAvailable() as Model<Api>[], undefined, { modelRegistry: registry })
		.model;
}

async function selectSubagentModel(ctx: InteractiveModeContext): Promise<SubagentModelSelection | undefined> {
	const currentContextTokens = ctx.session.getContextUsage()?.tokens ?? 0;
	return ctx.showHookCustom<SubagentModelSelection | undefined>(
		(tui, _theme, _keybindings, done) =>
			new ModelSelectorComponent(
				tui,
				ctx.session.model,
				ctx.settings,
				ctx.session.modelRegistry,
				ctx.session.scopedModels,
				(model, _role, _thinkingLevel, selector) => {
					done({ model: model as Model<Api>, selector: selector ?? formatModelString(model as Model<Api>) });
				},
				() => done(undefined),
				{ temporaryOnly: true, currentContextTokens },
			) as Component & { dispose?(): void },
		{ overlay: false },
	);
}

async function selectThinkingLevel(ctx: InteractiveModeContext, model: Model<Api>): Promise<ThinkingLevel | undefined> {
	const levels = [ThinkingLevel.Inherit, ThinkingLevel.Off, ...getSupportedEfforts(model)];
	const current = ctx.session.thinkingLevel ?? ThinkingLevel.Inherit;
	const initialIndex = Math.max(0, levels.indexOf(current));
	const options: ExtensionUISelectItem[] = levels.map(level => {
		const metadata = getThinkingLevelMetadata(level);
		return {
			label: level,
			description: `${metadata.label}: ${metadata.description}`,
		};
	});
	const selected = await ctx.showHookSelector("Subagent thinking", options, { initialIndex });
	return levels.find(level => level === selected);
}

async function promptOptionalName(ctx: InteractiveModeContext): Promise<string | undefined | null> {
	const input = await ctx.showHookInput("Subagent name (optional)", "leave blank for generated name");
	if (input === undefined) return null;
	return input.trim() || undefined;
}

async function promptOptionalColor(ctx: InteractiveModeContext): Promise<ThemeColor | undefined | null> {
	const options: ExtensionUISelectItem[] = [
		{ label: "none", description: "Do not assign a roster color" },
		...SUBAGENT_COLOR_OPTIONS.map(color => ({ label: color, description: `Use ${color} for roster labels` })),
	];
	const selected = await ctx.showHookSelector("Subagent color", options, { initialIndex: 0 });
	if (selected === undefined) return null;
	if (selected === "none") return undefined;
	return isValidThemeColor(selected) ? selected : undefined;
}

async function promptTask(ctx: InteractiveModeContext, prefill: string): Promise<string | undefined> {
	const input = await ctx.showHookEditor("Subagent task", prefill, undefined, { promptStyle: true });
	return input?.trim();
}

function createLocalProtocolOptions(ctx: InteractiveModeContext, fallbackArtifactsDir: string): LocalProtocolOptions {
	return {
		getArtifactsDir: () => ctx.sessionManager.getArtifactsDir() ?? fallbackArtifactsDir,
		getSessionId: () => ctx.sessionManager.getSessionId(),
	};
}

async function loadTaskAgent(ctx: InteractiveModeContext, agentName = "task") {
	const cwd = ctx.sessionManager.getCwd();
	const { agents } = await discoverAgents(cwd);
	return getAgent(agents, agentName);
}

/**
 * Recursion depth of the session that owns `ctx` (0 = main). Mirrors how the
 * `task` tool sources `taskDepth` from its own session (`this.session.taskDepth`);
 * `AgentSession` does not surface that number, so we walk the AgentRegistry
 * parent chain to `Main` exactly like `persisted-revive` derives a revived
 * subagent's depth. The executor adds the child `+1`, so a spawn from MAIN is
 * depth 1.
 */
function resolveParentTaskDepth(agentId: string | undefined): number {
	if (!agentId || agentId === MAIN_AGENT_ID) return 0;
	const registry = AgentRegistry.global();
	const seen = new Set<string>();
	let depth = 0;
	let current: string | undefined = agentId;
	while (current && current !== MAIN_AGENT_ID && !seen.has(current)) {
		seen.add(current);
		const parentId: string | undefined = registry.get(current)?.parentId;
		if (!parentId) break;
		depth++;
		current = parentId;
	}
	return depth;
}

/**
 * Per-parent spawn counter giving each `/subagent` a distinct progress `index`
 * within its parent session. The `task` tool indexes spawns by batch position;
 * the wizard spawns one at a time, so a monotonic per-parent allocator plays the
 * same role and keeps concurrent detached spawns off a shared slot.
 */
const nextSpawnIndexByParent = new WeakMap<AgentSession, number>();

function allocateSpawnIndex(parent: AgentSession): number {
	const index = nextSpawnIndexByParent.get(parent) ?? 0;
	nextSpawnIndexByParent.set(parent, index + 1);
	return index;
}

export async function spawnSubagent(
	ctx: InteractiveModeContext,
	state: SubagentWizardState,
	agentName = "task",
): Promise<string> {
	const agent = await loadTaskAgent(ctx, agentName);
	if (!agent) {
		ctx.showError(`Cannot spawn subagent: bundled ${agentName} agent is unavailable.`);
		return "";
	}

	await ctx.sessionManager.ensureOnDisk();
	const cwd = ctx.sessionManager.getCwd();
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	const persistedArtifactsDir = ctx.sessionManager.getArtifactsDir();
	const tempArtifactsDir = persistedArtifactsDir ? null : path.join(os.tmpdir(), `omp-subagent-${Snowflake.next()}`);
	const artifactsDir = persistedArtifactsDir ?? tempArtifactsDir;
	if (!artifactsDir) {
		ctx.showError("Cannot spawn subagent: no artifact directory is available.");
		return "";
	}
	await fs.mkdir(artifactsDir, { recursive: true });

	const outputManager = new AgentOutputManager(() => artifactsDir);
	const id = await outputManager.allocate(state.name ?? generateTaskName());
	const localProtocolOptions = createLocalProtocolOptions(ctx, artifactsDir);
	const planModeState = ctx.session.getPlanModeState();
	const planReference = planModeState?.enabled
		? undefined
		: await loadOverallPlanReference(ctx.session.getPlanReferencePath(), localProtocolOptions);
	// `index` orders/labels this spawn among the parent's children; `taskDepth`
	// is the parent session's recursion depth (the executor adds +1 for the child).
	const spawnIndex = allocateSpawnIndex(ctx.session);
	const parentTaskDepth = resolveParentTaskDepth(ctx.session.getAgentId());

	const run = runSubprocess({
		cwd,
		agent,
		task: renderSubagentUserPrompt(state.task),
		assignment: state.task,
		description: state.task,
		role: state.name,
		index: spawnIndex,
		id,
		detached: true,
		fusionSidekick: state.fusionSidekick,
		modelOverride: state.modelOverride,
		parentActiveModelPattern: ctx.session.model ? formatModelString(ctx.session.model as Model<Api>) : undefined,
		thinkingLevel: state.thinkingLevel,
		taskDepth: parentTaskDepth,
		sessionFile: parentSessionFile,
		persistArtifacts: !!persistedArtifactsDir,
		artifactsDir,
		enableLsp: ctx.settings.get("task.enableLsp"),
		eventBus: ctx.eventBus,
		authStorage: ctx.session.modelRegistry.authStorage,
		modelRegistry: ctx.session.modelRegistry,
		settings: ctx.settings,
		mcpManager: ctx.mcpManager,
		skills: [...ctx.session.skills],
		promptTemplates: [...ctx.session.promptTemplates],
		localProtocolOptions,
		parentArtifactManager: ctx.sessionManager.getArtifactManager() ?? undefined,
		parentAgentId: ctx.session.getAgentId() ?? MAIN_AGENT_ID,
		color: state.color,
		planReference,
	});

	ctx.showStatus(`Spawned subagent ${id} on ${state.modelOverride}.`);
	void run
		.then(result => {
			if (result.exitCode === 0) {
				ctx.showStatus(`Subagent ${id} completed.`);
			} else {
				ctx.showError(`Subagent ${id} failed${result.error ? `: ${result.error}` : "."}`);
			}
			ctx.ui.requestRender();
		})
		.catch(error => {
			logger.error("Subagent slash command spawn failed", { error });
			const message = error instanceof Error ? error.message : String(error);
			ctx.showError(`Subagent ${id} failed: ${message}`);
			ctx.ui.requestRender();
		});

	return id;
}

export async function collectSubagentWizardState(
	ctx: InteractiveModeContext,
	model: Model<Api>,
	modelOverride: string,
	prefilledTask: string,
	quickTask: boolean,
): Promise<SubagentWizardState | undefined> {
	const thinkingLevel = quickTask
		? (ctx.session.thinkingLevel ?? ThinkingLevel.Inherit)
		: await selectThinkingLevel(ctx, model);
	if (thinkingLevel === undefined) return undefined;

	const name = await promptOptionalName(ctx);
	if (name === null) return undefined;

	const color = quickTask ? undefined : await promptOptionalColor(ctx);
	if (color === null) return undefined;

	const task = quickTask && prefilledTask.trim() ? prefilledTask.trim() : await promptTask(ctx, prefilledTask);
	if (!task) {
		ctx.showError("Subagent task is required.");
		return undefined;
	}

	return { modelOverride, thinkingLevel, name, color, task };
}

async function completeWizard(
	ctx: InteractiveModeContext,
	model: Model<Api>,
	modelOverride: string,
	prefilledTask: string,
	quickTask: boolean,
): Promise<void> {
	const state = await collectSubagentWizardState(ctx, model, modelOverride, prefilledTask, quickTask);
	if (!state) return;
	await spawnSubagent(ctx, state);
}

async function handleUsingForm(ctx: InteractiveModeContext, usingForm: ParsedUsingForm): Promise<void> {
	if (!usingForm.modelInput) {
		ctx.showError("Usage: /subagent using <alias-or-model> <task>");
		return;
	}
	const result = await resolveSlashSubagentModel(ctx, usingForm.modelInput);
	if (!result) {
		ctx.showError(`No available model matched "${usingForm.modelInput}".`);
		return;
	}
	await completeWizard(ctx, result.model, result.selector, usingForm.task, true);
}

export async function handleSubagentSlashCommand(args: string, ctx: InteractiveModeContext): Promise<void> {
	const usingForm = parseUsingForm(args);
	if (usingForm) {
		await handleUsingForm(ctx, usingForm);
		return;
	}

	const selection = await selectSubagentModel(ctx);
	if (!selection) return;
	await completeWizard(ctx, selection.model, selection.selector, args.trim(), false);
}
