/**
 * Unified mention source for GitHub PRs and Issues (`pr://`, `issue://`).
 *
 * Three latency tiers:
 * - Tier 0 (0ms): instant synthetic `pr://<N>` / `issue://<N>` for numeric queries
 *   (preserving `github-ref.ts`), plus <1ms SQLite search over `github_forge_index`.
 * - Tier 0.5 (SWR): background refresh of the repo's recent PRs & issues into SQLite
 *   on a 2-minute soft TTL — never blocks keystrokes or runs outside GitHub repos.
 * - Tier 2 (gated async): 250ms-debounced `gh` search/view ONLY when locked to the
 *   GitHub scope and local SQLite has fewer than 5 matches.
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { tryResolveCurrentRepo } from "../../../tools/gh-common";
import {
	type ForgeIndexEntry,
	getForgeIndexFreshnessSync,
	readForgeIndexSync,
	resolveGithubCacheAuthKey,
	upsertForgeIndex,
} from "../../../tools/github-cache";
import { FuzzyQuery, FuzzyText } from "../../../utils/fuzzy";
import { github } from "../../../utils/github";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceResult,
} from "../types";

const MAX_FORGE_ITEMS = 25;
const SWR_TTL_MS = 120_000;
const LIVE_SEARCH_DEBOUNCE_MS = 250;
const POSITIVE_INT_RE = /^[1-9]\d*$/;

interface GhListRow {
	number?: number;
	title?: string;
	state?: string;
	isDraft?: boolean;
	author?: { login?: string } | string | null;
	updatedAt?: string;
}

function stateBadge(kind: "pr" | "issue", rawState: string): { text: string; tone: TspTone } {
	const state = rawState.toLowerCase();
	if (state === "open") return { text: "open", tone: "success" };
	if (state === "merged") return { text: "merged", tone: "accent" };
	if (state === "draft") return { text: "draft", tone: "muted" };
	if (state === "closed") return { text: "closed", tone: kind === "pr" ? "error" : "muted" };
	return { text: state || "open", tone: "muted" };
}

function formatAuthor(raw: GhListRow["author"]): string {
	if (!raw) return "";
	if (typeof raw === "string") return raw;
	return raw.login ?? "";
}

function formatShortAge(iso: string): string {
	if (!iso) return "";
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
	return `${Math.floor(sec / 86400)}d`;
}

function forgeGlyph(kind: "pr" | "issue"): string {
	return currentTheme().symbols.symbol(kind === "pr" ? "mention.pr" : "mention.issue");
}

function buildIndexedItem(entry: ForgeIndexEntry, tier: MatchTier): MentionItem {
	const url = `${entry.kind}://${entry.number}`;
	const badge = stateBadge(entry.kind, entry.state);
	const iconName = entry.kind === "pr" ? "pr" : "info";
	const glyph = forgeGlyph(entry.kind);
	const age = formatShortAge(entry.updatedAt);
	const author = entry.author ? `@${entry.author}` : "";
	const facts: Record<string, string> = {};
	if (author) facts.meta = author;
	if (age) facts.right = age;

	return {
		category: "forge",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: `#${entry.number}`,
		description: entry.title,
		nativeDetail: entry.title,
		state: [badge.text, author].filter(Boolean).join(" · "),
		icon: glyph,
		iconName,
		pickerItem: {
			id: `forge:${url}`,
			label: `#${entry.number}`,
			detail: entry.title,
			icon: iconName,
			mono: true,
			tone: badge.tone,
			badges: [badge],
			...(facts.meta || facts.right ? { facts } : {}),
		},
	};
}

function buildSyntheticItem(kind: "pr" | "issue", number: string, tier: MatchTier): MentionItem {
	const url = `${kind}://${number}`;
	const label = `${kind === "pr" ? "PR" : "Issue"} #${number}`;
	const description = kind === "pr" ? "GitHub pull request" : "GitHub issue";
	const iconName = kind === "pr" ? "pr" : "info";
	return {
		category: "forge",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label,
		description,
		nativeDetail: description,
		icon: forgeGlyph(kind),
		iconName,
		pickerItem: {
			id: `forge:${url}`,
			label,
			detail: description,
			icon: iconName,
			mono: true,
		},
	};
}

function toIndexEntries(kind: "pr" | "issue", rows: readonly GhListRow[]): Omit<ForgeIndexEntry, "fetchedAt">[] {
	const out: Omit<ForgeIndexEntry, "fetchedAt">[] = [];
	for (const row of rows) {
		if (typeof row.number !== "number" || !Number.isInteger(row.number) || row.number <= 0) continue;
		const title = typeof row.title === "string" ? row.title.trim() : "";
		if (!title) continue;
		const rawState = row.isDraft ? "draft" : typeof row.state === "string" ? row.state.toLowerCase() : "open";
		out.push({
			kind,
			number: row.number,
			title,
			state: rawState,
			author: formatAuthor(row.author),
			updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
		});
	}
	return out;
}

/** GitHub PR & Issue mention source backed by SQLite `github_forge_index` and background SWR. */
export class ForgeMentionSource implements MentionSource {
	readonly id = "forge" as const;
	readonly label = "GitHub";

	readonly #getCwd: () => string;
	readonly #repoByCwd = new Map<string, string | null>();
	readonly #resolvingRepo = new Map<string, Promise<string | null>>();
	readonly #refreshing = new Map<string, Promise<void>>();

	constructor(getCwd: () => string) {
		this.#getCwd = getCwd;
	}

	/** Kick off non-blocking repo resolution and SQLite index SWR warm. */
	warm(): void {
		const cwd = this.#getCwd();
		if (!vcs.git(cwd) || !github.available()) return;
		void this.#ensureRepo(cwd).then(repo => {
			if (repo) void this.#refreshIndexIfStale(cwd, repo);
		});
	}

	#ensureRepo(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const cached = this.#repoByCwd.get(cwd);
		if (cached !== undefined) return Promise.resolve(cached);
		const existing = this.#resolvingRepo.get(cwd);
		if (existing) return existing;
		const promise = tryResolveCurrentRepo(cwd, signal)
			.then(repo => {
				const resolved = repo ?? null;
				this.#repoByCwd.set(cwd, resolved);
				return resolved;
			})
			.catch(() => {
				this.#repoByCwd.set(cwd, null);
				return null;
			})
			.finally(() => {
				this.#resolvingRepo.delete(cwd);
			});
		this.#resolvingRepo.set(cwd, promise);
		return promise;
	}

	#refreshIndexIfStale(cwd: string, repo: string): Promise<void> | undefined {
		const authKey = resolveGithubCacheAuthKey();
		if (!authKey) return undefined;
		const freshness = getForgeIndexFreshnessSync(repo, authKey);
		if (freshness !== null && Date.now() - freshness < SWR_TTL_MS) return undefined;
		const existing = this.#refreshing.get(repo);
		if (existing) return existing;
		const promise = (async () => {
			try {
				const [prs, issues] = await Promise.all([
					github
						.json<GhListRow[]>(cwd, [
							"pr",
							"list",
							"--repo",
							repo,
							"--state",
							"all",
							"--limit",
							"40",
							"--json",
							"number,title,state,isDraft,author,updatedAt",
						])
						.catch(() => [] as GhListRow[]),
					github
						.json<GhListRow[]>(cwd, [
							"issue",
							"list",
							"--repo",
							repo,
							"--state",
							"all",
							"--limit",
							"40",
							"--json",
							"number,title,state,author,updatedAt",
						])
						.catch(() => [] as GhListRow[]),
				]);
				const entries = [...toIndexEntries("pr", prs), ...toIndexEntries("issue", issues)];
				if (entries.length > 0) upsertForgeIndex(repo, entries, authKey);
			} catch {
				// Offline or unauthenticated; keep any cached entries.
			} finally {
				this.#refreshing.delete(repo);
			}
		})();
		this.#refreshing.set(repo, promise);
		return promise;
	}

	#rankEntries(q: MentionQuery, entries: readonly ForgeIndexEntry[], loading: boolean): MentionSourceResult {
		const trimmed = q.query.trim().replace(/^#/, "");
		const wantPr = !q.subKind || q.subKind === "pr";
		const wantIssue = !q.subKind || q.subKind === "issue";
		const filtered = entries.filter(e => (e.kind === "pr" ? wantPr : wantIssue));

		// Bare query: show most recently updated open PRs/issues first.
		if (!trimmed) {
			const ordered = [...filtered].sort((a, b) => {
				const aOpen = a.state === "open" ? 0 : 1;
				const bOpen = b.state === "open" ? 0 : 1;
				return aOpen - bOpen || b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number;
			});
			const items = ordered.slice(0, MAX_FORGE_ITEMS).map(e => buildIndexedItem(e, MATCH_TIER.Medium));
			return {
				category: "forge",
				items,
				bestTier: items.length > 0 ? MATCH_TIER.Medium : MATCH_TIER.None,
				total: filtered.length,
				loading,
				available: true,
			};
		}

		const isNumeric = POSITIVE_INT_RE.test(trimmed);
		const lower = trimmed.toLowerCase();
		const fuzzyQuery = new FuzzyQuery(trimmed);
		const scored: Array<{ item: MentionItem; score: number }> = [];
		const matchedNumbers = new Set<string>();

		for (const entry of filtered) {
			const numStr = String(entry.number);
			const titleLower = entry.title.toLowerCase();
			const authorLower = entry.author.toLowerCase();
			let tier: MatchTier | null = null;
			let score = 0;
			if (numStr === trimmed) {
				tier = MATCH_TIER.Exact;
				matchedNumbers.add(`${entry.kind}:${numStr}`);
			} else if (isNumeric && numStr.startsWith(trimmed)) {
				tier = MATCH_TIER.Strong;
				score = 5;
			} else if (titleLower.startsWith(lower)) {
				tier = MATCH_TIER.Strong;
				score = 10;
			} else if (titleLower.includes(lower)) {
				tier = MATCH_TIER.Medium;
				score = 25;
			} else if (authorLower && authorLower === lower) {
				tier = MATCH_TIER.Strong;
				score = 18;
			} else {
				const hit = fuzzyQuery.match(new FuzzyText(entry.title));
				if (hit.matches) {
					tier = MATCH_TIER.Weak;
					score = 60 + hit.score;
				}
			}
			if (tier === null) continue;
			const openBonus = entry.state === "open" ? -4 : 0;
			scored.push({ item: buildIndexedItem(entry, tier), score: score + openBonus });
		}

		// Preserve instant synthetic `#<N>` suggestions (enriched when already in SQLite).
		if (isNumeric && (q.trigger === "#" || q.syntaxLock === "forge")) {
			if (wantPr && !matchedNumbers.has(`pr:${trimmed}`)) {
				scored.unshift({ item: buildSyntheticItem("pr", trimmed, MATCH_TIER.Exact), score: -1 });
			}
			if (wantIssue && !matchedNumbers.has(`issue:${trimmed}`)) {
				scored.unshift({ item: buildSyntheticItem("issue", trimmed, MATCH_TIER.Exact), score: 0 });
			}
		}

		scored.sort((a, b) => a.item.tier - b.item.tier || a.score - b.score);
		const items = scored.slice(0, MAX_FORGE_ITEMS).map(entry => entry.item);
		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		return {
			category: "forge",
			items,
			bestTier,
			total: scored.length,
			loading,
			available: true,
		};
	}

	querySync(q: MentionQuery): MentionSourceResult {
		const cwd = this.#getCwd();
		const explicit = q.trigger === "#" || q.syntaxLock === "forge";
		const knownRepo = this.#repoByCwd.get(cwd);
		if (!explicit && (knownRepo === null || !vcs.git(cwd))) {
			return { category: "forge", items: [], bestTier: MATCH_TIER.None, total: 0, available: false };
		}

		const authKey = resolveGithubCacheAuthKey();
		const entries = knownRepo && authKey ? readForgeIndexSync(knownRepo, authKey) : [];
		const freshness = knownRepo && authKey ? getForgeIndexFreshnessSync(knownRepo, authKey) : null;
		const stale = knownRepo === undefined || freshness === null || Date.now() - freshness >= SWR_TTL_MS;

		// Kick off background SWR without blocking frame 0.
		if (stale && github.available() && vcs.git(cwd)) {
			void this.#ensureRepo(cwd).then(repo => {
				if (repo) void this.#refreshIndexIfStale(cwd, repo);
			});
		}

		return this.#rankEntries(q, entries, stale && explicit);
	}

	async queryAsync(
		q: MentionQuery,
		signal: AbortSignal,
		onPartial: (result: MentionSourceResult) => void,
	): Promise<MentionSourceResult | null> {
		const cwd = this.#getCwd();
		if (signal.aborted || !github.available() || !vcs.git(cwd)) return null;
		const explicit = q.trigger === "#" || q.syntaxLock === "forge";

		const repo = await this.#ensureRepo(cwd, signal);
		if (signal.aborted || !repo) return null;

		const authKey = resolveGithubCacheAuthKey();
		if (!authKey) return null;

		// Trigger SWR refresh; only await it when the user is explicitly in GitHub scope
		// (so general `@foo` typing never waits on the network!).
		const refresh = this.#refreshIndexIfStale(cwd, repo);
		if (!explicit) {
			const entries = readForgeIndexSync(repo, authKey);
			return entries.length > 0 ? this.#rankEntries(q, entries, false) : null;
		}

		if (refresh) {
			await refresh;
			if (signal.aborted) return null;
			const updated = this.#rankEntries(q, readForgeIndexSync(repo, authKey), false);
			onPartial(updated);
		}

		// Tier 2 gated live search: debounced 250ms, ONLY when explicitly in GitHub scope
		// and local SQLite had fewer than 5 non-synthetic matches.
		const trimmed = q.query.trim().replace(/^#/, "");
		const currentEntries = readForgeIndexSync(repo, authKey);
		const current = this.#rankEntries(q, currentEntries, false);
		const realHits = current.items.filter(item => !item.description?.startsWith("GitHub "));
		if (trimmed.length < 2 || realHits.length >= 5) return current;

		await Bun.sleep(LIVE_SEARCH_DEBOUNCE_MS);
		if (signal.aborted) return null;

		const wantPr = !q.subKind || q.subKind === "pr";
		const wantIssue = !q.subKind || q.subKind === "issue";
		try {
			const [prs, issues] = await Promise.all([
				wantPr
					? github
							.json<GhListRow[]>(
								cwd,
								[
									"pr",
									"list",
									"--repo",
									repo,
									"--state",
									"all",
									"--search",
									trimmed,
									"--limit",
									"10",
									"--json",
									"number,title,state,isDraft,author,updatedAt",
								],
								signal,
							)
							.catch(() => [] as GhListRow[])
					: Promise.resolve([] as GhListRow[]),
				wantIssue
					? github
							.json<GhListRow[]>(
								cwd,
								[
									"issue",
									"list",
									"--repo",
									repo,
									"--state",
									"all",
									"--search",
									trimmed,
									"--limit",
									"10",
									"--json",
									"number,title,state,author,updatedAt",
								],
								signal,
							)
							.catch(() => [] as GhListRow[])
					: Promise.resolve([] as GhListRow[]),
			]);
			if (signal.aborted) return null;
			const live = [...toIndexEntries("pr", prs), ...toIndexEntries("issue", issues)];
			if (live.length > 0) upsertForgeIndex(repo, live, authKey);
			return this.#rankEntries(q, readForgeIndexSync(repo, authKey), false);
		} catch {
			return current;
		}
	}
}
