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

/** Explicit category prefixes in palette order. */
export const MENTION_NAMESPACES = {
	m: { category: "models" },
	p2p: { category: "agents" },
	ses: { category: "sessions" },
	git: { category: "vcs" },
	pr: { category: "forge", subKind: "pr" },
	iss: { category: "forge", subKind: "issue" },
	mcp: { category: "mcp" },
	ssh: { category: "ssh" },
} as const satisfies Readonly<Record<string, NamespaceRule>>;

export type MentionNamespace = keyof typeof MENTION_NAMESPACES;

function isMentionNamespace(key: string): key is MentionNamespace {
	return Object.hasOwn(MENTION_NAMESPACES, key);
}

function vcsSubKind(key: string): MentionSubKind | undefined {
	switch (key) {
		case "branch":
		case "commit":
		case "tag":
		case "diff":
			return key;
	}
}

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

	// Explicit category tokens take precedence over provider and path inference.
	const firstColon = rawBody.indexOf(":");
	if (firstColon > 0) {
		const nsKey = rawBody.slice(0, firstColon).toLowerCase();
		if (isMentionNamespace(nsKey)) {
			const rule: NamespaceRule = MENTION_NAMESPACES[nsKey];
			let rest = rawBody.slice(firstColon + 1);
			let subKind = rule.subKind;
			if (rule.category === "vcs") {
				const colon = rest.indexOf(":");
				if (colon > 0) {
					subKind = vcsSubKind(rest.slice(0, colon).toLowerCase());
					if (subKind) rest = rest.slice(colon + 1);
				}
			}
			const modelSplit = rule.category === "models" ? splitModelEffortSuffix(rest) : undefined;
			return {
				trigger: "@",
				prefix: atPrefix,
				rawBody,
				query: modelSplit?.effortSuffix !== undefined ? modelSplit.base : rest,
				syntaxLock: rule.category,
				...(subKind ? { subKind } : {}),
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
