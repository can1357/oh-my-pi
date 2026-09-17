import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import modelMentionDescription from "../prompts/agents/model-mention.md" with { type: "text" };
import { getBundledAgent } from "../task/agents";
import type { AgentDefinition } from "../task/types";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Journal entry identifying a model the user authorized for delegation. */
export const MODEL_MENTION_ENTRY_TYPE = "model_mention";
/** Whitespace-delimited token; groups are leading delimiter and selector. Reset lastIndex before reuse. */
export const MODEL_MENTION_RE = /(^|\s)\^([^\s^]+)(?=\s|$)/g;
/** Submitted mention; groups are agent pseudonym and display name. */
export const MODEL_MENTION_TAG_RE = /<model agent="(m\d+)" name="([^"]*)"\/>/g;

/** A user-tagged model usable as a subagent pseudonym on the current session branch. */
export interface ModelMention {
	agent: string;
	selector: string;
	name: string;
}

/** Expand a composer atom back into its canonical model selector. */
export function modelMentionToken(selector: string): string {
	return `^${selector}`;
}

/** Encode a registered mention for the user message sent to the model. */
export function modelMentionTag(mention: ModelMention): string {
	return `<model agent="${mention.agent}" name="${mention.name}"/>`;
}

/** Use the catalog display name, without quotes, or the id when the name is empty. */
export function modelMentionDisplayName(model: Model): string {
	return (model.name.trim() || model.id).replaceAll('"', "");
}

/** Restore known submitted tags to editable selectors; leave unknown agents literal. */
export function expandModelMentionTags(text: string, selectorFor: (agent: string) => string | undefined): string {
	return text.replace(MODEL_MENTION_TAG_RE, (tag, agent: string) => {
		const selector = selectorFor(agent);
		return selector === undefined ? tag : modelMentionToken(selector);
	});
}

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
}

/** Owns branch-local pseudonyms for models explicitly tagged by the user. */
export class ModelMentionRegistry {
	readonly #host: ModelMentionHost;
	#mentions: ModelMention[] = [];
	readonly #bySelector = new Map<string, ModelMention>();
	readonly #agents = new Set<string>();

	constructor(host: ModelMentionHost) {
		this.#host = host;
	}

	/** Rebuild pseudonyms after resume, rewind, or a session switch. */
	syncFromBranch(): void {
		this.#mentions = readModelMentions(this.#host.sessionManager.getBranch());
		this.#bySelector.clear();
		this.#agents.clear();
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

	/** Expose tagged models as general-purpose task agents without changing the bundled template. */
	sessionAgents(): AgentDefinition[] {
		const task = getBundledAgent("task");
		if (!task) throw new Error("Bundled task agent is unavailable");
		return this.#mentions.map(mention => ({
			...task,
			name: mention.agent,
			description: prompt.render(modelMentionDescription, { name: mention.name, selector: mention.selector }),
			model: [mention.selector],
			filePath: undefined,
		}));
	}
}
