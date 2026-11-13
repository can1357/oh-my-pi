import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import { formatModelString, formatModelStringWithRouting, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import modelMentionDescription from "../prompts/agents/model-mention.md" with { type: "text" };
import { getBundledAgent } from "../task/agents";
import type { AgentDefinition } from "../task/types";
import {
	MODEL_MENTION_RE,
	type ModelMention,
	modelMentionDisplayName,
	type ResolvedModelMention,
	modelMentionName,
	modelMentionTag,
} from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import { AUTO_THINKING, parseConfiguredThinkingLevel, parseEffort } from "@oh-my-pi/pi-tui/thinking";
import { cfgDefaultThinkingLevel } from "./settings";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Journal entry identifying a model the user authorized for delegation. */
export const MODEL_MENTION_ENTRY_TYPE = "model_mention";

/** Replay valid branch entries, keeping the first occurrence of each agent and selector. */
export function readModelMentions(entries: readonly SessionEntry[]): ModelMention[] {
	const mentions: ModelMention[] = [];
	const agents = new Set<string>();
	const selectors = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODEL_MENTION_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { agent, selector, name, thinkingLevel } = entry.data;
		if (
			typeof agent !== "string" ||
			!/^m\d+$/.test(agent) ||
			typeof selector !== "string" ||
			typeof name !== "string" ||
			(thinkingLevel !== undefined &&
				(typeof thinkingLevel !== "string" ||
					parseEffort(thinkingLevel) !== thinkingLevel ||
					!selector.endsWith(`:${thinkingLevel}`)))
		)
			continue;
		if (agents.has(agent) || selectors.has(selector)) continue;
		agents.add(agent);
		selectors.add(selector);
		mentions.push({ agent, selector, name, thinkingLevel });
	}
	return mentions;
}

/** Session capabilities needed to authorize and persist model mentions. */
export interface ModelMentionHost {
	sessionManager: SessionManager;
	modelRegistry: Pick<ModelRegistry, "getAvailable">;
	settings: Settings;
	scopedModels(): ReadonlyArray<Model>;
	/** User-authorized model agents inherited from the parent session. */
	inheritedAgents?: readonly AgentDefinition[];
}

/** Owns branch-local pseudonyms for models explicitly tagged by the user. */
export class ModelMentionRegistry {
	readonly #host: ModelMentionHost;
	readonly #inheritedAgents: readonly AgentDefinition[];
	#mentions: ModelMention[] = [];
	readonly #bySelector = new Map<string, ModelMention>();
	readonly #agents = new Set<string>();

	constructor(host: ModelMentionHost) {
		this.#host = host;
		this.#inheritedAgents = host.inheritedAgents ?? [];
	}

	/** Rebuild pseudonyms after resume, rewind, or a session switch. */
	syncFromBranch(): void {
		this.#mentions = readModelMentions(this.#host.sessionManager.getBranch());
		this.#bySelector.clear();
		this.#agents.clear();
		for (const agent of this.#inheritedAgents) {
			this.#agents.add(agent.name);
		}
		for (const mention of this.#mentions) {
			this.#bySelector.set(mention.selector, mention);
			this.#agents.add(mention.agent);
		}
	}

	/** User-authorized model pseudonyms in first-mention order. */
	get mentions(): readonly ModelMention[] {
		return this.#mentions;
	}

	/**
	 * Resolve a concrete model or `@role[:level]` within the mention scope.
	 * Exact model ids win over effort suffixes; role efforts cannot bind a
	 * different model whose literal id is the same as the completed selector.
	 */
	resolve(selector: string): ResolvedModelMention | undefined {
		const scoped = this.#host.scopedModels();
		const models = scoped.length > 0 ? scoped : this.#host.modelRegistry.getAvailable();
		const isScoped = scoped.length > 0;
		if (selector.startsWith("@")) return this.#resolveRole(selector, models, isScoped);
		const exact = models.find(model => formatModelString(model) === selector);
		if (exact) return this.#resolveModel(exact, undefined, models, isScoped);
		const colon = selector.lastIndexOf(":");
		if (colon <= 0) return undefined;
		const base = selector.slice(0, colon);
		const model = models.find(candidate => formatModelString(candidate) === base);
		if (!model) return undefined;
		const suffix = selector.slice(colon + 1);
		if (suffix === AUTO_THINKING) return this.#resolveModel(model, undefined, models, isScoped);
		const effort = parseEffort(suffix);
		return effort === undefined ? undefined : this.#resolveModel(model, effort, models, isScoped);
	}

	#resolveRole(selector: string, models: ReadonlyArray<Model>, isScoped: boolean): ResolvedModelMention | undefined {
		const colon = selector.indexOf(":");
		const role = selector.slice(1, colon < 0 ? undefined : colon);
		const { settings } = this.#host;
		if (!getKnownRoleIds(settings).includes(role)) return undefined;
		const info = getRoleInfo(role, settings);
		if (info.hidden || info.section !== "chat") return undefined;
		const override = colon < 0 ? undefined : selector.slice(colon + 1);
		const overrideEffort = parseEffort(override);
		if (override !== undefined && override !== AUTO_THINKING && overrideEffort === undefined) return undefined;
		const resolved = resolveModelRoleValue(`@${role}`, models.filter(info.accepts), { settings });
		if (!resolved.model) return undefined;
		if (override !== undefined) return this.#resolveModel(resolved.model, overrideEffort, models, isScoped);
		const thinkingLevel = resolved.explicitThinkingLevel
			? resolved.thinkingLevel
			: role === "default"
				? parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings))
				: undefined;
		const effort = getSupportedEfforts(resolved.model).find(level => level === thinkingLevel);
		const mention = this.#resolveModel(resolved.model, effort, models, isScoped);
		if (
			mention &&
			thinkingLevel &&
			thinkingLevel !== AUTO_THINKING &&
			thinkingLevel !== ThinkingLevel.Inherit &&
			!effort
		) {
			mention.warning = `${thinkingLevel} unsupported; effort omitted`;
		}
		return mention;
	}

	#resolveModel(
		model: Model,
		effort: Effort | undefined,
		models: ReadonlyArray<Model>,
		isScoped: boolean,
	): ResolvedModelMention | undefined {
		const identity = formatModelStringWithRouting(model);
		// Mention dispatch cannot restore routing metadata from a bare model selector.
		if (
			identity !== formatModelString(model) ||
			!models.some(candidate => formatModelString(candidate) === identity)
		) {
			return undefined;
		}
		if (effort === undefined) return { selector: identity, name: modelMentionDisplayName(model) };
		if (!getSupportedEfforts(model).includes(effort)) return undefined;
		const canonical = `${identity}:${effort}`;
		const isModelId = (candidate: Model) => formatModelString(candidate) === canonical;
		if (models.some(isModelId) || (isScoped && this.#host.modelRegistry.getAvailable().some(isModelId))) {
			return undefined;
		}
		return {
			selector: canonical,
			name: modelMentionName(modelMentionDisplayName(model), effort),
			thinkingLevel: effort,
		};
	}

	/** Register user-tagged models and replace their tokens with persisted agent tags. */
	expandMentions(text: string): string {
		if (!text.includes("^")) return text;
		return text.replace(MODEL_MENTION_RE, (token, delimiter: string, selector: string) => {
			let mention = this.#bySelector.get(selector);
			if (!mention) {
				const resolved = this.resolve(selector);
				if (!resolved) return token;
				mention = this.#bySelector.get(resolved.selector);
				if (!mention) {
					let next = 1;
					while (this.#agents.has(`m${next}`)) next++;
					mention = { agent: `m${next}`, selector: resolved.selector, name: resolved.name };
					if (resolved.thinkingLevel !== undefined) mention.thinkingLevel = resolved.thinkingLevel;
					this.#host.sessionManager.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, mention);
					this.#mentions.push(mention);
					this.#bySelector.set(mention.selector, mention);
					this.#agents.add(mention.agent);
				}
			}
			return `${delimiter}${modelMentionTag(mention)}`;
		});
	}

	/** Expose inherited and session-tagged models as general-purpose task agents. */
	sessionAgents(): AgentDefinition[] {
		const task = getBundledAgent("task");
		if (!task) throw new Error("Bundled task agent is unavailable");
		const inheritedNames = new Set(this.#inheritedAgents.map(agent => agent.name));
		return [
			...this.#inheritedAgents,
			...this.#mentions
				.filter(mention => !inheritedNames.has(mention.agent))
				.map(mention => ({
					...task,
					name: mention.agent,
					description: prompt.render(modelMentionDescription, {
						name: mention.name,
						selector: mention.selector,
						effort: mention.thinkingLevel,
					}),
					model: [mention.selector],
					thinkingLevel: mention.thinkingLevel ?? task.thinkingLevel,
					filePath: undefined,
				})),
		];
	}
}
