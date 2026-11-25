/**
 * Sandbox subjects for in-process tools that fetch a web URL on the agent's behalf (`read`, `grep`,
 * `ast_grep`). The fetch runs in omp, outside the OS sandbox, so the sandbox's network policy checks the
 * URL's host through the subjects these tools declare: `network.mode: deny` refuses it, `allowlist`
 * admits a listed host (or a session grant), `allow` admits all. These subjects are the early refusal;
 * every host the read contacts, the URL's own included, passes the same policy again in `fetchReadUrl`.
 */
import { repairCollapsedScheme, tryExtractEmbeddedUrlSelector } from "./details/fetch";
import type { SandboxSubject } from "@oh-my-pi/pi-agent-core";
import { requestHost } from "../web/scrapers/types";
import { type ApprovalSubject, approvalPathSubjects } from "./approval";
import { type ParsedReadUrlTarget, parseReadUrlTarget } from "./fetch";
import { normalizePathLikeInput } from "./path-utils";
import { approvalRootCandidates } from "./search-approval-targets";

/** The host of a readable URL path as the sandbox compares hosts: punycode, lowercase, no port, no IPv6 brackets. */
function readUrlHost(urlPath: string): string | undefined {
	// A URL the platform cannot parse has no host: nothing connects to it, and the fetch fails on its own.
	return requestHost(/^https?:\/\//i.test(urlPath) ? urlPath : `https://${urlPath}`);
}

/** `value` trimmed with every layer of outer double quotes removed, as execution may strip them again at each stage. */
function unquoted(value: string): string {
	let current = value;
	for (;;) {
		const next = normalizePathLikeInput(current);
		if (next === current) return current;
		current = next;
	}
}

/**
 * Every string `rawPath` may be fetched as: the entry unquoted, and the unquoted parts of each
 * `;`/`,`/whitespace list it or a part holds, as execution unquotes and fans lists out per part and per stage.
 */
function urlCandidates(rawPath: string): Set<string> {
	const seen = new Set([unquoted(rawPath)]);
	// The set is the queue: iteration visits the candidates added while it runs, in insertion order.
	for (const item of seen) {
		for (const part of approvalRootCandidates(item)) seen.add(unquoted(part));
	}
	return seen;
}

/** The host `candidate` fetches, or `undefined` when it is not a readable web URL. */
function candidateHost(candidate: string): string | undefined {
	let target: ParsedReadUrlTarget | null;
	try {
		target = parseReadUrlTarget(candidate);
	} catch {
		// A malformed selector fails `read`, but another tool may peel it and fetch anyway (grep's
		// trailing range): name the host of the URL with its selector tail peeled.
		const repaired = repairCollapsedScheme(candidate);
		return readUrlHost(tryExtractEmbeddedUrlSelector(repaired)?.path ?? repaired);
	}
	return target ? readUrlHost(target.path) : undefined;
}

/**
 * One `host` subject per distinct web host `rawPaths` fetch. Each raw entry is read as a whole and as the
 * parts of a `;`/`,`/whitespace list, quotes stripped at every level, as execution fans lists out:
 * over-naming a part only adds a host to check, while under-naming would leave a fetch to a host the
 * policy never saw.
 */
export function webUrlHostSubjects(rawPaths: readonly string[]): SandboxSubject[] {
	const hosts = new Set<string>();
	for (const rawPath of rawPaths) {
		for (const candidate of urlCandidates(rawPath)) {
			const host = candidateHost(candidate);
			if (host !== undefined) hosts.add(host);
		}
	}
	return [...hosts].map(target => ({ kind: "host", target }));
}

/**
 * What a read-tier call that may fetch web URLs does on the host: the web hosts it names plus the
 * paths it reads. The gate takes a tool's declared subjects instead of deriving paths from it, so the
 * path subjects the call would otherwise get ride along. `undefined` when no web URL is named: the
 * gate then derives the call's subjects as usual.
 */
export function webUrlSandboxSubjects(
	tool: ApprovalSubject,
	args: unknown,
	rawPaths: readonly string[],
): readonly SandboxSubject[] | undefined {
	const hosts = webUrlHostSubjects(rawPaths);
	if (hosts.length === 0) return undefined;
	const paths = approvalPathSubjects(tool, args).map(({ path, recursive }) => ({
		kind: "read" as const,
		target: path,
		recursive,
	}));
	return [...hosts, ...paths];
}
