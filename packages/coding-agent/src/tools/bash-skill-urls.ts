import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { InternalUrlRouter } from "../internal-urls";
import { UrlContainmentError } from "../internal-urls/filesystem-resource";
import { extractUriScheme, normalizeLocalScheme } from "../internal-urls/parse";
import type { ResolveContext } from "../internal-urls/types";

// Candidate `scheme://…` tokens (quoted or bare), plus the single-slash
// `scheme:/…` spelling normalized below. Bare tokens stop before shell syntax
// so expansion cannot quote an adjacent operator or substitution into the
// resolved path; the bare single-slash form only starts at a token boundary so
// it never matches inside a filesystem path or a longer word.
const INTERNAL_URL_TOKEN_PATTERN =
	/'[a-z][a-z0-9+.-]*:\/[^'\s")`\\]+'|"[a-z][a-z0-9+.-]*:\/[^"\s')`\\]+"|[a-z][a-z0-9+.-]*:\/\/[^\s'")`\\;&|<>($]+|(?<![./\\\w-])[a-z][a-z0-9+.-]*:\/(?!\/)[^\s'")`\\;&|<>($]+/gi;

export interface InternalUrlExpansionOptions {
	/** Calling session's resolve context, handed to every scheme's `locate`. */
	context: ResolveContext;
	/** Substitute raw paths instead of shell-escaped ones (e.g. for a cwd value). */
	noEscape?: boolean;
	/**
	 * Operands may be write targets: missing entries of mutable schemes locate to
	 * their would-be path and get their parent directory created.
	 */
	create?: boolean;
	/** Locate the directory form where a scheme distinguishes it (a bare skill URL → its base dir). */
	directory?: boolean;
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

function isInsideShellQuote(command: string, index: number): boolean {
	type ShellQuote = "'" | '"' | undefined;
	interface CommandSubstitution {
		/** `$(` … `)` tracks paren depth; `` ` `` … `` ` `` is a plain toggle. */
		kind: "dollar" | "backtick";
		outerQuote: ShellQuote;
		depth: number;
	}

	let quote: ShellQuote;
	const substitutions: CommandSubstitution[] = [];
	for (let i = 0; i < index; i++) {
		const char = command[i];
		// Inside a backtick substitution nested in double quotes, bash treats `\"`
		// as a quote delimiter for the inner command, not as an escaped literal.
		if (
			char === "\\" &&
			command[i + 1] === '"' &&
			quote !== "'" &&
			substitutions.at(-1)?.kind === "backtick" &&
			substitutions.at(-1)?.outerQuote === '"'
		) {
			quote = quote === '"' ? undefined : '"';
			i++;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (char === "'" && quote !== '"') {
			quote = quote === "'" ? undefined : "'";
			continue;
		}
		if (char === '"' && quote !== "'") {
			quote = quote === '"' ? undefined : '"';
			continue;
		}
		if (char === "$" && command[i + 1] === "(" && quote !== "'") {
			substitutions.push({ kind: "dollar", outerQuote: quote, depth: 1 });
			quote = undefined;
			i++;
			continue;
		}
		if (char === "`" && quote !== "'") {
			const top = substitutions.at(-1);
			if (top?.kind === "backtick") {
				substitutions.pop();
				quote = top.outerQuote;
			} else {
				substitutions.push({ kind: "backtick", outerQuote: quote, depth: 0 });
				quote = undefined;
			}
			continue;
		}
		if (quote !== undefined) continue;

		const substitution = substitutions.at(-1);
		if (substitution?.kind !== "dollar") continue;
		if (char === "(") {
			substitution.depth++;
		} else if (char === ")") {
			substitution.depth--;
			if (substitution.depth === 0) {
				quote = substitutions.pop()?.outerQuote;
			}
		}
	}
	return quote !== undefined;
}

function isEmbeddedInQuotedText(command: string, token: string, index: number): boolean {
	if (token.startsWith("'") || token.startsWith('"')) return false;
	return isInsideShellQuote(command, index);
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * Local path backing a router URL, or null to leave the token for the shell.
 * Only mutable schemes create missing targets: immutable backings (skill
 * packages, artifacts) are never written into. Root-containment violations
 * fail closed instead of leaving the token for the shell, which would read it
 * as a relative path.
 */
async function locateOperand(
	router: InternalUrlRouter,
	url: string,
	options: InternalUrlExpansionOptions,
): Promise<string | null> {
	const scheme = extractUriScheme(url);
	const create = options.create === true && scheme !== undefined && router.spec(scheme)?.immutable === false;
	try {
		const located = await router.locate(url, options.context, { directory: options.directory, create });
		if (located !== null && create) {
			await fs.mkdir(path.dirname(located), { recursive: true });
		}
		return located;
	} catch (error) {
		if (error instanceof UrlContainmentError) throw new ToolError(error.message);
		return null;
	}
}

/**
 * Expand locatable internal URLs in a bash command string to shell-escaped absolute paths.
 * Unlocatable URLs and literal mentions inside larger quoted text are left unchanged;
 * containment violations throw.
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes(":/")) return command;

	const router = InternalUrlRouter.instance();
	const matches = Array.from(command.matchAll(INTERNAL_URL_TOKEN_PATTERN));
	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		if (isEmbeddedInQuotedText(command, token, index)) continue;

		const url = normalizeLocalScheme(unquoteToken(token));
		if (!router.canHandle(url)) continue;
		const resolvedPath = await locateOperand(router, url, options);
		if (resolvedPath === null) continue;
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
