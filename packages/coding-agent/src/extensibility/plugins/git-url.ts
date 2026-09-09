/**
 * Parsed git URL information.
 */
export type GitSource = {
	/** Always "git" for git sources */
	type: "git";
	/** Clone URL (always valid for git clone, without ref suffix) */
	repo: string;
	/** Git host domain (e.g., "github.com") */
	host: string;
	/** Repository path (e.g., "user/repo") */
	path: string;
	/** Git ref (branch, tag, commit) if specified */
	ref?: string;
	/** True if ref was specified (package won't be auto-updated) */
	pinned: boolean;
};

/** Known git hosts and their URL extraction logic. */
const KNOWN_HOSTS: Record<string, (pathname: string, hash: string) => { user: string; project: string } | null> = {
	"github.com": extractStandard,
	"gitlab.com": extractGitLab,
	"bitbucket.org": extractStandard,
	"git.sr.ht": extractStandard,
	"codeberg.org": extractStandard,
};

/**
 * Namespaced shorthand prefixes accepted by `omp plugin install`, mapped to
 * their canonical host. `PluginManager.install` normalizes non-GitHub prefixes
 * before invoking bun because bun only treats `github:` as a hosted shorthand.
 */
const SHORTHAND_PREFIXES: Record<string, string> = {
	github: "github.com",
	gitlab: "gitlab.com",
	bitbucket: "bitbucket.org",
	codeberg: "codeberg.org",
	sourcehut: "git.sr.ht",
	srht: "git.sr.ht",
};

/**
 * `<prefix>:<user>/<repo>[.git][#<ref>]` shape. `<repo>` is non-greedy so the
 * optional `.git` suffix and `#ref` tail bind tightly; `<repo>` may itself
 * contain `/` to support nested GitLab groups (`gitlab:group/sub/project`).
 * `<user>` rejects `/`, `:`, `#` to keep protocol URLs (`https://…`) and
 * scp-like SSH (`git@github.com:user/repo`) out of this path.
 */
const SHORTHAND_RE = /^([a-z]+):([^/:#]+)\/([^#]+?)(?:\.git)?(?:#(.+))?$/i;

function stripUrlCredentials(url: string): string {
	if (!url.includes("://")) return url;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return url;
	}
}

function extractStandard(pathname: string, _hash: string): { user: string; project: string } | null {
	const [, user, project] = pathname.split("/", 3);
	if (!user || !project) return null;
	return { user, project: project.replace(/\.git$/, "") };
}

function extractGitLab(pathname: string, _hash: string): { user: string; project: string } | null {
	const path = pathname.startsWith("/") ? pathname.slice(1) : pathname;
	if (path.includes("/-/") || path.includes("/archive.tar.gz")) return null;
	const segments = path.split("/");
	let project = segments.pop();
	if (!project) return null;
	project = project.replace(/\.git$/, "");
	const user = segments.join("/");
	if (!user || !project) return null;
	return { user, project };
}

/**
 * Try to parse a URL against known git hosts.
 * Returns `{ domain, user, project, committish }` or null.
 */
function tryKnownHost(candidate: string): { domain: string; user: string; project: string; committish: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return null;
	}

	const hostname = parsed.hostname.startsWith("www.") ? parsed.hostname.slice(4) : parsed.hostname;
	const extractor = KNOWN_HOSTS[hostname];
	if (!extractor) return null;

	const segments = extractor(parsed.pathname, parsed.hash);
	if (!segments) return null;

	let committish = "";
	if (parsed.hash) {
		try {
			committish = decodeURIComponent(parsed.hash.slice(1));
		} catch {
			return null;
		}
	}

	return {
		domain: hostname,
		user: segments.user,
		project: segments.project,
		committish,
	};
}

function splitRef(url: string): { repo: string; ref?: string } {
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };
			parsed.pathname = `/${repoPath}`;
			if (parsed.protocol === "http:" || parsed.protocol === "https:") {
				parsed.username = "";
				parsed.password = "";
			}
			return {
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) return { repo: url };
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) return { repo: url };
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) return { repo: url };
	return { repo: `${host}/${repoPath}`, ref };
}

/** Try known-host parsing and build a GitSource from the result. */
function tryKnownHostSource(
	split: { repo: string; ref?: string },
	candidate: string,
	repoUrl: string,
): GitSource | null {
	const info = tryKnownHost(candidate);
	if (!info) return null;
	if (split.ref && info.project.includes("@")) return null;
	return {
		type: "git",
		repo: stripUrlCredentials(repoUrl),
		host: info.domain,
		path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
		ref: info.committish || split.ref || undefined,
		pinned: Boolean(info.committish || split.ref),
	};
}

function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let repoPath = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		repoPath = scpLikeMatch[2] ?? "";
	} else if (/^https?:\/\/|^ssh:\/\/|^git:\/\//.test(repoWithoutRef)) {
		try {
			const parsed = new URL(repoWithoutRef);
			if (parsed.hash) {
				try {
					decodeURIComponent(parsed.hash.slice(1));
				} catch {
					return null;
				}
			}
			host = parsed.hostname;
			repoPath = parsed.pathname.replace(/^\/+/, "");
			repo = stripUrlCredentials(repoWithoutRef);
		} catch {
			return null;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) return null;
		repo = `https://${repoWithoutRef}`;
		try {
			const parsed = new URL(repo);
			host = parsed.hostname;
			repoPath = parsed.pathname.replace(/^\/+/, "");
			repo = stripUrlCredentials(repo);
		} catch {
			return null;
		}
		if (!host.includes(".") && host !== "localhost") return null;
	}

	const normalizedPath = repoPath.replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !normalizedPath || normalizedPath.split("/").length < 2) return null;

	return { type: "git", repo, host, path: normalizedPath, ref, pinned: Boolean(ref) };
}

/**
 * Match an npm/bun-style namespaced shorthand (`github:user/repo`, optionally
 * `…#ref` or `….git`). Returns null for protocol URLs and any prefix not in
 * `SHORTHAND_PREFIXES` so the caller can fall through to the generic paths.
 */
function tryNamespacedShorthand(trimmed: string): GitSource | null {
	// Cheap gate: bail out before touching protocol URLs (`https://`, `ssh://`,
	// `git://`) where the char after the colon is always `/`. The shorthand we
	// care about never starts with `<scheme>://`.
	if (!/^[a-z]+:[^/]/i.test(trimmed)) return null;
	const match = trimmed.match(SHORTHAND_RE);
	if (!match) return null;
	const prefix = (match[1] ?? "").toLowerCase();
	const host = SHORTHAND_PREFIXES[prefix];
	if (!host) return null;
	const user = match[2] ?? "";
	const repoPath = match[3] ?? "";
	if (!user || !repoPath) return null;
	const ref = match[4];
	if (ref) {
		try {
			decodeURIComponent(ref);
		} catch {
			return null;
		}
	}
	const fullPath = `${user}/${repoPath}`;
	return {
		type: "git",
		repo: `https://${host}/${fullPath}`,
		host,
		path: fullPath,
		ref: ref || undefined,
		pinned: Boolean(ref),
	};
}

/**
 * Parse git source into a GitSource.
 *
 * Rules:
 * - Namespaced shorthand (`github:user/repo`, `gitlab:`, `bitbucket:`,
 *   `codeberg:`, `sourcehut:`/`srht:`) is accepted directly; installers should
 *   normalize entries that bun does not understand natively.
 * - With `git:` prefix, accept generic shorthand forms.
 * - Without `git:` prefix, only accept explicit protocol URLs.
 *
 * Handles:
 * - `github:user/repo[#ref]`-style namespaced shorthand
 * - `git:` prefixed URLs (`git:github.com/user/repo`)
 * - SSH SCP-like URLs (`git:git@github.com:user/repo`)
 * - HTTPS/HTTP/SSH/git protocol URLs
 * - Ref pinning via `@ref` suffix
 *
 * Recognizes GitHub, GitLab, Bitbucket, Sourcehut, and Codeberg natively.
 * Falls back to generic URL parsing for other hosts.
 */
export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();

	const shorthand = tryNamespacedShorthand(trimmed);
	if (shorthand) return shorthand;

	// Strip the `git+` URL prefix that npm/bun accept (`git+https://…`,
	// `git+ssh://…`, `git+git://…`). The rest of the pipeline only deals with
	// bare schemes.
	const stripped = /^git\+/i.test(trimmed) ? trimmed.slice(4) : trimmed;

	const hasGitPrefix = /^git:(?!\/\/)/i.test(stripped);
	const url = hasGitPrefix ? stripped.slice(4).trim() : stripped;

	// Accept: explicit protocol URL, `git:` shorthand, or scp-like SSH
	// (`git@host:user/repo`). The scp form is unambiguous — no local path
	// starts with `git@` — and matches the syntax that `git clone` itself
	// accepts, which `bun install` forwards through.
	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url) && !/^git@[^:]+:.+\/.+/i.test(url)) {
		return null;
	}

	const hashIndex = url.indexOf("#");
	if (hashIndex >= 0) {
		const hash = url.slice(hashIndex + 1);
		if (hash) {
			try {
				decodeURIComponent(hash);
			} catch {
				return null;
			}
		}
	}
	const split = splitRef(url);

	// SCP-like SSH URLs (git@host:user/repo) — convert to https for host matching
	const scpMatch = split.repo.match(/^git@([^:]+):(.+)$/);

	// Try known hosts with the repo URL directly
	const directCandidates: string[] = [];
	if (scpMatch) {
		directCandidates.push(`https://${scpMatch[1]}/${scpMatch[2]}`);
	} else if (/^https?:\/\/|^ssh:\/\/|^git:\/\//.test(split.repo)) {
		directCandidates.push(split.repo);
	}

	for (const candidate of directCandidates) {
		const withRef = split.ref ? `${candidate.replace(/#.*$/, "")}#${split.ref}` : candidate;
		const needsHttps =
			!split.repo.startsWith("http://") &&
			!split.repo.startsWith("https://") &&
			!split.repo.startsWith("ssh://") &&
			!split.repo.startsWith("git://") &&
			!split.repo.startsWith("git@");
		const result = tryKnownHostSource(split, withRef, needsHttps ? `https://${split.repo}` : split.repo);
		if (result) return result;
	}

	// Try with https:// prefix for bare host/user/repo shorthand
	if (!split.repo.includes("://") && !split.repo.startsWith("git@")) {
		const httpsCandidate = split.ref ? `https://${split.repo}#${split.ref}` : `https://${url}`;
		const result = tryKnownHostSource(split, httpsCandidate, `https://${split.repo}`);
		if (result) return result;
	}

	return parseGenericGitUrl(url);
}

/**
 * Returns true if the spec is parseable as a git source (protocol URL,
 * scp-like SSH wrapped in `git:`, plain `git:` shorthand, or namespaced
 * shorthand like `github:user/repo`). The inverse of "this is an npm spec".
 */
export function isGitSpec(spec: string): boolean {
	return parseGitUrl(spec) !== null;
}
