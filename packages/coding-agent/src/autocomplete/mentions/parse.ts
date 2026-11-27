/**
 * Lexical parser for unified mention triggers (`@`, `^`, `#<N>` / `pr #N` / `issue #N`).
 *
 * Pure and zero-I/O: inspects only the text before the caret plus optional
 * synchronous predicates (`isKnownDir`, `isKnownProvider`) to disambiguate
 * `head/tail` queries between provider-scoped models and directory-scoped files.
 */
import { getGithubRefContext } from "../github-ref";
import { extractAtFilePrefix, isExplicitFilePath, MODEL_MENTION_CONTEXT_RE } from "../tokens";
import type { MentionCategoryId, MentionQuery, MentionSubKind } from "./types";

interface NamespaceRule {
	readonly category: MentionCategoryId;
	readonly subKind?: MentionSubKind;
}

/**
 * Explicit `@<ns>:<query>` prefixes that hard-lock a single category. The
 * one-letter keys are the canonical tokens the palette inserts (`@m:`, `@h:`,
 * `@s:`, …); the long names stay as aliases.
 */
const NAMESPACE_PREFIXES: Readonly<Record<string, NamespaceRule>> = {
	m: { category: "models" },
	model: { category: "models" },
	models: { category: "models" },
	f: { category: "files" },
	file: { category: "files" },
	files: { category: "files" },
	a: { category: "agents" },
	agent: { category: "agents" },
	agents: { category: "agents" },
	peer: { category: "agents", subKind: "peer" },
	peers: { category: "agents", subKind: "peer" },
	h: { category: "sessions" },
	history: { category: "sessions" },
	session: { category: "sessions" },
	sessions: { category: "sessions" },
	chat: { category: "sessions" },
	chats: { category: "sessions" },
	conv: { category: "sessions" },
	conversation: { category: "sessions" },
	conversations: { category: "sessions" },
	g: { category: "vcs" },
	git: { category: "vcs" },
	vcs: { category: "vcs" },
	branch: { category: "vcs", subKind: "branch" },
	br: { category: "vcs", subKind: "branch" },
	commit: { category: "vcs", subKind: "commit" },
	sha: { category: "vcs", subKind: "commit" },
	tag: { category: "vcs", subKind: "tag" },
	tags: { category: "vcs", subKind: "tag" },
	diff: { category: "vcs", subKind: "diff" },
	changes: { category: "vcs", subKind: "diff" },
	r: { category: "mcp" },
	mcp: { category: "mcp" },
	resource: { category: "mcp" },
	resources: { category: "mcp" },
	s: { category: "ssh" },
	ssh: { category: "ssh" },
	host: { category: "ssh" },
	hosts: { category: "ssh" },
	gh: { category: "forge" },
	github: { category: "forge" },
	p: { category: "forge", subKind: "pr" },
	pr: { category: "forge", subKind: "pr" },
	prs: { category: "forge", subKind: "pr" },
	pull: { category: "forge", subKind: "pr" },
	i: { category: "forge", subKind: "issue" },
	issue: { category: "forge", subKind: "issue" },
	issues: { category: "forge", subKind: "issue" },
};

/** Optional synchronous hints for disambiguating `head/tail` slash tokens. */
export interface MentionParseOptions {
	readonly isKnownProvider?: (head: string) => boolean;
	readonly isKnownDir?: (head: string) => boolean;
}

const FILE_LINE_SUFFIX_RE = /^(.+)(:\d+(?:-\d*)?)$/;
const EFFORT_FRAGMENT_RE = /^[a-z]*$/i;
const HEX_SHA_LOCK_RE = /^[0-9a-f]{7,40}$/i;

function splitModelEffortSuffix(body: string): { base: string; effortSuffix?: string } {
	const colon = body.lastIndexOf(":");
	if (colon <= 0) return { base: body };
	const tail = body.slice(colon + 1);
	if (!EFFORT_FRAGMENT_RE.test(tail)) return { base: body };
	return { base: body.slice(0, colon), effortSuffix: tail.toLowerCase() };
}

/**
 * Parse a unified mention token ending at the caret, or `null` when the cursor
 * is not on a `@`, `^`, or `#<N>` mention token.
 */
export function parseMentionQuery(textBeforeCursor: string, options?: MentionParseOptions): MentionQuery | null {
	if (!textBeforeCursor) return null;

	// 1. `^model[:effort]` shortcut → unified engine locked to Models.
	const modelMatch = MODEL_MENTION_CONTEXT_RE.exec(textBeforeCursor);
	if (modelMatch) {
		const prefix = modelMatch[1]!;
		const rawBody = prefix.slice(1);
		const { base, effortSuffix } = splitModelEffortSuffix(rawBody);
		return {
			trigger: "^",
			prefix,
			rawBody,
			query: effortSuffix !== undefined ? base : rawBody,
			syntaxLock: "models",
			...(effortSuffix !== undefined ? { modelEffortSuffix: effortSuffix } : {}),
		};
	}

	// 2. `#<N>` / `pr #<N>` / `issue #<N>` shortcut → unified engine locked to GitHub.
	const ghRef = getGithubRefContext(textBeforeCursor);
	if (ghRef) {
		return {
			trigger: "#",
			prefix: ghRef.prefix,
			rawBody: ghRef.number,
			query: ghRef.number,
			syntaxLock: "forge",
			...(ghRef.qualifier ? { subKind: ghRef.qualifier } : {}),
		};
	}

	// 3. `@...` unified trigger (quoted or unquoted).
	const atPrefix = extractAtFilePrefix(textBeforeCursor);
	if (!atPrefix) return null;

	const quoted = atPrefix.startsWith('@"');
	const rawBody = quoted ? atPrefix.slice(2) : atPrefix.slice(1);
	if (quoted) {
		return {
			trigger: "@",
			prefix: atPrefix,
			rawBody,
			query: rawBody,
			syntaxLock: "files",
			quoted: true,
		};
	}

	// `@#` or `@#123` → hard-lock GitHub PR/Issue lookup.
	if (rawBody.startsWith("#")) {
		return {
			trigger: "@",
			prefix: atPrefix,
			rawBody,
			query: rawBody.slice(1),
			syntaxLock: "forge",
		};
	}

	// Explicit namespace prefix (`@m:`, `@a:`, `@f:`, `@g:`, `@h:`, `@p:`, `@i:`, `@r:`, `@s:`, `@branch:`, …).
	const firstColon = rawBody.indexOf(":");
	if (firstColon > 0) {
		const nsKey = rawBody.slice(0, firstColon).toLowerCase();
		const rule = NAMESPACE_PREFIXES[nsKey];
		if (rule) {
			const rest = rawBody.slice(firstColon + 1);
			const modelSplit = rule.category === "models" ? splitModelEffortSuffix(rest) : undefined;
			return {
				trigger: "@",
				prefix: atPrefix,
				rawBody,
				query: modelSplit?.effortSuffix !== undefined ? modelSplit.base : rest,
				syntaxLock: rule.category,
				...(rule.subKind ? { subKind: rule.subKind } : {}),
				...(modelSplit?.effortSuffix !== undefined ? { modelEffortSuffix: modelSplit.effortSuffix } : {}),
			};
		}
	}

	// Explicit filesystem path syntax (`@./`, `@../`, `@~/`, `@/`, `@C:\`).
	if (isExplicitFilePath(rawBody)) {
		const lineMatch = FILE_LINE_SUFFIX_RE.exec(rawBody);
		return {
			trigger: "@",
			prefix: atPrefix,
			rawBody,
			query: lineMatch ? lineMatch[1]! : rawBody,
			syntaxLock: "files",
			...(lineMatch ? { fileLineSuffix: lineMatch[2]! } : {}),
		};
	}

	// File path with trailing `:line` / `:start-end` (e.g. `@composer.tsx:42-80`).
	const lineMatch = FILE_LINE_SUFFIX_RE.exec(rawBody);
	if (lineMatch && (lineMatch[1]!.includes(".") || lineMatch[1]!.includes("/"))) {
		return {
			trigger: "@",
			prefix: atPrefix,
			rawBody,
			query: lineMatch[1]!,
			syntaxLock: "files",
			fileLineSuffix: lineMatch[2]!,
		};
	}

	// `head/tail` disambiguation between provider-scoped models (`anthropic/opus`) and directories (`src/ui`).
	let syntaxLock: MentionCategoryId | undefined;
	const firstSlash = rawBody.indexOf("/");
	if (firstSlash > 0) {
		const head = rawBody.slice(0, firstSlash);
		const isProvider = options?.isKnownProvider?.(head) ?? false;
		const isDir = options?.isKnownDir?.(head) ?? false;
		if (isProvider && !isDir) syntaxLock = "models";
		else if (isDir && !isProvider) syntaxLock = "files";
	} else if (HEX_SHA_LOCK_RE.test(rawBody)) {
		syntaxLock = "vcs";
	}

	// Optional `:effort` suffix on an unlocked or model-locked query (`@opus:high`).
	const effortSplit =
		syntaxLock === undefined || syntaxLock === "models" ? splitModelEffortSuffix(rawBody) : undefined;
	const modelEffortSuffix = effortSplit?.effortSuffix;

	return {
		trigger: "@",
		prefix: atPrefix,
		rawBody,
		query: modelEffortSuffix !== undefined ? effortSplit!.base : rawBody,
		...(syntaxLock ? { syntaxLock } : {}),
		...(modelEffortSuffix !== undefined ? { modelEffortSuffix } : {}),
	};
}

/** Fast zero-I/O check whether `textBeforeCursor` ends inside a unified mention token. */
export function isMentionTriggerContext(textBeforeCursor: string): boolean {
	return parseMentionQuery(textBeforeCursor) !== null;
}
