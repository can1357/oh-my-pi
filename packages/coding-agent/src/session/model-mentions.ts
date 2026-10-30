import type { Model } from "@oh-my-pi/pi-ai";
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
	modelMentionTag,
} from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
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
		const { agent, selector, name } = entry.data;
		if (
			typeof agent !== "string" ||
			!/^m\d+$/.test(agent) ||
			typeof selector !== "string" ||
			typeof name !== "string"
		)
			continue;
		if (agents.has(agent) || selectors.has(selector)) continue;
		agents.add(agent);
		selectors.add(selector);
		mentions.push({ agent, selector, name });
	}
	return mentions;
}

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

	/** Resolve an exact selector within the same model scope as the session picker. */
	findMentionable(selector: string): Model | undefined {
		const scoped = this.#host.scopedModels();
		const models = scoped.length > 0 ? scoped : this.#host.modelRegistry.getAvailable();
		return models.find(model => formatModelString(model) === selector);
	}

	/** Register user-tagged models and replace their tokens with persisted agent tags. */
	expandMentions(text: string): string {
		if (!text.includes("^")) return text;
		return text.replace(MODEL_MENTION_RE, (token, delimiter: string, selector: string) => {
			let mention = this.#bySelector.get(selector);
			if (!mention) {
				const model = this.findMentionable(selector);
				if (!model) return token;
				let next = 1;
				while (this.#agents.has(`m${next}`)) next++;
				mention = { agent: `m${next}`, selector, name: modelMentionDisplayName(model) };
				this.#host.sessionManager.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, mention);
				this.#mentions.push(mention);
				this.#bySelector.set(selector, mention);
				this.#agents.add(mention.agent);
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
					description: prompt.render(modelMentionDescription, { name: mention.name, selector: mention.selector }),
					model: [mention.selector],
					filePath: undefined,
				})),
		];
	}
}
