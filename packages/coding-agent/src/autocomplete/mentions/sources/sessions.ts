/**
 * Unified mention source for past conversations / sessions (`session://<id>`).
 *
 * Uses a stale-while-revalidate per-cwd cache over {@link listSessionsForPicker}
 * (backed by SQLite `session_titles` in history.db), so returning matches takes
 * <1ms synchronously without reading session JSONL bodies on keystrokes.
 */
import * as fs from "node:fs/promises";
import {
	isEmptySession,
	listSessionsForPicker,
	sessionDisplayName,
	type SessionInfo,
} from "../../../session/session-listing";
import { sessionDirForCwd } from "../../../session/session-paths";
import { FileSessionStorage } from "../../../session/session-storage";
import { FuzzyQuery, FuzzyText } from "../../../utils/fuzzy";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceResult,
} from "../types";

const MAX_SESSION_ITEMS = 25;
const CACHE_TTL_MS = 30_000;

export interface SessionsMentionHost {
	readonly getCwd: () => string;
	/** Exclude the active conversation itself from suggestions. */
	readonly getCurrentSessionId?: () => string | undefined;
}

interface SessionSummary {
	readonly id: string;
	readonly title: string;
	readonly firstMessage: string;
	readonly modifiedMs: number;
}

interface SessionSnapshot {
	readonly cwd: string;
	readonly entries: readonly SessionSummary[];
	readonly loadedAt: number;
}

function formatAgeShort(ms: number): string {
	const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
	return `${Math.floor(sec / 86400)}d`;
}

function toSummaries(infos: readonly SessionInfo[]): SessionSummary[] {
	const seen = new Set<string>();
	const out: SessionSummary[] = [];
	for (const info of infos) {
		if (!info.id || seen.has(info.id) || isEmptySession(info)) continue;
		seen.add(info.id);
		const title = sessionDisplayName(info).replace(/\s+/g, " ").trim();
		if (!title) continue;
		out.push({
			id: info.id,
			title,
			firstMessage: (info.firstMessage ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
			modifiedMs: info.modified.getTime(),
		});
	}
	out.sort((a, b) => b.modifiedMs - a.modifiedMs);
	return out;
}

function buildSessionItem(entry: SessionSummary, tier: MatchTier): MentionItem {
	const url = `session://${entry.id}`;
	const age = formatAgeShort(entry.modifiedMs);
	const shortId = entry.id.slice(0, 8);
	const detail = entry.firstMessage && entry.firstMessage !== entry.title ? entry.firstMessage : shortId;
	return {
		category: "sessions",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: entry.title,
		description: age,
		nativeDetail: detail,
		state: age,
		icon: "💬",
		iconName: "message",
		pickerItem: {
			id: `session:${entry.id}`,
			label: entry.title,
			detail,
			icon: "message",
			facts: { right: age },
		},
	};
}

/** Past conversations mention source (`@session:`, `@chat:`, `@conv:`). */
export class SessionsMentionSource implements MentionSource {
	readonly id = "sessions" as const;
	readonly label = "Sessions";
	readonly icon = "message";

	readonly #host: SessionsMentionHost;
	#snapshot: SessionSnapshot | undefined;
	#inflight: { cwd: string; promise: Promise<SessionSnapshot | undefined> } | undefined;

	constructor(host: SessionsMentionHost) {
		this.#host = host;
	}

	warm(): void {
		const cwd = this.#host.getCwd();
		if (this.#isFresh(cwd)) return;
		void this.#refresh(cwd);
	}

	#isFresh(cwd: string): boolean {
		const snap = this.#snapshot;
		return snap !== undefined && snap.cwd === cwd && Date.now() - snap.loadedAt < CACHE_TTL_MS;
	}

	#refresh(cwd: string): Promise<SessionSnapshot | undefined> {
		if (this.#inflight?.cwd === cwd) return this.#inflight.promise;
		const { promise, resolve } = Promise.withResolvers<SessionSnapshot | undefined>();
		this.#inflight = { cwd, promise };
		void (async () => {
			try {
				const dir = sessionDirForCwd(cwd);
				try {
					await fs.access(dir);
				} catch {
					const empty: SessionSnapshot = { cwd, entries: [], loadedAt: Date.now() };
					this.#snapshot = empty;
					resolve(empty);
					return;
				}
				const listing = await listSessionsForPicker(dir, new FileSessionStorage(), new Set());
				if (listing.sessions.length > 0) {
					this.#snapshot = { cwd, entries: toSummaries(listing.sessions), loadedAt: Date.now() };
				}
				const full = await listing.complete;
				const snap: SessionSnapshot = {
					cwd,
					entries: toSummaries(full.length > 0 ? full : listing.sessions),
					loadedAt: Date.now(),
				};
				this.#snapshot = snap;
				resolve(snap);
			} catch {
				resolve(this.#snapshot);
			} finally {
				if (this.#inflight?.promise === promise) this.#inflight = undefined;
			}
		})();
		return promise;
	}

	#querySnapshot(q: MentionQuery, snap: SessionSnapshot, loading: boolean): MentionSourceResult {
		const currentId = this.#host.getCurrentSessionId?.();
		const entries = currentId ? snap.entries.filter(e => e.id !== currentId) : snap.entries;
		const explicit = q.syntaxLock === "sessions" || q.pinnedScope === "sessions";
		if (entries.length === 0 && !explicit && !loading) {
			return { category: "sessions", items: [], bestTier: MATCH_TIER.None, total: 0, available: false };
		}

		const trimmed = q.query.trim();
		if (!trimmed) {
			const items = entries.slice(0, MAX_SESSION_ITEMS).map(e => buildSessionItem(e, MATCH_TIER.Medium));
			return {
				category: "sessions",
				items,
				bestTier: items.length > 0 ? MATCH_TIER.Medium : MATCH_TIER.None,
				total: entries.length,
				loading,
				available: entries.length > 0 || explicit,
			};
		}

		const lower = trimmed.toLowerCase();
		const fuzzyQuery = new FuzzyQuery(trimmed);
		const scored: Array<{ item: MentionItem; score: number; modifiedMs: number }> = [];

		for (const entry of entries) {
			const titleLower = entry.title.toLowerCase();
			const idLower = entry.id.toLowerCase();
			let tier: MatchTier | null = null;
			let score = 0;
			if (titleLower === lower || idLower === lower) {
				tier = MATCH_TIER.Exact;
			} else if (
				titleLower.startsWith(lower) ||
				titleLower.includes(` ${lower}`) ||
				(lower.length >= 4 && idLower.startsWith(lower))
			) {
				tier = MATCH_TIER.Strong;
				score = 10;
			} else if (titleLower.includes(lower)) {
				tier = MATCH_TIER.Medium;
				score = 25;
			} else if (explicit) {
				const hit = fuzzyQuery.match(new FuzzyText(`${entry.title} ${entry.firstMessage}`));
				if (hit.matches) {
					tier = MATCH_TIER.Weak;
					score = 60 + hit.score;
				}
			}
			if (tier === null) continue;
			scored.push({ item: buildSessionItem(entry, tier), score, modifiedMs: entry.modifiedMs });
		}

		scored.sort((a, b) => a.item.tier - b.item.tier || a.score - b.score || b.modifiedMs - a.modifiedMs);
		const items = scored.slice(0, MAX_SESSION_ITEMS).map(row => row.item);
		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		return {
			category: "sessions",
			items,
			bestTier,
			total: scored.length,
			loading,
			available: entries.length > 0 || explicit,
		};
	}

	querySync(q: MentionQuery): MentionSourceResult {
		const cwd = this.#host.getCwd();
		const explicit = q.syntaxLock === "sessions" || q.pinnedScope === "sessions";
		const fresh = this.#isFresh(cwd);
		if (!fresh) void this.#refresh(cwd);
		if (this.#snapshot?.cwd === cwd) {
			return this.#querySnapshot(q, this.#snapshot, !fresh && explicit);
		}
		return {
			category: "sessions",
			items: [],
			bestTier: MATCH_TIER.None,
			total: 0,
			loading: explicit,
			available: explicit,
		};
	}

	async queryAsync(
		q: MentionQuery,
		signal: AbortSignal,
		_onPartial: (result: MentionSourceResult) => void,
	): Promise<MentionSourceResult | null> {
		const cwd = this.#host.getCwd();
		if (signal.aborted) return null;
		const snap = this.#isFresh(cwd) ? this.#snapshot : await this.#refresh(cwd);
		if (signal.aborted || !snap) return null;
		return this.#querySnapshot(q, snap, false);
	}
}
