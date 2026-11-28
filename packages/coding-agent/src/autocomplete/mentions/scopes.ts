/**
 * The scopes of the mention palette's scope bar: one per category a mention can be locked to,
 * GitHub split into pull requests and issues. Files is the bare `@` pinned to files (a path
 * already says files); every other scope is its `@<namespace>:` token in the draft.
 */
import { MENTION_NAMESPACES, type MentionNamespace, type MentionNamespaceRule } from "./parse";
import { MENTION_STYLES, type MentionCategoryStyle } from "./style";
import type { MentionCategoryId, MentionQuery, MentionScopeId, MentionSubKind } from "./types";

/** One scope: how the draft names it, what it searches and how it shows. */
export interface MentionScopeDef {
	readonly id: MentionScopeId;
	/** The `@<namespace>:` token that puts a mention in it; Files has none. */
	readonly namespace?: MentionNamespace;
	readonly category: MentionCategoryId;
	/** The part of its category it narrows to (GitHub's pull requests or issues). */
	readonly subKind?: MentionSubKind;
	readonly label: string;
	/** Native icon name. */
	readonly icon: string;
	/** Theme symbol key (`mention.*`) of its glyph: its category's, Issues with their own. */
	readonly symbol: string;
}

function defineScope(
	id: MentionScopeId,
	label: string,
	icon: string,
	namespace?: MentionNamespace,
	symbol?: string,
): MentionScopeDef {
	const rule: MentionNamespaceRule = namespace ? MENTION_NAMESPACES[namespace] : { category: "files" };
	return {
		id,
		label,
		icon,
		category: rule.category,
		symbol: symbol ?? MENTION_STYLES[rule.category].symbol,
		...(namespace ? { namespace } : {}),
		...(rule.subKind ? { subKind: rule.subKind } : {}),
	};
}

/** Every scope, in the order Tab walks them. */
export const MENTION_SCOPES: readonly MentionScopeDef[] = [
	defineScope("files", "Files", "file"),
	defineScope("models", "Models", "cpu", "m"),
	defineScope("agents", "Agents", "users", "p2p"),
	defineScope("sessions", "Sessions", "message", "ses"),
	defineScope("git", "Git", "git-branch", "git"),
	defineScope("pr", "PRs", "pr", "pr"),
	defineScope("issue", "Issues", "info", "iss", "mention.issue"),
	defineScope("mcp", "MCP", "mcp", "mcp"),
	defineScope("ssh", "SSH", "host", "ssh"),
];

const BY_ID = new Map<string, MentionScopeDef>();
for (const def of MENTION_SCOPES) BY_ID.set(def.id, def);

/** Glyph and color of the scope `id`, the color its category's; `undefined` for an unknown id. */
export function mentionScopeStyle(id: string): MentionCategoryStyle | undefined {
	const def = BY_ID.get(id);
	return def && { symbol: def.symbol, color: MENTION_STYLES[def.category].color };
}

/**
 * The scope `query` is explicitly in: the one its syntax (or the files lock) names. A GitHub
 * reference that says neither kind (`#123`) counts as a pull request.
 */
export function mentionScopeOf(query: MentionQuery): MentionScopeId | undefined {
	const category = query.syntaxLock;
	if (!category) return undefined;
	for (const def of MENTION_SCOPES) {
		if (def.category !== category) continue;
		if (def.subKind === undefined || query.subKind === undefined || def.subKind === query.subKind) return def.id;
	}
	return undefined;
}

/** The draft token of a mention in `scope` (none: unscoped) with `typed` after it. */
export function mentionScopeToken(scope: MentionScopeId | undefined, typed: string): string {
	const namespace = scope && BY_ID.get(scope)?.namespace;
	return namespace ? `@${namespace}:${typed}` : `@${typed}`;
}
