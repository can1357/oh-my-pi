/**
 * Putting trimmed values back into session entries (issue #9469).
 *
 * The collab host trims what does not fit a frame and lists each trim in the
 * entry's `collabElided`, with a path into the *original* entry. Most trims
 * leave a placeholder at that path (a clipped string, a clipped array, a text
 * block where an image was) and are restored by replacing it. An image taken
 * out of an image-only array (`removed: true`) left nothing behind: it is
 * restored by insertion, and until then every later element of that array
 * sits one index lower than the original path says.
 */
import type { CollabElided, SessionEntry } from "@oh-my-pi/pi-wire";

export function pathEquals(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
	return a.length === b.length && a.every((key, i) => b[i] === key);
}

/** Both records name the same trimmed value. */
export function sameElided(a: CollabElided, b: CollabElided): boolean {
	return a.hash === b.hash && pathEquals(a.path, b.path);
}

/** `prefix` addresses `path` itself or one of its ancestors. */
export function isPathPrefix(prefix: readonly (string | number)[], path: readonly (string | number)[]): boolean {
	return prefix.length <= path.length && prefix.every((key, i) => path[i] === key);
}

/**
 * Where original index `path[depth]` sits in the entry as held: lowered by
 * each image still missing from that array at a smaller original index.
 */
function heldKey(path: readonly (string | number)[], depth: number, pending: readonly CollabElided[]): string | number {
	const key = path[depth];
	if (typeof key !== "number") return key;
	let missing = 0;
	for (const record of pending) {
		const at = record.path[depth];
		if (
			record.removed === true &&
			record.path.length === depth + 1 &&
			typeof at === "number" &&
			at < key &&
			isPathPrefix(record.path.slice(0, depth), path)
		) {
			missing++;
		}
	}
	return key - missing;
}

/**
 * A copy of `entry` with `value`, the original behind `record`, put back and
 * `record` dropped from `collabElided`, together with every record nested
 * under it: the original already holds what they trimmed. Only containers on
 * the path are copied; everything else is shared with `entry`.
 *
 * @throws Error when `record.path` does not resolve in `entry`, or a
 *   whole-entry value is not the entry it stands for.
 */
export function applyElidedValue(entry: SessionEntry, record: CollabElided, value: unknown): SessionEntry {
	if (record.path.length === 0) {
		if (typeof value !== "object" || value === null || (value as { id?: unknown }).id !== entry.id) {
			throw new Error("the loaded entry is not the one requested");
		}
		return value as SessionEntry;
	}
	const pending = (entry.collabElided ?? []).filter(other => !isPathPrefix(record.path, other.path));
	const copy: Record<string | number, unknown> = { ...entry };
	let parent = copy;
	const last = record.path.length - 1;
	for (let depth = 0; depth < last; depth++) {
		const key = heldKey(record.path, depth, pending);
		const child = parent[key];
		if (typeof child !== "object" || child === null) throw new Error(`nothing at ${record.path.join(".")}`);
		const next = (Array.isArray(child) ? child.slice() : { ...child }) as Record<string | number, unknown>;
		parent[key] = next;
		parent = next;
	}
	const key = heldKey(record.path, last, pending);
	if (record.removed === true) {
		if (!Array.isArray(parent) || typeof key !== "number" || key > parent.length) {
			throw new Error(`nothing at ${record.path.join(".")}`);
		}
		parent.splice(key, 0, value);
	} else {
		if (!Object.hasOwn(parent, key)) throw new Error(`nothing at ${record.path.join(".")}`);
		parent[key] = value;
	}
	if (pending.length > 0) copy.collabElided = pending;
	else delete copy.collabElided;
	return copy as unknown as SessionEntry;
}
