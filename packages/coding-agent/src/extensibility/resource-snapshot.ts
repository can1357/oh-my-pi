/** Bounded local resource evidence; deliberately independent of model/configuration initialization. */
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import { redactMemorySecrets } from "../memory-backend/redact";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ResourceCandidate {
	id: string;
	label: string;
	kind: "skill" | "extension";
	root: string;
	entrypoint?: string;
}

export interface ResourceSnapshot {
	candidate: ResourceCandidate;
	/** Hash of the raw file bytes/modes and the tree-derived omissions. Independent of id, label and entrypoint. */
	fingerprint: string;
	files: { path: string; content: string }[];
	omissions: string[];
	/** False when anything that could carry behaviour was not shown to the model in full. */
	complete: boolean;
}

export const MAX_FILES = 40;
const MAX_FILE_BYTES = 40 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024;
const MAX_SCAN_ENTRIES = 2000;
const MAX_DEPTH = 8;
const MAX_OMISSIONS = 200;
const FINGERPRINT_VERSION = 1;
// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

/**
 * Names that carry credentials; never read, never sent, never named in the omission note (the name
 * itself can identify an account). Omitted as material: the file could hide code.
 */
const CREDENTIAL_FILE =
	/^(?:\.env(?:\..*)?|\.envrc|\.(?:npmrc|yarnrc(?:\.yml)?|netrc|pypirc|pgpass|htpasswd|dockercfg|vault-token)|_netrc|htpasswd|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*(?:credential|secret|service[-_]?account|kubeconfig).*|(?:.*[-_.])?tokens?\.(?:json|ya?ml|toml|txt|ini)|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|tfstate|tfvars|token))$/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY|AGE-SECRET-KEY-1[0-9A-Z]{20,}/;

const REDACTED = "[REDACTED]";
/** A key name (camelCase split, lower-cased) whose value is treated as a secret. */
const SECRET_KEY =
	/secret|token|passw(?:or)?d|passphrase|pwd|credential|bearer|cookie|api[-_.]?key|access[-_.]?key|private[-_.]?key|(?:^|[-_.])(?:pass|pw|auth|oauth|authorization)(?:$|[-_.])|[-_.]key$/;
/**
 * `key = value`, `key: value`, `"key": value`, `key := value`, `'key' => value`, or `--flag value`.
 * Only the key and separator are matched here; the value is measured by {@link valueEnd}. Key length
 * is capped so scanning stays linear.
 */
const ASSIGNMENT = /--([A-Za-z][\w.-]{0,63})[ \t]+(?=[^\s-])|([A-Za-z_][\w.-]{0,63})(["']?)[ \t]*(?::=|=>|[:=])[ \t]*/g;
const QUOTED: Record<string, RegExp> = {
	'"': /"(?:[^"\\]|\\[\s\S]){0,4096}"/y,
	"'": /'(?:[^']|''){0,4096}'/y,
	"`": /`[^`]{0,4096}`/y,
};
/** An unquoted value runs to the end of the line, or to the quote that closes the string it sits in. */
const UNQUOTED: Record<string, RegExp> = {
	"": /[^\r\n]*/y,
	'"': /(?:[^"\\\r\n]|\\[^\r\n])*/y,
	"'": /[^'\r\n]*/y,
	"`": /[^`\r\n]*/y,
};
const SHELL_WORD = /\S+/y;
/** Nothing else inline: the value is a YAML block scalar, an opening bracket, or on the following lines. */
const BLOCK_START = /[ \t]*(?:[|>][+-]?\d?|[{[])?[ \t]*(?=\r?$)/my;
/** `scheme://user:password@host`. Over-matches to the last `@` of the chunk rather than leave residue. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]{1,31}:\/\/)[^\s/?#@:"'`<>]*:[^\s"'`<>]*@/gi;

/** The quote character left open between `from` and `to` ("" when none). */
function openQuote(text: string, from: number, to: number): string {
	let open = "";
	for (let i = from; i < to; i++) {
		const c = text[i]!;
		if (c === "\\" && open !== "'") i++;
		else if (open === "") {
			if (c === '"' || c === "'" || c === "`") open = c;
		} else if (c === open) open = "";
	}
	return open;
}

/** End of the value that starts at `start`. A quoted value that never closes falls back to the line. */
function valueEnd(text: string, start: number, enclosing: string, flag: boolean): number {
	// The key sat inside a string that ends here (`echo "Password: "`), so there is no value.
	if (enclosing !== "" && text[start] === enclosing) return start;
	const quoted = QUOTED[text[start] ?? ""];
	if (quoted) {
		quoted.lastIndex = start;
		const match = quoted.exec(text);
		if (match) return start + match[0].length;
	}
	const unquoted = flag ? SHELL_WORD : UNQUOTED[enclosing]!;
	unquoted.lastIndex = start;
	return start + unquoted.exec(text)![0].length;
}

/** End of the lines after `from` that are indented deeper than `keyIndent` (blank lines inside included). */
function blockEnd(text: string, from: number, keyIndent: number): number {
	let end = from;
	let lineStart = text.indexOf("\n", from) + 1;
	while (lineStart > 0 && lineStart <= text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = text.length;
		let i = lineStart;
		while (text[i] === " " || text[i] === "\t") i++;
		if (i < lineEnd && text[i] !== "\r") {
			if (i - lineStart <= keyIndent) break;
			end = lineEnd;
		}
		lineStart = lineEnd + 1;
	}
	return end;
}

/**
 * Replace the value of every assignment whose key names a secret. Redaction errs toward more: an
 * unquoted value takes the rest of its line, a quoted one the whole string, and a value that starts
 * on the next line takes the lines indented under the key.
 */
function redactSecretAssignments(text: string): string {
	let out = "";
	let copied = 0;
	for (const match of text.matchAll(ASSIGNMENT)) {
		const index = match.index;
		if (index < copied) continue;
		const flag = match[1] !== undefined;
		if (!SECRET_KEY.test((match[1] ?? match[2]!).replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase())) continue;
		const start = index + match[0].length;
		const lineStart = text.lastIndexOf("\n", index - 1) + 1;
		// A quoted key's own opening quote does not enclose its value.
		const keyEnd = !flag && match[3] !== "" && text[index - 1] === match[3] ? index - 1 : index;
		let end = valueEnd(text, start, openQuote(text, lineStart, keyEnd), flag);
		BLOCK_START.lastIndex = start;
		if (!flag && BLOCK_START.test(text)) {
			let indentEnd = lineStart;
			while (text[indentEnd] === " " || text[indentEnd] === "\t") indentEnd++;
			end = blockEnd(text, end, indentEnd - lineStart);
		}
		if (end <= start) continue;
		out += text.slice(copied, start) + REDACTED;
		copied = end;
	}
	return copied === 0 ? text : out + text.slice(copied);
}

/**
 * What a snapshot is allowed to send. The generic token redactor catches provider-prefixed tokens;
 * this adds key-aware assignments and URL credentials. Neither is a promise that every secret is
 * recognised: an unlabelled secret in prose or code looks like any other string.
 */
function redactSnapshotSecrets(text: string): string {
	return redactSecretAssignments(redactMemorySecrets(text)).replace(URL_USERINFO, `$1${REDACTED}@`);
}

// ---------------------------------------------------------------------------------------------
// Code that is not in the snapshot
// ---------------------------------------------------------------------------------------------

const CODE_FILE = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|py|rb|pl|ps1|bat|cmd|lua|go|rs|php)$/i;
const MANIFEST_FILE = /^(?:skill\.md|package\.json|plugin\.json|hooks\.json)$/i;

const UNSEEN_OUTSIDE = "imports code outside the resource root";
const UNSEEN_PACKAGE = "depends on a package that was not inspected";
const UNSEEN_DYNAMIC = "loads code that cannot be resolved statically";
const UNSEEN_UNANALYZED = "code dependencies not analyzed";

/** Runtime imports only: Bun's scanner drops `import type` and type-only named imports. */
const SCANNERS = {
	ts: new Bun.Transpiler({ loader: "ts" }),
	tsx: new Bun.Transpiler({ loader: "tsx" }),
	js: new Bun.Transpiler({ loader: "js" }),
	jsx: new Bun.Transpiler({ loader: "jsx" }),
};
/** Packages the host supplies to every extension (see legacy-pi-compat), not files on this disk. */
const HOST_PACKAGE =
	/^(?:@(?:oh-my-pi|mariozechner|earendil-works)\/pi-(?:agent-core|ai|catalog|coding-agent|natives|tui|utils)(?:\/.*)?|@sinclair\/typebox|typebox)$/;
/** `import(` / `require(` whose first argument is not a complete string literal; the scanner skips these. */
const NONLITERAL_LOAD = /(?<![.\w$])(?:import|require)\s*\(\s*(?!(?:"[^"\\\n]*"|'[^'\\\n]*'|`[^`$\\]*`)\s*[,)])/;
const SHELL_COMMAND = String.raw`(?:^|[;&|({]|\b(?:then|do|else)\b)[ \t]*`;
const SHELL_SOURCE = new RegExp(`${SHELL_COMMAND}(?:source|\\.)[ \\t]+["']?([^\\s;&|)"']+)`, "gm");
const SHELL_DYNAMIC = new RegExp(
	String.raw`${SHELL_COMMAND}eval\b|\|[ \t]*(?:sudo[ \t]+)?(?:\S*/)?(?:ba|z|da|k)?sh\b|<\([ \t]*(?:curl|wget)\b`,
	"m",
);
const PYTHON_IMPORT =
	/(?:^|[;:])[ \t]*(?:from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]+([^\n#;]+)|import[ \t]+([^\n#;]+))/gm;
const PYTHON_DYNAMIC =
	/(?<![.\w])(?:__import__|exec|eval|execfile)\s*\(|\b(?:importlib|runpy)\b|\bsys\.path\b|\bsite\.addsitedir\b/;
// Standard-library top-level modules. Anything not listed counts as an external package, so a gap
// here makes a snapshot incomplete rather than wrongly complete.
const PYTHON_STDLIB = new Set(
	`__future__ _thread abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cgi cmath cmd code codecs collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap modulefinder multiprocessing netrc numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pydoc queue quopri random re readline reprlib resource rlcompleter sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string struct subprocess sys sysconfig syslog tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser xml xmlrpc zipapp zipfile zipimport zlib zoneinfo`.split(
		" ",
	),
);

type Language = "ts" | "tsx" | "js" | "jsx" | "shell" | "python" | "other";

/** By extension, else by shebang. `undefined`: not code the snapshot can vouch for or against. */
function codeLanguage(rel: string, text: string): Language | undefined {
	const ext = /\.([a-z]+)$/i.exec(rel)?.[1]?.toLowerCase();
	switch (ext) {
		case "ts":
		case "mts":
		case "cts":
			return "ts";
		case "tsx":
			return "tsx";
		case "js":
		case "mjs":
		case "cjs":
			return "js";
		case "jsx":
			return "jsx";
		case "sh":
		case "bash":
		case "zsh":
			return "shell";
		case "py":
			return "python";
		default:
			if (CODE_FILE.test(rel)) return "other";
	}
	const shebang = /^#![^\n]*/.exec(text)?.[0];
	if (shebang === undefined) return undefined;
	if (/\b(?:ba|z|da|k)?sh\b/.test(shebang)) return "shell";
	if (/\bpython[\d.]*\b/.test(shebang)) return "python";
	return /\b(?:node|bun|deno)\b/.test(shebang) ? "js" : "other";
}

const unseen = (what: string, rel: string, detail?: string): string =>
	`${what}: ${rel}${detail === undefined ? "" : ` -> ${redactSnapshotSecrets(detail).slice(0, 80)}`}`;

/** Why a JS/TS runtime import is not covered by the snapshot, if it is not. */
function importProblem(specifier: string, dir: string, rootIsFile: boolean): string | undefined {
	if (/^\.{1,2}(?:\/|$)/.test(specifier)) {
		// Inside the root, whatever it reaches was captured or recorded as an omission already.
		const target = path.posix.join(dir, specifier);
		return rootIsFile || target === ".." || target.startsWith("../") ? UNSEEN_OUTSIDE : undefined;
	}
	if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return undefined;
	if (/^(?:[/\\~#]|[A-Za-z][A-Za-z0-9+.-]*:)/.test(specifier)) return UNSEEN_OUTSIDE;
	if (builtinModules.includes(specifier) || HOST_PACKAGE.test(specifier)) return undefined;
	return UNSEEN_PACKAGE;
}

function jsUnseen(rel: string, text: string, loader: keyof typeof SCANNERS, dir: string, rootIsFile: boolean): string {
	let imports: { path: string }[];
	try {
		imports = SCANNERS[loader].scanImports(text);
	} catch {
		return unseen(UNSEEN_UNANALYZED, rel);
	}
	for (const { path: specifier } of imports) {
		const problem = importProblem(specifier, dir, rootIsFile);
		if (problem !== undefined) return unseen(problem, rel, specifier);
	}
	return NONLITERAL_LOAD.test(text) ? unseen(UNSEEN_DYNAMIC, rel) : "";
}

function shellUnseen(rel: string, text: string, dir: string, rootIsFile: boolean): string {
	for (const match of text.matchAll(SHELL_SOURCE)) {
		const target = match[1]!;
		const resolved = path.posix.join(dir, target);
		if (rootIsFile || /^[/~$`(]/.test(target) || resolved === ".." || resolved.startsWith("../")) {
			return unseen(UNSEEN_OUTSIDE, rel, target);
		}
	}
	return SHELL_DYNAMIC.test(text) ? unseen(UNSEEN_DYNAMIC, rel) : "";
}

function pythonUnseen(rel: string, text: string, local: ReadonlySet<string>, rootIsFile: boolean): string {
	if (PYTHON_DYNAMIC.test(text) || /^\s*(?:from[^\n]+import|import)[^\n]*(?:\\\s*$|\(\s*$)/m.test(text)) {
		return unseen(UNSEEN_DYNAMIC, rel);
	}
	const dir = path.posix.dirname(rel);
	for (const match of text.matchAll(PYTHON_IMPORT)) {
		const dots = match[1] ?? "";
		const names = match[4] !== undefined ? match[4].split(",") : match[2] ? [match[2]] : match[3]!.split(",");
		const base = dots ? path.posix.join(dir, "../".repeat(Math.max(0, dots.length - 1))) : dir;
		if (dots && (base === ".." || base.startsWith("../"))) return unseen(UNSEEN_OUTSIDE, rel);
		for (const item of names) {
			const name = item.trim().split(/\s+/)[0]!;
			const top = name.split(".")[0]!;
			if (!/^[A-Za-z_][\w.]*$/.test(name)) return unseen(UNSEEN_DYNAMIC, rel);
			if (!dots && PYTHON_STDLIB.has(top)) continue;
			const modulePath = name.replaceAll(".", "/");
			const locations = dots ? [path.posix.join(base, modulePath)] : [path.posix.join(dir, modulePath), modulePath];
			if (
				rootIsFile ||
				!locations.some(location => local.has(`${location}.py`) || local.has(`${location}/__init__.py`))
			) {
				return unseen(UNSEEN_PACKAGE, rel, top);
			}
		}
	}
	return "";
}

/**
 * Omission note for the first way this file's behaviour depends on code the snapshot does not hold,
 * or "" when it does not. Covers runtime JS/TS imports, shell `source`, and Python imports; any
 * other code language is reported as not analyzed. Programs a script merely runs (`git`, `curl`,
 * `subprocess`) are outside this check: they are not part of any resource.
 */
function unseenCode(rel: string, text: string, rootIsFile: boolean, local: ReadonlySet<string>): string {
	const language = codeLanguage(rel, text);
	const dir = rootIsFile ? "." : path.posix.dirname(rel);
	switch (language) {
		case undefined:
			return "";
		case "shell":
			return shellUnseen(rel, text, dir, rootIsFile);
		case "python":
			return pythonUnseen(rel, text, local, rootIsFile);
		case "other":
			return unseen(UNSEEN_UNANALYZED, rel);
		default:
			return jsUnseen(rel, text, language, dir, rootIsFile);
	}
}

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

function assertCandidate(candidate: ResourceCandidate): void {
	const valid =
		typeof candidate === "object" &&
		candidate !== null &&
		typeof candidate.id === "string" &&
		candidate.id !== "" &&
		typeof candidate.label === "string" &&
		(candidate.kind === "skill" || candidate.kind === "extension") &&
		typeof candidate.root === "string" &&
		candidate.root !== "" &&
		(candidate.entrypoint === undefined || typeof candidate.entrypoint === "string");
	if (!valid) throw new TypeError("Invalid resource candidate");
}

/** Instructions first, then code that runs, then everything else; ties broken by path. */
function readPriority(rel: string): number {
	if (MANIFEST_FILE.test(rel)) return 0;
	return CODE_FILE.test(rel) ? 1 : 2;
}

type FileRead = { ok: true; text: string; sha: string; exec: boolean } | { ok: false; reason: string };

/**
 * Read one regular file through a single bounded handle. Linux validates the
 * opened descriptor's actual path, so swapping an ancestor for a symlink cannot
 * redirect captured content outside the resource. Other platforms verify the
 * resolved path and descriptor identity again before accepting its contents.
 */
async function readBoundedFile(abs: string, rel: string, root: string): Promise<FileRead> {
	let handle: FileHandle | undefined;
	try {
		const expectedPath = await fs.realpath(abs);
		if (!pathIsWithin(root, expectedPath)) return { ok: false, reason: `path escapes resource root: ${rel}` };
		handle = await fs.open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const stat = await handle.stat();
		const openedPath =
			process.platform === "linux" ? await fs.realpath(`/proc/self/fd/${handle.fd}`) : await fs.realpath(abs);
		if (openedPath !== expectedPath || !pathIsWithin(root, openedPath)) {
			return { ok: false, reason: `path changed while opening: ${rel}` };
		}
		if (!stat.isFile()) return { ok: false, reason: `special file not read: ${rel}` };
		if (stat.size > MAX_FILE_BYTES) {
			return { ok: false, reason: `too large: ${rel} (${stat.size} bytes; limit ${MAX_FILE_BYTES})` };
		}
		const buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		const currentPath = await fs.realpath(abs);
		const current = await fs.stat(abs);
		if (
			length > stat.size ||
			length > MAX_FILE_BYTES ||
			after.size !== stat.size ||
			after.mtimeMs !== stat.mtimeMs ||
			after.ctimeMs !== stat.ctimeMs ||
			currentPath !== expectedPath ||
			current.dev !== stat.dev ||
			current.ino !== stat.ino
		)
			return { ok: false, reason: `changed while reading: ${rel}` };
		const bytes = buffer.subarray(0, length);
		const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		let text: string | undefined;
		if (!bytes.includes(0)) {
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				// Not UTF-8: treated as binary below.
			}
		}
		if (text === undefined) {
			return { ok: false, reason: `binary file not shown: ${rel} (${length} bytes, sha256 ${sha.slice(0, 16)})` };
		}
		return { ok: true, text, sha, exec: (stat.mode & 0o111) !== 0 };
	} catch {
		return { ok: false, reason: `unreadable: ${rel}` };
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Snapshot a resource without executing it or leaving its root.
 *
 * Symlinks are never followed, `.git` and `node_modules` are never entered, credential-shaped
 * filenames are never read or named, private-key content is never included, known secret shapes and
 * the values of secret-named keys are redacted, and file count, size, depth and scan breadth are
 * capped. Anything skipped is listed in `omissions`; every skip except `.git` also makes `complete`
 * false. So do redactions, and code whose dependencies the snapshot does not hold (see
 * {@link unseenCode}).
 *
 * ponytail: secret detection is pattern-based and cannot be exhaustive; `complete` says nothing
 * about it. Dependency coverage stops at the file level, with no module graph walk.
 */
export async function snapshotResource(candidate: ResourceCandidate): Promise<ResourceSnapshot> {
	assertCandidate(candidate);
	const omissions: string[] = [];
	let incomplete = false;
	const omit = (text: string): void => {
		omissions.push(text);
		incomplete = true;
	};
	const files: { path: string; content: string; sha: string; exec: boolean }[] = [];

	let realRoot: string | undefined;
	let rootIsFile = false;
	let rootSize = 0;
	try {
		realRoot = await fs.realpath(candidate.root);
		const rootStat = await fs.stat(realRoot);
		rootIsFile = rootStat.isFile();
		rootSize = rootStat.size;
	} catch {
		omit("resource root is not readable");
	}

	if (realRoot !== undefined) {
		const found: { rel: string; abs: string; size: number }[] = [];
		let scanned = 0;
		let stopped = false;
		const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
			let names: string[];
			try {
				names = (await fs.readdir(absDir)).sort(byCodeUnit);
			} catch {
				omit(`directory not readable: ${relDir || "."}/`);
				return;
			}
			for (const name of names) {
				if (scanned >= MAX_SCAN_ENTRIES) {
					omit(`scan limit reached (${MAX_SCAN_ENTRIES} entries); remaining entries not inspected`);
					stopped = true;
					return;
				}
				scanned++;
				const rel = relDir ? `${relDir}/${name}` : name;
				// Version-control metadata is never run; installed dependencies are, so skipping them is a gap.
				if (name === ".git") {
					omissions.push(`${rel} not inspected (version-control metadata)`);
					continue;
				}
				if (name === "node_modules") {
					omit(`${rel} not inspected (installed dependencies)`);
					continue;
				}
				// Every path below this point is echoed to the model, so a secret-shaped name stops here.
				if (redactSnapshotSecrets(name) !== name) {
					omit("entry with a secret-like name not inspected");
					continue;
				}
				const abs = path.join(absDir, name);
				let stat: Stats;
				try {
					stat = await fs.lstat(abs);
				} catch {
					omit(`unreadable: ${rel}`);
					continue;
				}
				if (stat.isSymbolicLink()) {
					omit(`symlink not followed: ${rel}`);
				} else if (stat.isDirectory()) {
					if (depth >= MAX_DEPTH) omit(`depth limit (${MAX_DEPTH}) reached: ${rel}/ not inspected`);
					else await walk(abs, rel, depth + 1);
					if (stopped) return;
				} else if (!stat.isFile()) {
					omit(`special file not read: ${rel}`);
				} else {
					found.push({ rel, abs, size: stat.size });
				}
			}
		};
		if (rootIsFile) {
			const fileName = path.basename(realRoot);
			if (redactSnapshotSecrets(fileName) !== fileName) omit("entry with a secret-like name not inspected");
			else found.push({ rel: fileName, abs: realRoot, size: rootSize });
		} else await walk(realRoot, "", 0);

		// Only actual Python module/package paths count; documentation stems and unrelated directories do not.
		const localModules = new Set(found.map(({ rel }) => rel));
		const ordered = found.sort((a, b) => readPriority(a.rel) - readPriority(b.rel) || byCodeUnit(a.rel, b.rel));
		let total = 0;
		for (const file of ordered) {
			if (CREDENTIAL_FILE.test(path.basename(file.rel))) {
				omit("credential-like file not read");
			} else if (file.size > MAX_FILE_BYTES) {
				omit(`too large: ${file.rel} (${file.size} bytes; limit ${MAX_FILE_BYTES})`);
			} else if (files.length >= MAX_FILES || total + file.size > MAX_TOTAL_BYTES) {
				omit(`size budget exceeded: ${file.rel} (${file.size} bytes)`);
			} else {
				const read = await readBoundedFile(file.abs, file.rel, realRoot);
				if (!read.ok) {
					omit(read.reason);
				} else if (PRIVATE_KEY_BLOCK.test(read.text)) {
					omit(`private key material not included: ${file.rel}`);
				} else {
					const content = redactSnapshotSecrets(read.text);
					if (content !== read.text) omit(`secret-like values redacted: ${file.rel}`);
					const dependency = unseenCode(file.rel, read.text, rootIsFile, localModules);
					if (dependency !== "") omit(dependency);
					total += Buffer.byteLength(read.text);
					files.push({ path: file.rel, content, sha: read.sha, exec: read.exec });
				}
			}
		}
	}

	// Fingerprint: raw bytes and modes of what was read, plus every tree-derived omission. Nothing about
	// the candidate (id, label, entrypoint spelling) or its root path, so loaders that rebuild a
	// candidate for the same files get the same value.
	const sortedOmissions = [...omissions].sort(byCodeUnit);
	const fingerprint = new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify({
				v: FINGERPRINT_VERSION,
				files: files.map(f => [f.path, f.sha, f.exec] as const).sort((a, b) => byCodeUnit(a[0], b[0])),
				omissions: sortedOmissions,
			}),
		)
		.digest("hex");

	// The entrypoint is a hint about what to run. It must resolve inside the root to a captured file;
	// otherwise coverage is not established. Reported but kept out of the fingerprint above.
	const entrypointNotes: string[] = [];
	if (candidate.entrypoint !== undefined && realRoot !== undefined) {
		const base = rootIsFile ? path.dirname(candidate.root) : candidate.root;
		try {
			const entry = await fs.realpath(path.resolve(base, candidate.entrypoint));
			if (!pathIsWithin(realRoot, entry)) {
				entrypointNotes.push("entrypoint resolves outside the resource root");
			} else if ((await fs.stat(entry)).isFile()) {
				const rel = rootIsFile ? path.basename(realRoot) : path.relative(realRoot, entry).split(path.sep).join("/");
				if (!files.some(f => f.path === rel)) entrypointNotes.push("entrypoint file was not captured");
			}
		} catch {
			entrypointNotes.push("entrypoint is not readable");
		}
	}

	const all = [...sortedOmissions, ...entrypointNotes];
	const shown =
		all.length > MAX_OMISSIONS ? [...all.slice(0, MAX_OMISSIONS), `… and ${all.length - MAX_OMISSIONS} more`] : all;
	return {
		candidate: { ...candidate },
		fingerprint,
		files: files.map(({ path: filePath, content }) => ({ path: filePath, content })),
		omissions: shown,
		complete: !incomplete && entrypointNotes.length === 0,
	};
}
