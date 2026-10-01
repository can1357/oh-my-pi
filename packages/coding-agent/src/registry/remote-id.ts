/**
 * The cross-process REMOTE agent id scheme: `@<namespace>/<name>`.
 *
 * A peer behind a bridge (e.g. murmur) is addressed by a globally-unique `namespace` (claimed by
 * the installing extension) plus the peer's bare mesh `name`. A LOCAL agent id (`main`/`sub`) may
 * never begin with {@link REMOTE_ID_PREFIX}, so the local and remote id spaces are disjoint by
 * construction — no per-id reserved-name or clobber guards are needed.
 *
 * This module is a dependency-free leaf: the internal-URL parser folds `agent://@ns/name` back into
 * one host token using {@link REMOTE_ID_PREFIX}, so it must not pull the registry or the bus in.
 */

/** Reserved leading marker of the remote id space. */
export const REMOTE_ID_PREFIX = "@";

const REMOTE_NAMESPACE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const REMOTE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Whether `namespace` is a well-formed remote namespace (1-64 chars of letters, digits, `.`, `_`, `-`). */
export function isValidRemoteNamespace(namespace: string): boolean {
	return REMOTE_NAMESPACE_RE.test(namespace);
}

/** Whether `name` is a well-formed bare remote peer name (1-128 chars of letters, digits, `.`, `_`, `-`). */
export function isValidRemoteName(name: string): boolean {
	return REMOTE_NAME_RE.test(name);
}

/**
 * Compose a remote agent id `@<namespace>/<name>`. Throws on an invalid namespace/name so a
 * malformed id can never enter the registry or routing.
 */
export function composeRemoteId(namespace: string, name: string): string {
	if (!isValidRemoteNamespace(namespace)) {
		throw new Error(
			`Invalid remote namespace ${JSON.stringify(namespace)} (allowed: 1-64 chars of letters, digits, ".", "_", "-").`,
		);
	}
	if (!isValidRemoteName(name)) {
		throw new Error(
			`Invalid remote peer name ${JSON.stringify(name)} (allowed: 1-128 chars of letters, digits, ".", "_", "-").`,
		);
	}
	return `${REMOTE_ID_PREFIX}${namespace}/${name}`;
}

/** The namespace of a remote id `@<namespace>/<name>`, or undefined if `id` is not remote-prefixed. */
export function remoteNamespaceOf(id: string): string | undefined {
	if (!id.startsWith(REMOTE_ID_PREFIX)) return undefined;
	const sep = id.indexOf("/", REMOTE_ID_PREFIX.length);
	if (sep < REMOTE_ID_PREFIX.length + 1) return undefined;
	return id.slice(REMOTE_ID_PREFIX.length, sep);
}

/** The bare mesh name of a remote id `@<namespace>/<name>`, or undefined if `id` is not remote. */
export function remoteNameOf(id: string): string | undefined {
	const namespace = remoteNamespaceOf(id);
	if (namespace === undefined) return undefined;
	return id.slice(REMOTE_ID_PREFIX.length + namespace.length + 1);
}

/** Whether `id` is a well-formed remote id `@<namespace>/<name>` (valid namespace + bare name). */
export function isValidRemoteId(id: string): boolean {
	const namespace = remoteNamespaceOf(id);
	if (namespace === undefined || !isValidRemoteNamespace(namespace)) return false;
	const name = remoteNameOf(id);
	return name !== undefined && isValidRemoteName(name);
}
