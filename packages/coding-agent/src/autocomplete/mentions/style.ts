/**
 * How each mention category looks wherever one is drawn: palette rows, the
 * terminal scope strip, and draft chips share its glyph and color.
 */
import { MENTION_CATEGORY_ORDER, type MentionCategoryId } from "./types";

/** The theme glyph and color of one mention category. */
export interface MentionCategoryStyle {
	/** Theme symbol key (`mention.*`). */
	readonly symbol: string;
	/** Theme color key. */
	readonly color: string;
}

/** Glyph and color of every mention category. */
export const MENTION_STYLES: Readonly<Record<MentionCategoryId, MentionCategoryStyle>> = {
	files: { symbol: "mention.file", color: "statusLinePath" },
	models: { symbol: "mention.model", color: "statusLineModel" },
	agents: { symbol: "mention.agent", color: "statusLineSubagents" },
	sessions: { symbol: "mention.session", color: "customMessageLabel" },
	vcs: { symbol: "mention.git", color: "statusLineGitClean" },
	forge: { symbol: "mention.pr", color: "success" },
	mcp: { symbol: "mention.mcp", color: "syntaxType" },
	ssh: { symbol: "mention.ssh", color: "mdLink" },
};

const BY_ID = new Map<string, MentionCategoryStyle>();
for (const id of MENTION_CATEGORY_ORDER) BY_ID.set(id, MENTION_STYLES[id]);

/** The style of a scope id that names a mention category; `undefined` for `all` and unknown ids. */
export function mentionStyle(id: string): MentionCategoryStyle | undefined {
	return BY_ID.get(id);
}
