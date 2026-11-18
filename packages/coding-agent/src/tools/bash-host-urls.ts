/**
 * Internal URLs in a command a host shell runs.
 *
 * The embedded shell opens `local://…`, `skill://…` and the other file-backed
 * schemes itself and hands the programs it spawns the files they alias
 * (`crates/pi-shell/src/host/urls.rs`); a named service and a pty command run
 * in that shell too, as a process of their own. Only a client terminal (ACP)
 * runs a command under a shell omp does not provide, which knows none of the
 * schemes. {@link hostCommandUrls} gives such a command the same result: every
 * word naming a URL the session backs with a file is rewritten to that file
 * before the shell sees it, under the rules the embedded shell applies to an
 * external's arguments. Everything else is left exactly as written.
 */
import * as fs from "node:fs/promises";
import { ShellFsOp } from "@oh-my-pi/pi-natives";
import { isCmdShell } from "@oh-my-pi/pi-utils/procmgr";
import type { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import { lexShellCommand } from "./shell-tokenize";

/** The host path backing `url`, or `undefined` when nothing backs it or it cannot be resolved. */
export type UrlBacking = (url: string) => Promise<string | undefined>;

/** {@link UrlBacking} over a session's URL filesystem, within its tier. */
export function urlBacking(filesystem: InternalUrlFilesystem): UrlBacking {
	return async url => {
		const answer = await filesystem.handle({ op: ShellFsOp.BackingPath, path: url });
		return answer.error ? undefined : answer.path;
	};
}

/** `scheme://`, as the shell's filesystem spells a URL path (a drive letter is no scheme). */
const URL_ROOT = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;
/** An unquoted redirection operator attached to its target (`<local://in`, `2>>local://log`). */
const REDIRECT = /^\d*(?:<>|>>|<|>)/;
/** `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`: a here-document and its delimiter. */
const HEREDOC = /(?<!<)<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;
const WORD_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;
const GLOB_RUN = /([*?[\]{}]+)/;

/** Whether `url` names nothing below its scheme: a bare root, or one followed by words. */
function namesNothing(url: string): boolean {
	const rest = url.replace(URL_ROOT, "").replace(/^\/+/, "");
	return rest.replace(/\/+$/, "") === "" || /^\s/.test(rest);
}

/**
 * Where the URL a word hands a program starts: at its beginning, or after what attaches it to an
 * option: a name and `=` (`--index=skill://x/data`, `FILE=local://in`), a short option letter
 * (`-olocal://out`), and then an `@` for "the contents of" (`@local://body.json`, `body=@local://b.md`).
 */
function urlStart(text: string): number | undefined {
	if (URL_ROOT.test(text)) return 0;
	const eq = text.indexOf("=");
	let at = 0;
	if (eq >= 0 && !text.slice(0, eq).includes("://")) at = eq + 1;
	else if (/^-[A-Za-z]/.test(text)) at = 2;
	if (text[at] === "@") at++;
	return URL_ROOT.test(text.slice(at)) ? at : undefined;
}

/** Whether `word` names the `omp` program, by any path. */
function isOmp(word: string): boolean {
	const name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase();
	return name === "omp" || name === "omp.exe";
}

/** `text` as one literal shell word. */
function quoteWord(text: string, cmd: boolean): string {
	if (text === "" || WORD_SAFE.test(text)) return text;
	return cmd ? `"${text}"` : `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * `lead` and the file `host` that `url` resolved to, as one shell word. With `live`, the URL was
 * written unquoted: a pattern in its last segments (`local://logs/*.txt`) is still the shell's to expand.
 */
function spellWord(lead: string, host: string, url: string, cmd: boolean, live: boolean): string {
	const glob = live ? url.search(/[*?[\]{}]/) : -1;
	const pattern = glob < 0 ? "" : url.slice(url.lastIndexOf("/", glob) + 1);
	if (pattern === "" || !host.endsWith(pattern)) return quoteWord(lead + host, cmd);
	const spelled = pattern
		.split(GLOB_RUN)
		.map((part, index) => (index % 2 === 1 ? part : quoteWord(part, cmd)))
		.join("");
	return quoteWord(lead + host.slice(0, host.length - pattern.length), cmd) + spelled;
}

/** The end of the `$(` substitution opened just before `start` in `text`: the index of its `)`, or -1. */
function substitutionEnd(text: string, start: number): number {
	let depth = 1;
	let quote = "";
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") i++;
		else if (quote) {
			if (ch === quote) quote = "";
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	return -1;
}

class HostUrls {
	readonly #backing: UrlBacking;
	readonly #cmd: boolean;
	readonly #resolved = new Map<string, Promise<string | undefined>>();

	constructor(backing: UrlBacking, cmd: boolean) {
		this.#backing = backing;
		this.#cmd = cmd;
	}

	/** `command` with here-document bodies, which are input rather than command text, left alone. */
	async command(command: string): Promise<string> {
		if (!command.includes("://")) return command;
		const out: string[] = [];
		const pending: { delimiter: string; tabs: boolean }[] = [];
		let code: string[] = [];
		const flush = async () => {
			if (code.length > 0) out.push(await this.#code(code.join("\n")));
			code = [];
		};
		for (const line of command.split("\n")) {
			const open = pending[0];
			if (open) {
				out.push(line);
				if ((open.tabs ? line.replace(/^\t+/, "") : line) === open.delimiter) pending.shift();
				continue;
			}
			code.push(line);
			for (const match of line.matchAll(HEREDOC)) {
				pending.push({ delimiter: match[2] ?? match[3] ?? match[4], tabs: match[1] === "-" });
			}
			if (pending.length > 0) await flush();
		}
		await flush();
		return out.join("\n");
	}

	/** Command text without here-document bodies, word by word. */
	async #code(text: string): Promise<string> {
		if (!text.includes("://")) return text;
		let out = "";
		// `omp` resolves the URLs it is given itself (`omp read skill://x:1-20`): once a command
		// names it ahead of any URL, the rest of that command is its own.
		let omp = false;
		let sawUrl = false;
		for (const token of lexShellCommand(text)) {
			if (token.kind === "separator") {
				if (/[\n;&|()]/.test(token.raw)) {
					omp = false;
					sawUrl = false;
				}
				out += token.raw;
				continue;
			}
			if (!token.value.includes("://")) {
				omp ||= !sawUrl && isOmp(token.value);
				out += token.raw;
				continue;
			}
			sawUrl = true;
			out += omp ? token.raw : await this.#word(token.raw, token.value);
		}
		return out;
	}

	/** One word naming a URL: its spelling with the URL's file in place, or as written. */
	async #word(raw: string, value: string): Promise<string> {
		if (raw.includes("$(")) return this.#substitutions(raw);
		// Any other expansion decides the word's text only once the shell runs it.
		if (/[$`]/.test(raw)) return raw;
		const redirect = REDIRECT.exec(raw)?.[0] ?? "";
		const operand = value.slice(redirect.length);
		const at = urlStart(operand);
		if (at === undefined) return raw;
		const url = operand.slice(at);
		if (namesNothing(url)) return raw;
		const host = await this.#host(url);
		if (host === undefined) return raw;
		// Words after a URL make it message text, unless a file has exactly that name.
		if (/\s/.test(url) && !(await fs.lstat(host).then(Boolean, () => false))) return raw;
		return redirect + spellWord(operand.slice(0, at), host, url, this.#cmd, raw.endsWith(url));
	}

	/** A word holding `$(…)`: outside single quotes, each substitution is a command of its own. */
	async #substitutions(raw: string): Promise<string> {
		let out = "";
		let quote = "";
		for (let i = 0; i < raw.length; i++) {
			const ch = raw[i];
			if (quote === "'") {
				if (ch === "'") quote = "";
			} else if (ch === "\\") {
				out += raw.slice(i, i + 2);
				i++;
				continue;
			} else if (ch === '"') {
				quote = quote ? "" : '"';
			} else if (ch === "'" && !quote) {
				quote = "'";
			} else if (ch === "$" && raw[i + 1] === "(" && raw[i + 2] !== "(") {
				const end = substitutionEnd(raw, i + 2);
				if (end >= 0) {
					out += `$(${await this.#code(raw.slice(i + 2, end))})`;
					i = end;
					continue;
				}
			}
			out += ch;
		}
		return out;
	}

	#host(url: string): Promise<string | undefined> {
		let host = this.#resolved.get(url);
		if (!host) {
			host = this.#backing(url).catch(() => undefined);
			this.#resolved.set(url, host);
		}
		return host;
	}
}

/**
 * `command` as `shell` should run it: every word naming a URL that `backing` resolves is rewritten
 * to the host file, attached options, redirections, variable assignments and `$(…)` included.
 * `omp` commands, here-document bodies, message text, and URLs nothing backs stay as written.
 */
export function hostCommandUrls(command: string, backing: UrlBacking, shell?: string): Promise<string> {
	return new HostUrls(backing, shell !== undefined && isCmdShell(shell)).command(command);
}
