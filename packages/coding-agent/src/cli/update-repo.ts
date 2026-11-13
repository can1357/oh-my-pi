/**
 * `PI_UPDATE_REPO` value check, shared by the runtime ({@link updateRepo} in
 * `build-service.ts`) and the compile that bakes it in as the default. Imports nothing, so
 * the compile script can load it without the host native addon.
 */

/** A GitHub `owner/repo`, trimmed; undefined when `value` is unset or blank. Throws on anything else. */
export function parseUpdateRepo(value: string | undefined): string | undefined {
	const repo = (value ?? "").trim();
	if (!repo) return undefined;
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`PI_UPDATE_REPO must be owner/repo, not ${repo}`);
	return repo;
}
