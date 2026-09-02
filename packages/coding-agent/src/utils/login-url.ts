import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sliceWithWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

const FILE_PREFIX = "login-url-";
const STALE_MS = 24 * 60 * 60 * 1000;

let flowCounter = 0;

// One chain for every write this process issues: `persistLoginUrl` appends,
// `loginUrlWritesSettled` awaits. Flows are rare and the payload is one line,
// so serializing them costs nothing.
let pendingWrites: Promise<void> = Promise.resolve();

/**
 * Start persisting the authorization URL to a per-flow file and return that
 * file's path immediately.
 *
 * This is the byte-exact copy path that depends on nothing the terminal may or
 * may not support. A multi-row URL selected out of a full-screen frame carries
 * row breaks and padding, which corrupt `state` and `code_challenge` when the
 * result is pasted into a browser; OSC 52 clipboard writes and OSC 8 hyperlinks
 * are byte-exact but optional terminal features. Reading a short path that fits
 * one row works everywhere, including over SSH.
 *
 * The write itself is fire-and-forget: every caller sits inside an OAuth
 * `onAuth` callback on the render path, and a slow or network-backed agent dir
 * must not stall the frame that shows the URL. The path is deterministic (pid
 * plus an in-process counter), so the advertised command is correct before the
 * write lands; the write is done long before a human can copy and run it. A
 * failed write is logged, and the advertised `cat`/`type` then reports the
 * missing file — the URL itself is still on screen either way.
 *
 * Per-flow filename: two omp processes with concurrent OAuth flows would
 * otherwise overwrite each other, and a second flow in the same process would
 * repoint the first panel's advertised command at a URL whose `state` no
 * longer matches. Files from dead processes are removed once they are a day
 * old. Mode 600: the URL carries only public OAuth parameters, but there is
 * no reason to share them.
 */
export function persistLoginUrl(url: string): string {
	const dir = getAgentDir();
	const file = path.join(dir, `${FILE_PREFIX}${process.pid}-${++flowCounter}.txt`);
	pendingWrites = pendingWrites.then(() => writeAndSweep(dir, file, url));
	return file;
}

/** Resolves once every write issued by `persistLoginUrl` so far has settled. */
export function loginUrlWritesSettled(): Promise<void> {
	return pendingWrites;
}

async function writeAndSweep(dir: string, file: string, url: string): Promise<void> {
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(file, `${url}\n`, { mode: 0o600 });
	} catch (error) {
		logger.warn("Failed to persist login URL", {
			path: file,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	// Best-effort sweep of siblings left by dead processes.
	try {
		for (const name of await fs.readdir(dir)) {
			if (!name.startsWith(FILE_PREFIX) || !name.endsWith(".txt") || name === path.basename(file)) continue;
			const sibling = path.join(dir, name);
			try {
				if (Date.now() - (await fs.stat(sibling)).mtimeMs > STALE_MS) await fs.unlink(sibling);
			} catch {
				// A sibling that vanished mid-sweep or cannot be statted is not our problem.
			}
		}
	} catch {
		// The write above succeeded; a failed sweep must not cost the copy path.
	}
}

/**
 * The command a user runs to print the persisted URL, portable to the shell
 * they are actually in.
 *
 * win32 renders `type` (cmd.exe built-in, also a PowerShell alias) with tiered
 * quoting. A path of shell-inert characters is left bare, which both shells
 * read identically. A path whose only offending characters are literal inside
 * double quotes on both shells (spaces and the like — none of % ! $ ` ") is
 * double-quoted: cmd and PowerShell both parse that as one argument and
 * neither expands anything inside it. Anything carrying an expandable is
 * PowerShell single-quoted with embedded quotes doubled: single quotes stop
 * `$()`, backticks, and `%`/`!` expansion there. cmd.exe cannot render such a
 * path literally at all — `%VAR%` (and `!x!` under delayed expansion)
 * substitutes before quote parsing, so no quoting suppresses it — so that
 * tier targets PowerShell, the modern Windows default shell.
 *
 * POSIX renders `cat` with the home prefix shortened to `~`, which must stay
 * outside quotes to expand, so the path is unquoted only when every character
 * is shell-inert. Anything else is single-quoted with embedded quotes escaped,
 * keeping `~/` outside the quotes when present so it still expands: unlike
 * double quotes, single quotes stop `$()` and backtick substitution, so a
 * hostile PI_CODING_AGENT_DIR cannot execute through the advertised command.
 */
export function loginUrlCopyCommand(filePath: string): string {
	if (process.platform === "win32") {
		if (/^[\w.:\\/-]+$/.test(filePath)) return `type ${filePath}`;
		if (!/[%!$`"]/.test(filePath)) return `type "${filePath}"`;
		return `type '${filePath.replaceAll("'", "''")}'`;
	}
	const home = os.homedir();
	const display = filePath.startsWith(`${home}/`) ? `~${filePath.slice(home.length)}` : filePath;
	if (/^[\w@%+=:,./~-]+$/.test(display)) return `cat ${display}`;
	const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
	if (display.startsWith("~/")) return `cat ~/${quoted(display.slice(2))}`;
	return `cat ${quoted(filePath)}`;
}

/**
 * Split a rendered row into rows of at most `width` columns without losing a
 * byte. `wrapTextWithAnsi` word-wraps and swallows the space at each break
 * point; in a copy command every character is load-bearing (a swallowed space
 * displays a path that does not exist), so the row breaks by column instead —
 * exactly how a spaceless URL wraps through `wrapTextWithAnsi`. ANSI state is
 * reopened per row by `sliceWithWidth`.
 */
export function wrapCommandRow(row: string, width: number): string[] {
	const total = visibleWidth(row);
	if (width <= 0 || total <= width) return [row];
	const rows: string[] = [];
	let col = 0;
	while (col < total) {
		const strict = sliceWithWidth(row, col, width, true);
		// Strict refuses a grapheme wider than the whole budget; the non-strict
		// one-column overshoot beats dropping the grapheme or looping forever.
		const slice = strict.width > 0 ? strict : sliceWithWidth(row, col, width);
		if (slice.width <= 0) break;
		rows.push(slice.text);
		col += slice.width;
	}
	return rows;
}
