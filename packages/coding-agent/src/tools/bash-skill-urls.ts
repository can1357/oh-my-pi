import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { InternalUrlRouter } from "../internal-urls";
import { extractUriScheme } from "../internal-urls/parse";
import type { ResolveContext } from "../internal-urls/types";

// Candidate `scheme://…` tokens (quoted or bare), plus the single-slash
// `scheme:/…` spelling normalized below. Bare tokens stop before shell syntax
// so expansion cannot quote an adjacent operator or substitution into the
// resolved path; the bare single-slash form only starts at a token boundary so
// it never matches inside a filesystem path or a longer word.
const INTERNAL_URL_TOKEN_PATTERN =
	/'[a-z][a-z0-9+.-]*:\/[^'\s")`\\]+'|"[a-z][a-z0-9+.-]*:\/[^"\s')`\\]+"|[a-z][a-z0-9+.-]*:\/\/[^\s'")`\\;&|<>($]+|(?<![./\\\w-])[a-z][a-z0-9+.-]*:\/(?!\/)[^\s'")`\\;&|<>($]+/gi;

// A heredoc operator and its delimiter word (`<<EOF`, `<<-'EOF'`, `<< "END"`), matched at a `<<`.
const HEREDOC_OPERATOR_RE = /<<(-?)[ \t]*((?:[^\s;&|<>()'"\\]|\\.|'[^']*'|"[^"]*")+)/y;

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

/** Offset range `[start, end)` of shell text that is data, not operands ({@link shellDataRanges}). */
interface DataRange {
	start: number;
	end: number;
}

/** Whether `index` sits inside quotes; data ranges are skipped, so a heredoc's `it's` opens no quote. */
function isInsideShellQuote(command: string, index: number, dataRanges: readonly DataRange[]): boolean {
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
		const data = dataRanges.find(range => range.start === i);
		if (data) {
			i = data.end - 1;
			continue;
		}
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

function isEmbeddedInQuotedText(
	command: string,
	token: string,
	index: number,
	dataRanges: readonly DataRange[],
): boolean {
	if (token.startsWith("'") || token.startsWith('"')) return false;
	return isInsideShellQuote(command, index, dataRanges);
}

/**
 * Offset ranges `[start, end)` of `command` that are data, not operands: heredoc bodies
 * (through their delimiter line) and `#` comments. URL mentions there are never expanded,
 * so a heredoc writing a note that cites `artifact://99` passes through verbatim. `<<`
 * inside quotes, here-strings (`<<<`), and arithmetic (`$((1<<2))`) open no heredoc.
 */
function shellDataRanges(command: string): DataRange[] {
	const ranges: DataRange[] = [];
	const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
	let quote: "'" | '"' | undefined;
	let arithmetic = 0;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote === "'") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (char === "\\") {
			i++;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
		} else if (char === "(" && command[i + 1] === "(") {
			arithmetic++;
			i++;
		} else if (char === ")" && command[i + 1] === ")" && arithmetic > 0) {
			arithmetic--;
			i++;
		} else if (char === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) {
			const newline = command.indexOf("\n", i);
			const end = newline === -1 ? command.length : newline;
			ranges.push({ start: i, end });
			// Resume at the newline so a pending heredoc body still starts there.
			i = end - 1;
		} else if (command.startsWith("<<<", i)) {
			i += 2;
		} else if (char === "<" && command[i + 1] === "<" && arithmetic === 0) {
			HEREDOC_OPERATOR_RE.lastIndex = i;
			const operator = HEREDOC_OPERATOR_RE.exec(command);
			if (!operator) continue;
			pending.push({ delimiter: operator[2].replace(/['"\\]/g, ""), stripTabs: operator[1] === "-" });
			i = HEREDOC_OPERATOR_RE.lastIndex - 1;
		} else if (char === "\n" && pending.length > 0) {
			// Bodies follow the operator line back to back, each through its delimiter line.
			let position = i + 1;
			for (const { delimiter, stripTabs } of pending) {
				while (position < command.length) {
					const newline = command.indexOf("\n", position);
					const lineEnd = newline === -1 ? command.length : newline;
					const line = command.slice(position, lineEnd);
					position = lineEnd + 1;
					if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
				}
			}
			ranges.push({ start: i + 1, end: Math.min(position, command.length) });
			pending.length = 0;
			i = position - 1;
		}
	}
	return ranges;
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * Local path backing a shell-operand URL ({@link SchemeSpec.shellOperand}); null for other
 * schemes, which stay for the shell. A shell operand never reaches the shell raw (it would
 * read `scheme:/…` as a relative path), so a line selector (bash addresses whole files), a
 * missing target, and a locate failure throw ToolError. Only mutable schemes create missing
 * targets: immutable backings (skill packages, artifacts) are never written into.
 */
async function locateOperand(
	router: InternalUrlRouter,
	token: string,
	options: InternalUrlExpansionOptions,
): Promise<string | null> {
	const scheme = extractUriScheme(token);
	const spec = scheme === undefined ? undefined : router.spec(scheme);
	if (!spec?.shellOperand) return null;
	const url = router.peelWriteSelector(token, "bash");
	const create = options.create === true && !spec.immutable;
	let located: string | null;
	try {
		located = await router.locate(url, options.context, { directory: options.directory, create });
	} catch (error) {
		if (options.context.signal?.aborted || error instanceof ToolError) throw error;
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	if (located === null) throw new ToolError(`${url} does not exist as a local file`);
	if (create) await fs.mkdir(path.dirname(located), { recursive: true });
	return located;
}

/**
 * Expand shell-operand internal URLs ({@link SchemeSpec.shellOperand}) in a bash command
 * string to shell-escaped absolute paths. Other schemes, literal mentions inside larger
 * quoted text, heredoc bodies, and comments are left unchanged; a shell operand that cannot
 * be located throws ({@link locateOperand}).
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes(":/")) return command;

	const router = InternalUrlRouter.instance();
	const matches = Array.from(command.matchAll(INTERNAL_URL_TOKEN_PATTERN));
	if (matches.length === 0) return command;
	const dataRanges = shellDataRanges(command);
	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		if (dataRanges.some(range => index >= range.start && index < range.end)) continue;
		if (isEmbeddedInQuotedText(command, token, index, dataRanges)) continue;

		const url = router.normalize(unquoteToken(token));
		if (!router.canHandle(url)) continue;
		const resolvedPath = await locateOperand(router, url, options);
		if (resolvedPath === null) continue;
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
