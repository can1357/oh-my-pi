/**
 * Dependency-free `^model` mention syntax shared by the composer, message
 * rendering, and the session registry. Kept apart from `model-mentions.ts` so
 * the startup composer prepaint graph never loads the catalog or task agents.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

/** Whitespace-delimited token; groups are leading delimiter and selector. Reset lastIndex before reuse. */
export const MODEL_MENTION_RE = /(^|\s)\^([^\s^]+)(?=\s|$)/g;

/**
 * Resolve a whitespace-delimited mention while preserving prose punctuation.
 * Full selectors win, including ids that themselves end in punctuation.
 */
export function resolveModelMentionToken<T>(
	token: string,
	resolve: (selector: string) => T | undefined,
	isKnown?: (selector: string) => boolean,
): { value: T; suffix: string } | undefined {
	const value = resolve(token);
	if (value !== undefined) return { value, suffix: "" };
	// A known exact selector whose chip label is taken must stay literal;
	// stripping punctuation here would collapse a different model's chip.
	if (isKnown?.(token)) return undefined;
	let end = token.length;
	while (end > 0 && ".,;:!?".includes(token[end - 1]!)) {
		end--;
		const selector = token.slice(0, end);
		const resolved = resolve(selector);
		if (resolved !== undefined) return { value: resolved, suffix: token.slice(end) };
	}
	return undefined;
}
/** Submitted mention; groups are agent pseudonym and display name. */
export const MODEL_MENTION_TAG_RE = /<model agent="(m\d+)" name="([^"]*)"\/>/g;

/** A user-tagged model usable as a subagent pseudonym on the current session branch. */
export interface ModelMention {
	agent: string;
	/** Canonical selector: `provider/id`, plus `:<effort>` when the tag names one. */
	selector: string;
	name: string;
	/** Initial effort from the tag's `:<level>` suffix; absent keeps the agent's default policy. */
	thinkingLevel?: Effort;
}

export type ResolvedModelMention = Omit<ModelMention, "agent"> & { warning?: string };

/** Expand a composer atom back into its editable model or role token. */
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

/** Display name of a mention, naming the tagged effort so tags of one model stay distinct. */
export function modelMentionName(displayName: string, thinkingLevel: Effort): string {
	return `${displayName} · ${thinkingLevel}`;
}

/** Restore known submitted tags to editable selectors; leave unknown agents literal. */
export function expandModelMentionTags(text: string, selectorFor: (agent: string) => string | undefined): string {
	return text.replace(MODEL_MENTION_TAG_RE, (tag, agent: string) => {
		const selector = selectorFor(agent);
		return selector === undefined ? tag : modelMentionToken(selector);
	});
}
