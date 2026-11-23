/**
 * The eval tool's description options and its on-demand doc topics (`help://eval/<topic>`). A leaf of the eval tool:
 * `read` serves these topics in sessions without the eval tool, and must not pull in the tool's module graph.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../eval/preludes";
import evalAgentsTopic from "../prompts/tools/eval-agents.md" with { type: "text" };
import evalHelpersTopic from "../prompts/tools/eval-helpers.md" with { type: "text" };
import evalJudgeTopic from "../prompts/tools/eval-judge.md" with { type: "text" };
import type { PerCallModelAdvertisement } from "../task/model-approval";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
	/**
	 * Parent spawn policy (`getSessionSpawns`). `true`/omitted means unrestricted,
	 * `false`/`""` hides `agent()`, and a comma list drives the advertised default.
	 */
	spawns?: boolean | string | null;
	/** Advertise auto-backgrounding of long-running cells in the tool prompt. */
	autoBackgroundEnabled?: boolean;
	/** Advertise `@tool` / `tool(fn)` and the `tools` spawn option (`eval.tools.enabled`). */
	evalTools?: boolean;
	/** Push `workpool()` as the default for independent items (model delegation bias `eager`). Default: false. */
	eagerDelegation?: boolean;
	/** Point blocked callers at the `wait` tool; false when the session lacks it (subagents). Default: true. */
	waitTool?: boolean;
	/** Enabled preludes; each becomes an `help://eval/<name>` doc topic, inlined when it asks to be. */
	preludes?: readonly Pick<
		EvalPreludeDefinition,
		"name" | "documentation" | "summary" | "inlineDocumentation" | "firstCallDocumentation"
	>[];
	/** The session can send first-call guides; without it such a prelude is listed as read-first. */
	firstCallGuides?: boolean;
	/**
	 * Inline every doc topic instead of linking `help://eval/<topic>`. Required
	 * when the session cannot `read` (the only transport for topic docs).
	 */
	inlineTopics?: boolean;
	/** Whether missing runtimes and environments may be provisioned automatically. */
	autoProvision?: boolean;
	/** `task.perCallModel` accepts `model` for eval: advertise it on `agent()`/`workpool()`. Default: false. */
	perCallModel?: boolean;
	/** Operator-owned role selectors and narrowing allowlist; bare values use the current model registry. */
	perCallModelAdvertisement?: PerCallModelAdvertisement;
	/** Canonical and wire names currently accepted by the session tool bridge. */
	toolNames?: readonly string[];
	/** Session `tools.maxTimeout`; the advertised default deadline is the one it actually caps to. */
	maxTimeout?: number;
}

export function evalTemplateContext(options: EvalToolDescriptionOptions) {
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	return {
		py: options.py ?? true,
		js: options.js ?? true,
		evalTools: options.evalTools ?? true,
		eagerDelegation: options.eagerDelegation ?? false,
		waitTool: options.waitTool ?? true,
		autoBackgroundEnabled: options.autoBackgroundEnabled ?? false,
		spawns: spawnPolicy.enabled,
		spawnDefaultAgent: spawnPolicy.defaultAgent,
		spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
		autoProvision: options.autoProvision ?? true,
		perCallModel: options.perCallModel ?? false,
		perCallModelAdvertisement: options.perCallModelAdvertisement,
		timeoutDefault: clampTimeout("eval", undefined, options.maxTimeout),
		timeoutRaisable:
			clampTimeout("eval", TOOL_TIMEOUTS.eval.max, options.maxTimeout) >
			clampTimeout("eval", undefined, options.maxTimeout),
	};
}

/**
 * On-demand eval docs (`topic → markdown`) served at `help://eval/<topic>`:
 * `judge` (including completion), `helpers`, `agents` (when spawning is allowed),
 * and one per enabled prelude.
 */
export function getEvalDocTopics(options: EvalToolDescriptionOptions = {}): Record<string, string> {
	const context = evalTemplateContext(options);
	const topics: Record<string, string> = {
		judge: prompt.render(evalJudgeTopic, context),
		helpers: prompt.render(evalHelpersTopic, context),
	};
	if (context.spawns) topics.agents = prompt.render(evalAgentsTopic, context);
	for (const prelude of options.preludes ?? []) {
		const doc = prelude.documentation.trim();
		if (doc) topics[prelude.name] = doc;
	}
	return topics;
}
