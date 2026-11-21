/**
 * Extract "owner/repo" from a GitHub remote URL.
 * Handles HTTPS, SSH (scp-style), and git:// protocols.
 *
 * @returns "owner/repo" or null if the URL isn't a recognized GitHub remote.
 */
export function parseGitHubRepo(remoteUrl: string): string | null {
	const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/]+)/);
	if (!match) return null;
	return match[1].replace(/\.git$/, "");
}

/**
 * Extract the branch name from a remote HEAD ref like "origin/main".
 * Returns the portion after the first "/" or the whole string if no "/" is present.
 */
export function parseDefaultBranch(ref: string): string {
	const slash = ref.indexOf("/");
	return slash >= 0 ? ref.slice(slash + 1) : ref;
}

export interface PrCacheContext {
	branch: string;
	repoId: string | null;
}

export function createPrCacheContext(branch: string, repoId: string | null): PrCacheContext {
	return { branch, repoId };
}

export function isSamePrCacheContext(a: PrCacheContext | undefined, b: PrCacheContext | undefined): boolean {
	if (!a || !b) return false;
	return a.branch === b.branch && a.repoId === b.repoId;
}

export function canReuseCachedPr(
	cachedPr: { number: number; url: string } | null | undefined,
	cachedContext: PrCacheContext | undefined,
	currentContext: PrCacheContext | null,
): boolean {
	return cachedPr !== undefined && currentContext !== null && isSamePrCacheContext(cachedContext, currentContext);
}
