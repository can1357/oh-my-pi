import type { Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
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
	/** Authenticated models after the session's enabledModels allow-list. */
	availableModels(): readonly Model[];
	scopedModels(): ReadonlyArray<Model>;
	/** Live parent agents, preserving picker scope and availability in nested delegation. */
	inheritedAgents?: () => readonly AgentDefinition[];
}

/** Owns branch-local model pseudonyms and automatic model agents. */
export class ModelMentionRegistry {
	readonly #host: ModelMentionHost;
	#mentions: ModelMention[] = [];
	readonly #bySelector = new Map<string, ModelMention>();
	readonly #agents = new Set<string>();
	readonly #modelAgents = new WeakMap<Model, AgentDefinition>();
	readonly #inheritedMentions: readonly AgentDefinition[];

	constructor(host: ModelMentionHost) {
		this.#host = host;
		// Branch-local aliases must not be rebound by later tags or rewinds in the parent.
		this.#inheritedMentions = host.inheritedAgents?.().filter(agent => !agent.modelAgent) ?? [];
		for (const agent of this.#inheritedMentions) this.#agents.add(agent.name);
	}

	/** Rebuild pseudonyms after resume, rewind, or a session switch. */
	syncFromBranch(): void {
		this.#mentions = readModelMentions(this.#host.sessionManager.getBranch());
		this.#bySelector.clear();
		this.#agents.clear();
		for (const agent of this.#inheritedMentions) this.#agents.add(agent.name);
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
		if (scoped.length > 0 && !scoped.some(model => formatModelString(model) === selector)) return undefined;
		return this.#host.availableModels().find(model => formatModelString(model) === selector);
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

	/** Expose inherited tags, live parent model agents, local tags, then root model agents. */
	sessionAgents(): AgentDefinition[] {
		const task = getBundledAgent("task");
		if (!task) throw new Error("Bundled task agent is unavailable");
		const inherited = this.#host.inheritedAgents?.();
		const agents: AgentDefinition[] = [...this.#inheritedMentions];
		if (inherited) {
			for (const agent of inherited) {
				if (agent.modelAgent) agents.push(agent);
			}
		}
		const names = new Set(agents.map(agent => agent.name));
		for (const mention of this.#mentions) {
			if (names.has(mention.agent)) continue;
			names.add(mention.agent);
			agents.push({
				...task,
				name: mention.agent,
				description: prompt.render(modelMentionDescription, {
					name: mention.name,
					selector: mention.selector,
					tagged: true,
				}),
				model: [mention.selector],
				filePath: undefined,
			});
		}
		// Children inherit the live parent pool instead of widening to their unscoped registry.
		if (inherited) return agents;
		const scoped = this.#host.scopedModels();
		const scopedSelectors = scoped.length > 0 ? new Set(scoped.map(formatModelString)) : undefined;
		for (const model of this.#host.availableModels()) {
			if (modelKind(model) !== "chat" || model.supportsTools === false) continue;
			const selector = formatModelString(model);
			if (scopedSelectors && !scopedSelectors.has(selector)) continue;
			let agent = this.#modelAgents.get(model);
			if (!agent) {
				agent = {
					...task,
					name: selector,
					description: prompt.render(modelMentionDescription, { name: modelMentionDisplayName(model), selector }),
					model: [selector],
					filePath: undefined,
					modelAgent: true,
				};
				this.#modelAgents.set(model, agent);
			}
			if (names.has(agent.name)) continue;
			names.add(agent.name);
			agents.push(agent);
		}
		return agents;
	}
}
