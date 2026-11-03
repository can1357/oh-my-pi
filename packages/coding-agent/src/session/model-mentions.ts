import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import modelMentionDescription from "../prompts/agents/model-mention.md" with { type: "text" };
import { getBundledAgent } from "../task/agents";
import type { AgentDefinition } from "../task/types";
import {
	MODEL_MENTION_RE,
	type ModelMention,
	modelMentionDisplayName,
	modelMentionName,
	modelMentionTag,
} from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import { AUTO_THINKING, parseEffort } from "@oh-my-pi/pi-tui/thinking";
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

/** A `^` selector resolved within the session picker's model scope. */
export type ResolvedModelMention = Omit<ModelMention, "agent">;

/** Session capabilities needed to authorize and persist model mentions. */
export interface ModelMentionHost {
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
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
	 * Resolve `provider/id[:level]` within the session picker's model scope. Exact ids win:
	 * some contain colons (`qwen3:8b`) or end in a level name (`glm-4.7:max`). A level
	 * spelling whose canonical selector is another model's id (`:ma` beside a literal
	 * `…:max`) stays unresolved, since dispatch would run that other model.
	 */
	resolve(selector: string): ResolvedModelMention | undefined {
		const scoped = this.#host.scopedModels();
		const models = scoped.length > 0 ? scoped : this.#host.modelRegistry.getAvailable();
		const exact = models.find(model => formatModelString(model) === selector);
		if (exact) return { selector, name: modelMentionDisplayName(exact) };
		const colon = selector.lastIndexOf(":");
		if (colon <= 0) return undefined;
		const base = selector.slice(0, colon);
		const model = models.find(candidate => formatModelString(candidate) === base);
		if (!model) return undefined;
		const suffix = selector.slice(colon + 1);
		if (suffix === AUTO_THINKING) return { selector: base, name: modelMentionDisplayName(model) };
		const effort = parseEffort(suffix);
		if (effort === undefined || !getSupportedEfforts(model).includes(effort)) return undefined;
		const canonical = `${base}:${effort}`;
		const isModelId = (candidate: Model) => formatModelString(candidate) === canonical;
		if (models.some(isModelId) || (scoped.length > 0 && this.#host.modelRegistry.getAvailable().some(isModelId))) {
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
					mention = { agent: `m${next}`, ...resolved };
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
