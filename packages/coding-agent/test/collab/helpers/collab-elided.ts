import { expect } from "bun:test";
import type { CollabElided } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { collabValueHash } from "@oh-my-pi/pi-coding-agent/collab/replication-images";

/** The value at `path` in `root`, resolved the way the host's fetch-value handler walks it. */
export function valueAtPath(root: unknown, path: readonly (string | number)[]): unknown {
	let value = root;
	for (const key of path) {
		if (value === null || typeof value !== "object") return undefined;
		value = (value as Record<string | number, unknown>)[key];
	}
	return value;
}

/**
 * Assert `record` is fetchable from `original`: its path resolves there, and
 * its size and hash describe exactly that value's JSON — what the host
 * re-checks before serving it. Returns the resolved original value.
 */
export function expectFetchable(original: unknown, record: CollabElided): unknown {
	const value = valueAtPath(original, record.path);
	expect(value).toBeDefined();
	const json = JSON.stringify(value);
	expect(record.bytes).toBe(Buffer.byteLength(json, "utf8"));
	expect(record.hash).toBe(collabValueHash(json));
	return value;
}
