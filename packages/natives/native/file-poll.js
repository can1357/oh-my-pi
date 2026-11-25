import * as fs from "node:fs";

/**
 * Stat-poll `file` every `intervalMs`; `onChange` runs when its mtime, size or
 * inode changes, including when it appears or disappears. Returns a disposer.
 *
 * Each tick re-resolves the path, so atomic rename-over saves, symlink
 * retargets and missing parents never silence it, unlike `fs.watch`. The poll
 * never keeps the process alive.
 */
export function pollFile(file, onChange, intervalMs) {
	const listener = (curr, prev) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange();
	};
	fs.watchFile(file, { interval: intervalMs }, listener).unref();
	return () => fs.unwatchFile(file, listener);
}
