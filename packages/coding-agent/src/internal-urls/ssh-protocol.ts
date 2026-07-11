/**
 * Protocol handler for `ssh://host/path` URLs.
 *
 * Resolves a remote text file or directory listing on a pre-configured SSH host — or any
 * destination OpenSSH can resolve itself (e.g. a `~/.ssh/config` alias) — for
 * the read, search, and write tools, reusing the shared ControlMaster
 * connection in `../ssh/connection-manager`.
 *
 * A remote path resolves to a UTF-8 text file (≤ 1 MiB) or, when it is a
 * directory, a one-level listing. Binary/non-UTF-8 or oversized files are
 * rejected with an explicit error. This handler exposes no `sourcePath`;
 * directory listings carry `isDirectory` so `search` refuses to grep the
 * listing text instead of the directory's real contents.
 *
 * `loadCapability` is imported from `../capability` (not the `../discovery`
 * barrel) on purpose — pulling the barrel here would route
 * `path-utils -> internal-urls -> ssh-protocol -> discovery -> path-utils` and
 * eager-load every provider on any `path-utils` import. Runtime bootstraps the
 * SSH provider via `import "./discovery"` (sdk.ts) / `initializeWithSettings`
 * (main.ts) before any tool resolves.
 */
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { SSHConnectionTarget } from "../ssh/connection-manager";
import {
	listRemoteDir,
	type RemoteDirEntry,
	type RemotePathKind,
	readRemoteFile,
	statRemotePath,
	writeRemoteFile,
} from "../ssh/file-transfer";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
} from "./types";

/** Largest remote text file `ssh://` will materialize (mirrors the local:// cap). */
const SSH_TEXT_MAX_BYTES = 1024 * 1024;

/** POSIX-aware content type from the last path segment's extension. */
function contentTypeFor(remotePath: string): InternalResource["contentType"] {
	const slash = remotePath.lastIndexOf("/");
	const base = slash === -1 ? remotePath : remotePath.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	const ext = dot <= 0 ? "" : base.slice(dot).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

/** Decode the whole buffer as UTF-8 text, or null if it holds a NUL or invalid byte. */
function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (bytes.indexOf(0) !== -1) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * Remote absolute path from the URL. Uses `rawPathname` (pre-normalization) so
 * `..`/`//` and percent-escapes survive verbatim to the remote shell; the
 * authority (host/user/port) stays on the WHATWG fields, which preserve case for
 * the non-special `ssh` scheme.
 */
function remotePathFromUrl(url: InternalUrl): string {
	// `?`/`#` are URL delimiters, so parseInternalUrl strips them from the path
	// (`ssh://h/tmp/a?draft` → `/tmp/a`). Reject the unsupported suffix instead of
	// silently operating on the truncated path; a literal `?`/`#` in a filename
	// must be percent-encoded (`%3F`/`%23`).
	if (url.search) {
		throw new Error(
			`ssh:// does not support URL query strings; percent-encode a literal '?' as %3F in the path: ${url.href}`,
		);
	}
	if (url.hash) {
		throw new Error(
			`ssh:// does not support URL fragments; percent-encode a literal '#' as %23 in the path: ${url.href}`,
		);
	}
	const raw = url.rawPathname ?? url.pathname;
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new Error(`Invalid URL encoding in ssh:// path: ${url.href}`);
	}
	if (!decoded) {
		throw new Error(
			"ssh:// requires an absolute path, e.g. ssh://host/etc/hosts or ssh://host/ for the root directory",
		);
	}
	return decoded;
}

/** Load the configured SSH hosts from the `ssh` capability (managed/project `ssh.json`). */
async function loadConfiguredHosts(cwd?: string): Promise<SSHHost[]> {
	const { items } = await capability.loadCapability<SSHHost>(sshCapability.id, cwd ? { cwd } : {});
	return items;
}

/** One-line address for a host, e.g. `deploy@10.0.0.1:2222`. */
function hostAddress(host: SSHHost): string {
	return `${host.username ? `${host.username}@` : ""}${host.host}${host.port ? `:${host.port}` : ""}`;
}

/** Render the configured-host index for a bare `ssh://` read (markdown with per-host links). */
function formatHostIndex(hosts: readonly SSHHost[]): string {
	if (hosts.length === 0) {
		return "# SSH hosts\n\nNo SSH hosts are configured. Add hosts to an `ssh.json` capability file, or read `ssh://<host>/<path>` with any destination OpenSSH can resolve (e.g. a `~/.ssh/config` alias).\n";
	}
	const lines = hosts.map(host => {
		const addr = hostAddress(host);
		const suffix = addr === host.name ? "" : ` — \`${addr}\``;
		const desc = host.description ? ` (${host.description})` : "";
		return `- [${host.name}](ssh://${encodeURIComponent(host.name)}/)${suffix}${desc}`;
	});
	return `# SSH hosts\n\n${hosts.length} configured host${hosts.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}\n`;
}

/**
 * Resolve the URL authority to an SSH connection target. With no explicit
 * user/port, the full DECODED authority (`url.rawHost`) is matched against a
 * configured host name, so percent-encoded reserved-char aliases (e.g.
 * `alice%40prod` → `alice@prod`) resolve correctly. A literal `user@`/`:port`
 * in the URL is an override: it is rejected on a configured bare name (the
 * ControlMaster/host-info caches key on `name` alone) and otherwise treated as
 * an opaque OpenSSH destination so plain `~/.ssh/config` aliases work.
 */
async function resolveTarget(url: InternalUrl, cwd?: string): Promise<SSHConnectionTarget> {
	// `parseInternalUrl` falls back to a lenient regex parse when WHATWG `new URL`
	// rejects the input. For ssh:// that only happens on a malformed authority — an
	// invalid or out-of-range port (`prod:abc`, `host:65536`) or a bad IPv6 literal —
	// which would otherwise be mis-read as an opaque host and silently connect to the
	// default port. Reject it before resolving.
	if (!URL.canParse(url.href)) {
		throw new Error(`ssh://: invalid host or port in "${url.href}"; use ssh://host[:1-65535]/<absolute-path>`);
	}
	// WHATWG `hostname` is bracketed only for a *valid* IPv6 literal, so a bracketed
	// host is unambiguously IPv6 — hand OpenSSH the bare address. Percent-encoded
	// bracketed aliases (e.g. `%5Bprod%3A2222%5D`) keep their literal brackets in the
	// decoded `rawHost`, so they are matched and forwarded verbatim, never stripped.
	const bareHost = url.hostname;
	const rawAuthority = url.rawHost || bareHost;
	if (!bareHost && !rawAuthority) {
		throw new Error("ssh:// requires a host: ssh://<host>/<absolute-path>");
	}
	// `decodeOr` fails open, so a malformed percent-escape (`%ZZ`) in the authority
	// would otherwise pass the canonical check below and reach OpenSSH literally.
	// Reject it up front — the path decoder fails closed for the same bad escapes.
	for (const part of [url.username, bareHost]) {
		if (part.includes("%")) {
			try {
				decodeURIComponent(part);
			} catch {
				throw new Error(`ssh://: invalid percent-escape in authority "${url.href}"`);
			}
		}
	}
	if (url.password) {
		throw new Error(
			"ssh://: password authentication is not supported; ssh:// uses key/agent auth — drop the ':<password>' from the URL",
		);
	}
	const isIpv6Literal = bareHost.startsWith("[") && bareHost.endsWith("]");
	const sshHost = isIpv6Literal ? bareHost.slice(1, -1) : bareHost;
	const username = url.username || undefined;
	const port = url.port ? Number(url.port) : undefined;
	if (port === 0) {
		throw new Error("ssh://: port 0 is not a valid SSH port; use ssh://host:<1-65535>/<path> or omit the port");
	}
	// An empty port (`ssh://prod:/path`, `ssh://user@host:/path`, including
	// percent-encoded authority parts) parses cleanly with `url.port === ""`, so it
	// slips past the malformed-authority guard and would be read as "no port" —
	// silently using the default/configured target. `url.rawHost` is the decoded
	// authority and uniquely retains the trailing `:`; comparing it to the decoded
	// host (+ user) catches the empty port, while a percent-encoded alias like
	// `prod%3A` (whose decoded host already ends in `:`) reconstructs to `prod::`
	// and is left alone.
	const decodeOr = (s: string): string => {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	};
	if (port === undefined && url.rawHost === `${username ? `${decodeOr(username)}@` : ""}${decodeOr(bareHost)}:`) {
		throw new Error(`ssh://: empty port in "${url.href}"; use ssh://host:<1-65535>/<path> or drop the colon`);
	}
	// A literal but empty userinfo (`ssh://@host`) sets username to "" — WHATWG drops
	// the `@` from hostname, but rawHost keeps the leading `@`. A percent-encoded
	// alias like `%40prod` decodes to `@prod` in rawHost too, but its hostname keeps
	// `%40`, so the reconstruction is `@@prod` and is left alone.
	if (username === undefined && url.rawHost === `@${decodeOr(bareHost)}${port !== undefined ? `:${port}` : ""}`) {
		throw new Error(`ssh://: empty username in "${url.href}"; drop the leading '@' or provide a username before it`);
	}
	// Backstop for any remaining stray/empty authority marker the explicit checks
	// above do not name — notably an empty password (`ssh://user:@host`, `ssh://:@host`,
	// where `url.password === ""`). `rawHost` keeps the literal marker, so it differs
	// from the canonical decoded `[user@]host[:port]` WHATWG actually parsed. Every
	// valid authority — including percent-encoded reserved-char aliases — reconstructs
	// to exactly `rawHost`, so only malformed userinfo trips this.
	const canonicalAuthority = `${url.username ? `${decodeOr(url.username)}@` : ""}${decodeOr(bareHost)}${port !== undefined ? `:${port}` : ""}`;
	if (url.rawHost !== canonicalAuthority) {
		throw new Error(
			`ssh://: unsupported or malformed authority in "${url.href}"; use ssh://[user@]host[:1-65535]/<absolute-path>`,
		);
	}
	const items = await loadConfiguredHosts(cwd);

	// A literal user/port in the URL is an authority override. A configured alias
	// is addressed only by its (percent-encoded) name, never with a separate
	// user/port — so reject an override on a configured bare name, else opaque.
	if (username || port !== undefined) {
		const decodedBareHost = decodeOr(bareHost);
		if (items.some(entry => entry.name === bareHost || entry.name === decodedBareHost)) {
			throw new Error(
				`ssh://: user/port overrides are not allowed for the configured host "${decodedBareHost}"; use ssh://${bareHost}/<path> or an unconfigured hostname`,
			);
		}
		const sshUser = username ? decodeOr(username) : undefined;
		const sshTargetHost = decodeOr(sshHost);
		const name = `${sshUser ? `${sshUser}@` : ""}${sshTargetHost}${port !== undefined ? `:${port}` : ""}`;
		return { name, host: sshTargetHost, username: sshUser, port };
	}

	// No explicit user/port: match the full decoded authority against a
	// configured name (so an encoded reserved-char alias resolves correctly).
	const match = items.find(entry => entry.name === rawAuthority) ?? items.find(entry => entry.name === bareHost);
	if (match) {
		return {
			name: match.name,
			host: match.host,
			username: match.username,
			port: match.port,
			keyPath: match.keyPath,
			compat: match.compat,
		};
	}
	// Opaque OpenSSH destination (plain ~/.ssh/config alias, or any resolvable host).
	return { name: rawAuthority, host: isIpv6Literal ? sshHost : rawAuthority };
}

/** Format a one-level remote directory listing — mirrors buildDirectoryResource's plain `name/` lines. */
function formatDirListing(entries: readonly RemoteDirEntry[]): string {
	if (entries.length === 0) return "(empty directory)";
	return entries.map(entry => `${entry.name}${entry.isDirectory ? "/" : ""}`).join("\n");
}

export class SshProtocolHandler implements ProtocolHandler {
	readonly scheme = "ssh";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		// Bare `ssh://` (or `ssh:///`) with no host lists the configured hosts. A
		// host-less URL that still carries a path (`ssh:///etc/hosts`) is malformed —
		// reject it instead of silently dropping the path and listing hosts.
		if (!(url.rawHost || url.hostname)) {
			const rawPath = url.rawPathname ?? url.pathname;
			if (rawPath && rawPath !== "/") {
				throw new Error(
					`ssh:// requires a host before the path: ssh://<host>${rawPath} (host-less ssh://${rawPath} is not valid)`,
				);
			}
			return this.#resolveHostIndex(url, context?.cwd);
		}
		const target = await resolveTarget(url, context?.cwd);
		const remotePath = remotePathFromUrl(url);
		// Classify before reading. A FIFO with no writer would block `head` until the
		// timeout, and a device (e.g. /dev/zero) would stream the whole probe, so a
		// special file must fail fast. Only a regular file is read; a directory lists.
		// `missing`/stat-failure falls through to the read so its original remote stderr
		// (e.g. "No such file or directory") still surfaces.
		let kind: RemotePathKind | undefined;
		try {
			kind = await statRemotePath(target, remotePath, { signal: context?.signal });
		} catch {
			// stat failed (host/connection issue) — fall through; the read gives a clearer error.
		}
		if (kind === "directory") {
			return this.#resolveDirectory(target, remotePath, url, context?.signal, context?.skipDirectoryListing);
		}
		if (kind === "other") {
			throw new Error(
				`ssh://: ${remotePath} is not a regular file (FIFO, socket, or device); ssh:// reads UTF-8 text files only — use the ssh tool for special files`,
			);
		}
		const fileResult = await readRemoteFile(target, remotePath, {
			maxBytes: SSH_TEXT_MAX_BYTES,
			signal: context?.signal,
		});
		if (fileResult.truncated) {
			throw new Error(
				`ssh://: ${remotePath} exceeds the 1 MiB limit; ssh:// supports text files up to 1 MiB — use an sshfs mount for larger files`,
			);
		}
		const content = decodeUtf8Text(fileResult.bytes);
		if (content === null) {
			throw new Error(
				`ssh://: ${remotePath} is a binary or non-UTF-8 file; ssh:// supports UTF-8 text only — use the ssh tool or an sshfs mount`,
			);
		}
		// No `sourcePath`: keeps search on the virtual-resource path so the
		// displayed/searched resource stays `ssh://…` instead of a temp path.
		return {
			url: url.href,
			content,
			contentType: contentTypeFor(remotePath),
			size: fileResult.bytes.length,
		};
	}

	/** Resolve a remote directory to a one-level listing (no `sourcePath`; `isDirectory` so search refuses it; immutable). */
	async #resolveDirectory(
		target: SSHConnectionTarget,
		remotePath: string,
		url: InternalUrl,
		signal?: AbortSignal,
		skipListing?: boolean,
	): Promise<InternalResource> {
		// `search`/`find` reject an ssh:// directory outright, so they pass `skipListing`
		// to avoid draining a full remote `ls` we would only discard.
		const content = skipListing ? "" : formatDirListing(await listRemoteDir(target, remotePath, { signal }));
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			immutable: true,
			isDirectory: true,
		};
	}

	/** Resolve a bare `ssh://` to a listing of configured hosts (immutable; plain virtual text, so `search` can still grep host names). */
	async #resolveHostIndex(url: InternalUrl, cwd?: string): Promise<InternalResource> {
		const content = formatHostIndex(await loadConfiguredHosts(cwd));
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			immutable: true,
		};
	}

	/** Autocomplete the host segment of `ssh://` with the configured SSH hosts. */
	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const hosts = await loadConfiguredHosts(context?.cwd);
		return hosts.map(host => ({
			value: encodeURIComponent(host.name),
			label: host.name,
			description: host.description ?? hostAddress(host),
		}));
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const target = await resolveTarget(url, context?.cwd);
		const remotePath = remotePathFromUrl(url);
		await writeRemoteFile(target, remotePath, new TextEncoder().encode(content), { signal: context?.signal });
	}
}
