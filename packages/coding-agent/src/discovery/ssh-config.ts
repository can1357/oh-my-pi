/**
 * OpenSSH Config Provider
 *
 * Lists the concrete `Host` aliases in `~/.ssh/config` and `/etc/ssh/ssh_config`
 * (following `Include`), so `ssh://` and `/ssh list` show the hosts OpenSSH
 * already knows. Each entry carries only the alias (`host === name`): OpenSSH
 * resolves it at connect time with the user's full config (HostName, User, Port,
 * IdentityFile, ProxyJump, …), which a partial parse here could not reproduce.
 * Wildcard/negated patterns and `Match` blocks name no single host and are skipped.
 * Priority: 3 (below `ssh-json`, whose explicit entries win on a name clash)
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { LoadContext, LoadResult } from "../capability/types";
import { expandTilde } from "../tools/path-utils";
import { createSourceMeta } from "./helpers";

const PROVIDER_ID = "ssh-config";
const DISPLAY_NAME = "OpenSSH Config";
const SYSTEM_CONFIG = "/etc/ssh/ssh_config";
/** OpenSSH's `READCONF_MAX_DEPTH`: how deep `Include` may nest. */
const MAX_INCLUDE_DEPTH = 16;
/** `Keyword args`, `Keyword=args`, or `Keyword = args`; comment and blank lines do not match. */
const DIRECTIVE = /^\s*([A-Za-z]+)\s*=?\s*(.*)$/;
/** One directive argument: double-quoted, single-quoted, or bare. */
const ARGUMENT = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
const GLOB_CHARS = /[*?[]/;

/** State shared while walking one root config and its includes. */
interface Scan {
	home: string;
	/** Directory relative `Include` paths resolve against: `~/.ssh` or `/etc/ssh`, never the including file's. */
	baseDir: string;
	hosts: Map<string, SSHHost>;
	visited: Set<string>;
	warnings: string[];
}

/** Directive arguments, unquoted; an unquoted `#` token starts a trailing comment. */
function splitArgs(rest: string): string[] {
	const args: string[] = [];
	for (const [, doubleQuoted, singleQuoted, bare] of rest.matchAll(ARGUMENT)) {
		if (bare?.startsWith("#")) break;
		args.push(doubleQuoted ?? singleQuoted ?? bare ?? "");
	}
	return args;
}

/** Files an `Include` argument names, sorted like OpenSSH's glob(3) expansion. */
async function resolveInclude(arg: string, scan: Scan): Promise<string[]> {
	const file = path.resolve(scan.baseDir, expandTilde(arg, scan.home));
	if (!GLOB_CHARS.test(file)) return [file];
	const segments = file.split(path.sep);
	const firstGlob = segments.findIndex(segment => GLOB_CHARS.test(segment));
	const root = segments.slice(0, firstGlob).join(path.sep) || path.sep;
	const glob = new Bun.Glob(segments.slice(firstGlob).join("/"));
	try {
		const matches = await Array.fromAsync(glob.scan({ cwd: root, absolute: true, followSymlinks: true }));
		return matches.sort();
	} catch {
		return [];
	}
}

/** Collect `Host` aliases from `file` in config order, descending into `Include`d files in place. */
async function scanFile(file: string, depth: number, scan: Scan): Promise<void> {
	if (scan.visited.has(file)) return;
	scan.visited.add(file);
	const content = await readFile(file);
	if (content === null) return;
	const source = createSourceMeta(PROVIDER_ID, file, "user");
	for (const line of content.split(/\r?\n/)) {
		const directive = DIRECTIVE.exec(line);
		if (!directive) continue;
		const keyword = directive[1].toLowerCase();
		if (keyword === "host") {
			for (const name of splitArgs(directive[2])) {
				// Negated (`!bastion`) and wildcard (`*.corp`, `db?`) patterns name no single destination.
				if (name.startsWith("!") || /[*?]/.test(name) || scan.hosts.has(name)) continue;
				scan.hosts.set(name, { name, host: name, _source: source });
			}
		} else if (keyword === "include") {
			if (depth >= MAX_INCLUDE_DEPTH) {
				scan.warnings.push(`Include nested deeper than ${MAX_INCLUDE_DEPTH} levels in ${file}`);
				continue;
			}
			for (const arg of splitArgs(directive[2])) {
				for (const included of await resolveInclude(arg, scan)) await scanFile(included, depth + 1, scan);
			}
		}
	}
}

async function load(ctx: LoadContext): Promise<LoadResult<SSHHost>> {
	const hosts = new Map<string, SSHHost>();
	const visited = new Set<string>();
	const warnings: string[] = [];
	const userDir = path.join(ctx.home, ".ssh");
	// OpenSSH reads the user config before the system one; the first definition of a name wins.
	for (const [file, baseDir] of [
		[path.join(userDir, "config"), userDir],
		[SYSTEM_CONFIG, path.dirname(SYSTEM_CONFIG)],
	]) {
		await scanFile(file, 0, { home: ctx.home, baseDir, hosts, visited, warnings });
	}
	return { items: [...hosts.values()], warnings: warnings.length > 0 ? warnings : undefined };
}

registerProvider(sshCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load SSH host aliases from ~/.ssh/config and /etc/ssh/ssh_config",
	priority: 3,
	load,
});
