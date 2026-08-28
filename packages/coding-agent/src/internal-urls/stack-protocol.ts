/**
 * Protocol handler for `stack://`.
 *
 * Remote stacked-PR reads go through the GitHub Stacks REST API. Local
 * `gh stack` state is not required.
 *
 * URL shapes:
 * - `stack://` — list stacks in the caller's default repo.
 * - `stack://7` — view stack #7 in the default repo.
 * - `stack://owner/repo` — list stacks in that repo.
 * - `stack://owner/repo/7` — view stack #7.
 * - `stack://ghe.example.com/owner/repo/7` — same, on a GitHub Enterprise host.
 *   A host with no dot (`ghe`) is recognized only in the numbered form.
 */
import { AgentRegistry } from "../registry/agent-registry";
import { formatRepoRef, parsePositiveDecimalInt, resolveDefaultRepoMemoized } from "../tools/gh-common";
import { fetchRemoteStack, fetchRepoStacks, formatRemoteStackView, formatStackList } from "../tools/gh-stack";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

interface ParsedList {
	kind: "list";
	repo?: string;
}

interface ParsedSingle {
	kind: "single";
	repo?: string;
	number: number;
}

type Parsed = ParsedList | ParsedSingle;

function parseUrl(url: InternalUrl): Parsed {
	let host = url.rawHost || url.hostname;
	const rawPath = url.rawPathname ?? url.pathname;
	const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	let parts: string[] = [];
	if (stripped !== "") {
		for (const seg of stripped.split("/")) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(seg);
			} catch {
				throw new Error("Invalid stack:// URL: empty or unsafe path segment");
			}
			if (decoded === "" || decoded === "." || decoded === "..") {
				throw new Error("Invalid stack:// URL: empty or unsafe path segment");
			}
			parts.push(seg);
		}
	}

	let repoHost: string | undefined;
	const dottedHost = host.includes(".");
	if (dottedHost && parts.length < 2) {
		throw new Error(
			"Invalid stack:// URL. Expected stack://<host>/<owner>/<repo> or stack://<host>/<owner>/<repo>/<number>",
		);
	}
	const hostPrefixed = dottedHost
		? parts.length >= 2
		: parts.length >= 3 && parsePositiveDecimalInt(parts[2]) !== undefined;
	if (hostPrefixed) {
		repoHost = host;
		host = parts[0] ?? "";
		parts = parts.slice(1);
	}

	if (!host && parts.length === 0) {
		return { kind: "list", repo: undefined };
	}
	if (host && parts.length === 0) {
		const number = parsePositiveDecimalInt(host);
		if (number === undefined) {
			throw new Error(`Invalid stack:// number: ${host}`);
		}
		return { kind: "single", number };
	}
	if (host && parts.length === 1) {
		return { kind: "list", repo: formatRepoRef(repoHost, `${host}/${parts[0]}`) };
	}
	if (host && parts.length === 2) {
		const number = parsePositiveDecimalInt(parts[1]);
		if (number === undefined) {
			throw new Error(`Invalid stack:// number: ${parts[1]}`);
		}
		return { kind: "single", repo: formatRepoRef(repoHost, `${host}/${parts[0]}`), number };
	}
	throw new Error(
		"Invalid stack:// URL. Expected stack://, stack://<number>, stack://<owner>/<repo>, or stack://<owner>/<repo>/<number>",
	);
}

function resolveCwd(context: ResolveContext | undefined): string {
	if (context?.cwd) return context.cwd;
	for (const ref of AgentRegistry.global().list()) {
		const cwd = ref.session?.sessionManager?.getCwd();
		if (cwd) return cwd;
	}
	return process.cwd();
}

async function resolveRepo(parsedRepo: string | undefined, context: ResolveContext | undefined): Promise<string> {
	if (parsedRepo) return parsedRepo;
	const cwd = resolveCwd(context);
	try {
		return await resolveDefaultRepoMemoized(cwd, context?.signal);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`stack:// could not resolve a default repo from the current session: ${message}\nUse stack://<owner>/<repo> instead.`,
		);
	}
}

export class StackProtocolHandler implements ProtocolHandler {
	readonly scheme = "stack";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const parsed = parseUrl(url);
		const cwd = resolveCwd(context);
		const repo = await resolveRepo(parsed.repo, context);
		if (parsed.kind === "list") {
			const stacks = await fetchRepoStacks(cwd, repo, context?.signal);
			const content = formatStackList(repo, stacks);
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
				notes: [`Live stacks for ${repo}`],
			};
		}
		const stack = await fetchRemoteStack(cwd, repo, parsed.number, context?.signal);
		const content = formatRemoteStackView(stack, repo);
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`stack://${repo}/${stack.number}`],
		};
	}
}
