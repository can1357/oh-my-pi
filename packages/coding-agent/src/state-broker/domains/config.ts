/**
 * `config` replicated domain: the agent config directory as replicable files.
 *
 * The merge unit is a single file; its mtime (epoch millis) is the `rev`. Keys
 * travel as POSIX-separated relative paths so a Windows replica and a Linux
 * replica agree on identity regardless of local `path.sep`.
 *
 * Merge is last-writer-wins at file granularity: a remote entry overwrites the
 * local file only when its `mtimeMs` is strictly greater. See {@link applyRemote}
 * for the interaction with `Settings`' own writer.
 */

import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import {
	configFileMtimeMs,
	deleteConfigFile,
	enumerateConfigFiles,
	isReplicableConfigRel,
	readConfigFile,
	writeConfigFileAtomic,
} from "../config-files";
import type { ReplicatedDomain, StateSyncStore } from "../replica";
import type { StateEntry } from "../wire";

/** Payload carried in a config {@link StateEntry.value} (null value is a tombstone). */
interface ConfigFileValue {
	/** Relative path in POSIX form, mirroring the entry key. */
	rel: string;
	/** UTF-8 file content. */
	content: string;
	/** Source mtime in epoch millis, stamped onto the local file after write. */
	mtimeMs: number;
}

/** Local `path.sep`-relative path -> POSIX key used on the wire. */
function toPosixKey(rel: string): string {
	return rel.split(path.sep).join("/");
}

/** POSIX wire key -> local `path.sep`-relative path. */
function fromPosixKey(key: string): string {
	return key.split("/").join(path.sep);
}

/**
 * Validate a remote value into a {@link ConfigFileValue}, or `null` if malformed.
 * Kept total so `applyRemote` can drop a bad entry with a log instead of throwing.
 */
function parseValue(value: unknown): ConfigFileValue | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.rel !== "string" || typeof v.content !== "string" || typeof v.mtimeMs !== "number") {
		return null;
	}
	return { rel: v.rel, content: v.content, mtimeMs: v.mtimeMs };
}

/**
 * Create the `config` domain replicating files under `agentDir`
 * (default: `getAgentDir()`).
 *
 * `store` is the replica's own cursor database, used here to remember which
 * keys were published so a local DELETION can be turned into a tombstone. Pass
 * `undefined` to run the domain without deletion propagation (a live file
 * enumeration alone cannot see a file that is no longer there).
 */
export function createConfigDomain(agentDir: string = getAgentDir(), store?: StateSyncStore): ReplicatedDomain {
	return {
		id: "config",

		changedSince(afterRev: number, limit: number): StateEntry[] {
			// `fs.statSync().mtimeMs` carries sub-millisecond precision as a float,
			// but a `rev` is contractually an integer (`stateEntrySchema` rejects
			// non-integers and the broker stores it in an INTEGER column). Floor
			// before both the watermark comparison and publication: comparing the
			// raw float against a floored watermark would re-emit the same file on
			// every cycle forever, since 100.9 > floor(100.9).
			const live = enumerateConfigFiles(agentDir).map(f => ({
				rel: f.rel,
				mtimeMs: Math.floor(f.mtimeMs),
			}));

			// Deletions: anything we published before that is absent now. Latching
			// the tombstone in `store` is what makes it survive a failed push; the
			// row is only forgotten once the watermark proves it was delivered.
			const pending: Array<{ rel: string; rev: number; deleted: boolean }> = live
				.filter(f => f.mtimeMs > afterRev)
				.map(f => ({ rel: f.rel, rev: f.mtimeMs, deleted: false }));
			if (store) {
				const liveKeys = new Set(live.map(f => toPosixKey(f.rel)));
				const now = Date.now();
				for (const prior of store.published("config")) {
					if (liveKeys.has(prior.key)) continue;
					// Absent locally. Latch a tombstone rev on first sight, then keep
					// re-offering the same rev until the watermark passes it.
					const rev = prior.deleted ? prior.rev : now;
					if (!prior.deleted) store.recordDeleted("config", prior.key, rev);
					if (rev > afterRev) {
						pending.push({ rel: fromPosixKey(prior.key), rev, deleted: true });
					} else {
						// Watermark is past it, so the tombstone reached the broker.
						store.forgetPublished("config", prior.key);
					}
				}
			}

			// Sort and cap AFTER assembling both kinds, and note that filtering
			// already happened above: a page must never be post-filtered to empty
			// while eligible rows sit beyond the limit, or the watermark stalls.
			pending.sort((a, b) => a.rev - b.rev);
			const page = pending.slice(0, Math.max(0, limit));

			const entries: StateEntry[] = [];
			for (const item of page) {
				const key = toPosixKey(item.rel);
				if (item.deleted) {
					entries.push({ key, rev: item.rev, value: null });
					continue;
				}
				const content = readConfigFile(agentDir, item.rel);
				if (content === null) {
					// Deleted or became unreadable between enumerate and read; skip
					// rather than emit a bogus entry. The next scan sees it as a
					// deletion via the published-key diff.
					logger.debug("config domain: skipping unreadable file", { rel: item.rel });
					continue;
				}
				const value: ConfigFileValue = { rel: key, content, mtimeMs: item.rev };
				entries.push({ key, rev: item.rev, value });
				store?.recordPublished("config", key, item.rev);
			}
			return entries;
		},

		applyRemote(entries: readonly StateEntry[]): void {
			for (const entry of entries) {
				const rel = fromPosixKey(entry.key);

				// A peer chooses this key, so the outbound policy has to be enforced
				// again here — the traversal guard alone would happily accept
				// `.env`, `auth-broker.token`, `projects.yml` or a live `agent.db`,
				// since every one of those sits inside the agent dir. Checked before
				// the tombstone branch too: otherwise a peer could delete them.
				if (!isReplicableConfigRel(rel)) {
					logger.warn("config domain: rejecting non-replicable remote key", { key: entry.key });
					continue;
				}

				// Tombstone: unlink only when our copy is not newer than the
				// deletion. If we hold a newer edit, LWW keeps it.
				if (entry.value === null) {
					const localMtime = configFileMtimeMs(agentDir, rel);
					if (localMtime !== null && localMtime >= entry.rev) continue;
					try {
						deleteConfigFile(agentDir, rel);
					} catch (error) {
						// Traversal guard or fs error; drop this entry, keep the batch.
						logger.debug("config domain: tombstone apply failed", { rel, error: String(error) });
					}
					continue;
				}

				const value = parseValue(entry.value);
				if (!value) {
					logger.debug("config domain: dropping malformed entry", { key: entry.key });
					continue;
				}

				// Last-writer-wins: only overwrite when the remote file is strictly
				// newer than ours (or we have no copy). `config.yml` in particular is
				// also written by `Settings` via a debounced save + `#withYamlWriteLock`
				// + atomic rename; both writers are atomic-rename based, so a reader
				// never sees a torn file, and last-writer-wins is the accepted
				// resolution at file granularity. An in-memory `Settings` instance will
				// NOT observe a merged change until `Settings.reloadFromDisk()` runs —
				// that is the integration owner's call, so we never invoke it here.
				const localMtime = configFileMtimeMs(agentDir, rel);
				if (localMtime !== null && localMtime >= value.mtimeMs) continue;
				try {
					writeConfigFileAtomic(agentDir, rel, value.content, value.mtimeMs);
				} catch (error) {
					// Traversal guard or fs error; drop this entry, keep the batch.
					logger.debug("config domain: write apply failed", { rel, error: String(error) });
				}
			}
		},
	};
}
