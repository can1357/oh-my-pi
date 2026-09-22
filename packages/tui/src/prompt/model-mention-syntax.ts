/**
 * Dependency-free `^model` mention syntax shared by the composer, message
 * rendering, and the session registry. Kept apart from `model-mentions.ts` so
 * the startup composer prepaint graph never loads the catalog or task agents.
 */
import type { Model } from "@oh-my-pi/pi-ai";

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
