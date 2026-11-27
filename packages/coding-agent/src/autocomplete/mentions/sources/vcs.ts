/**
 * Unified mention source for Git diffs, branches, commits, and tags.
 *
 * Uses a stale-while-revalidate per-repo snapshot backed strictly by
 * `@oh-my-pi/pi-natives/vcs` and {@link listGitTags} (no shell spawning).
 * `headSync()` checks for HEAD movement in <0.1ms on every keystroke; stale
 * snapshots refresh in the background without blocking frame 0.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import { listGitTags } from "../../../internal-urls/git-protocol";
import { FuzzyQuery, FuzzyText } from "../../../utils/fuzzy";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceResult,
} from "../types";

const MAX_VCS_ITEMS = 25;
const COMMIT_LOG_COUNT = 80;
const SNAPSHOT_TTL_MS = 15_000;
const HEX_PREFIX_RE = /^[0-9a-f]{5,40}$/i;
const TAG_HINT_RE = /^v\d/i;

interface CommitEntry {
	readonly sha: string;
	readonly subject: string;
}

interface VcsSnapshot {
	readonly cwd: string;
	readonly headKey: string;
	readonly currentBranch: string | undefined;
	readonly branches: readonly string[];
	readonly commits: readonly CommitEntry[];
	readonly tags: readonly string[];
	readonly dirtyFiles: ReadonlySet<string>;
	/** Tracked paths with staged / unstaged edits (untracked files excluded: `git://diff` skips them). */
	readonly staged: number;
	readonly unstaged: number;
	/** Default branch name, when HEAD is on another branch (base of the branch diff row). */
	readonly defaultBranch: string | undefined;
	readonly loadedAt: number;
}

type DiffRowKind = "uncommitted" | "staged" | "branch";

/** Staged / unstaged tracked-path counts from `git status --porcelain` (XY columns). */
function parsePorcelainCounts(porcelain: string): { staged: number; unstaged: number } {
	let staged = 0;
	let unstaged = 0;
	for (const line of porcelain.split("\n")) {
		if (line.length < 4 || line.startsWith("??") || line.startsWith("!!")) continue;
		if (line[0] !== " ") staged++;
		if (line[1] !== " ") unstaged++;
	}
	return { staged, unstaged };
}

function buildDiffItem(kind: DiffRowKind, detail: string, tier: MatchTier, base?: string): MentionItem {
	const url = kind === "uncommitted" ? "git://diff" : kind === "staged" ? "git://diff/staged" : `git://diff/${base}`;
	const label =
		kind === "uncommitted" ? "Uncommitted changes" : kind === "staged" ? "Staged changes" : `Changes vs ${base}`;
	return {
		category: "vcs",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label,
		description: detail,
		nativeDetail: detail,
		icon: "±",
		iconName: "diff",
		pickerItem: {
			id: `vcs:diff:${kind}:${base ?? ""}`,
			label,
			detail,
			icon: "diff",
			facts: { right: "diff" },
		},
	};
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Diff rows the snapshot supports, most useful first. */
function diffRows(snap: VcsSnapshot): Array<{ kind: DiffRowKind; detail: string; base?: string; keywords: string }> {
	const rows: Array<{ kind: DiffRowKind; detail: string; base?: string; keywords: string }> = [];
	const changed = snap.dirtyFiles.size;
	if (snap.staged > 0 || snap.unstaged > 0) {
		rows.push({
			kind: "uncommitted",
			detail: plural(changed, "file"),
			keywords: "diff changes uncommitted working dirty",
		});
	}
	if (snap.staged > 0) {
		rows.push({ kind: "staged", detail: plural(snap.staged, "file"), keywords: "diff changes staged index cached" });
	}
	if (snap.defaultBranch && snap.currentBranch && snap.currentBranch !== snap.defaultBranch) {
		rows.push({
			kind: "branch",
			base: snap.defaultBranch,
			detail: `${snap.currentBranch} since ${snap.defaultBranch}`,
			keywords: `diff changes branch review pr ${snap.defaultBranch}`,
		});
	}
	return rows;
}

function parseOnelines(lines: readonly string[]): CommitEntry[] {
	const out: CommitEntry[] = [];
	for (const line of lines) {
		const space = line.indexOf(" ");
		if (space <= 0) continue;
		const sha = line.slice(0, space).trim();
		const subject = line.slice(space + 1).trim();
		if (sha) out.push({ sha, subject });
	}
	return out;
}

function parsePorcelainDirtyPaths(porcelain: string): Set<string> {
	const dirty = new Set<string>();
	for (const rawLine of porcelain.split("\n")) {
		if (rawLine.length < 4) continue;
		const rest = rawLine.slice(3).trim();
		if (!rest) continue;
		const arrow = rest.lastIndexOf(" -> ");
		const filePath = arrow >= 0 ? rest.slice(arrow + 4) : rest;
		const unquoted = filePath.startsWith('"') && filePath.endsWith('"') ? filePath.slice(1, -1) : filePath;
		if (unquoted) dirty.add(unquoted.replaceAll("\\", "/"));
	}
	return dirty;
}

function headCacheKey(repo: VcsGitRepo): { key: string; branch: string | undefined } {
	try {
		const head = repo.headSync();
		return {
			key: `${head.kind}:${head.branch ?? ""}:${head.commit ?? ""}`,
			branch: head.branch ?? undefined,
		};
	} catch {
		return { key: "", branch: undefined };
	}
}

function buildBranchItem(name: string, isCurrent: boolean, tier: MatchTier): MentionItem {
	const url = `git://branch/${name}`;
	return {
		category: "vcs",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: name,
		description: isCurrent ? "current branch" : "branch",
		nativeDetail: isCurrent ? "current branch" : "branch",
		state: isCurrent ? "HEAD" : undefined,
		icon: "⎇",
		iconName: "git-branch",
		pickerItem: {
			id: `vcs:branch:${name}`,
			label: name,
			detail: isCurrent ? "current branch" : "branch",
			icon: "git-branch",
			mono: true,
			...(isCurrent ? { dot: "accent" as const, badges: [{ text: "HEAD", tone: "accent" as const }] } : {}),
		},
	};
}

function buildCommitItem(entry: CommitEntry, tier: MatchTier): MentionItem {
	const shortSha = entry.sha.slice(0, 7);
	const url = `git://commit/${shortSha}`;
	return {
		category: "vcs",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: shortSha,
		description: entry.subject,
		nativeDetail: entry.subject,
		state: "commit",
		icon: "○",
		iconName: "commit",
		pickerItem: {
			id: `vcs:commit:${shortSha}`,
			label: shortSha,
			detail: entry.subject,
			icon: "commit",
			mono: true,
			facts: { right: "commit" },
		},
	};
}

function buildTagItem(name: string, tier: MatchTier): MentionItem {
	const url = `git://tag/${name}`;
	return {
		category: "vcs",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: name,
		description: "tag",
		nativeDetail: "tag",
		icon: "⚑",
		iconName: "tag",
		pickerItem: {
			id: `vcs:tag:${name}`,
			label: name,
			detail: "tag",
			icon: "tag",
			mono: true,
			facts: { right: "tag" },
		},
	};
}

interface ScoredVcsItem {
	readonly item: MentionItem;
	readonly kindOrder: number;
	readonly score: number;
}

/** Git/VCS mention source (branches, recent commits, tags) with warm SWR caching. */
export class VcsMentionSource implements MentionSource {
	readonly id = "vcs" as const;
	readonly label = "Git";
	readonly icon = "git-branch";

	readonly #getCwd: () => string;
	#snapshot: VcsSnapshot | undefined;
	#inflight: { cwd: string; promise: Promise<VcsSnapshot | undefined> } | undefined;

	constructor(getCwd: () => string) {
		this.#getCwd = getCwd;
	}

	/** Synchronously return known dirty paths from the cached VCS snapshot (for boosting Files). */
	dirtyFiles(): ReadonlySet<string> {
		const cwd = this.#getCwd();
		if (this.#snapshot?.cwd === cwd) return this.#snapshot.dirtyFiles;
		return new Set();
	}

	/** Kick off a non-blocking background warm of branches, commits, tags, and dirty status. */
	warm(): void {
		const cwd = this.#getCwd();
		const repo = vcs.git(cwd);
		if (!repo) return;
		const { key } = headCacheKey(repo);
		if (this.#isFresh(cwd, key)) return;
		void this.#refresh(cwd, repo, key);
	}

	#isFresh(cwd: string, headKey: string): boolean {
		const snap = this.#snapshot;
		if (!snap || snap.cwd !== cwd) return false;
		if (headKey && snap.headKey !== headKey) return false;
		return Date.now() - snap.loadedAt < SNAPSHOT_TTL_MS;
	}

	#refresh(cwd: string, repo: VcsGitRepo, headKey: string): Promise<VcsSnapshot | undefined> {
		if (this.#inflight?.cwd === cwd) return this.#inflight.promise;
		const { promise, resolve } = Promise.withResolvers<VcsSnapshot | undefined>();
		this.#inflight = { cwd, promise };
		void (async () => {
			try {
				const [branches, onelines, tags, porcelain, defaultBranch] = await Promise.all([
					repo.listBranches(false).catch(() => [] as string[]),
					repo.logOnelines(COMMIT_LOG_COUNT).catch(() => [] as string[]),
					listGitTags(repo).catch(() => [] as string[]),
					repo.statusPorcelain({}).catch(() => ""),
					repo.defaultBranch().catch(() => null),
				]);
				const latest = headCacheKey(repo);
				const snapshot: VcsSnapshot = {
					cwd,
					headKey: latest.key || headKey,
					currentBranch: latest.branch,
					branches,
					commits: parseOnelines(onelines),
					tags,
					dirtyFiles: parsePorcelainDirtyPaths(porcelain),
					...parsePorcelainCounts(porcelain),
					defaultBranch: defaultBranch ?? undefined,
					loadedAt: Date.now(),
				};
				this.#snapshot = snapshot;
				resolve(snapshot);
			} catch {
				resolve(this.#snapshot);
			} finally {
				if (this.#inflight?.promise === promise) this.#inflight = undefined;
			}
		})();
		return promise;
	}

	#querySnapshot(q: MentionQuery, snap: VcsSnapshot, loading: boolean): MentionSourceResult {
		const trimmed = q.query.trim();
		const lower = trimmed.toLowerCase();
		const wantBranches = !q.subKind || q.subKind === "branch";
		const wantCommits = !q.subKind || q.subKind === "commit";
		const wantTags = !q.subKind || q.subKind === "tag";
		const wantDiffs = !q.subKind || q.subKind === "diff";
		const diffs = wantDiffs ? diffRows(snap) : [];

		// Bare query: diffs first, then current branch + latest commits (and tags when scoped to tags).
		if (!trimmed) {
			const items: MentionItem[] = diffs.map(row =>
				buildDiffItem(row.kind, row.detail, MATCH_TIER.Medium, row.base),
			);
			if (wantBranches) {
				const orderedBranches = snap.currentBranch
					? [snap.currentBranch, ...snap.branches.filter(b => b !== snap.currentBranch)]
					: snap.branches;
				const cap = q.subKind === "branch" ? MAX_VCS_ITEMS : 3;
				for (const branch of orderedBranches.slice(0, cap)) {
					items.push(buildBranchItem(branch, branch === snap.currentBranch, MATCH_TIER.Medium));
				}
			}
			if (wantCommits) {
				const cap = q.subKind === "commit" ? MAX_VCS_ITEMS : 3;
				for (const commit of snap.commits.slice(0, cap)) {
					items.push(buildCommitItem(commit, MATCH_TIER.Medium));
				}
			}
			if (wantTags) {
				const cap = q.subKind === "tag" ? MAX_VCS_ITEMS : 2;
				for (const tag of snap.tags.slice(0, cap)) {
					items.push(buildTagItem(tag, MATCH_TIER.Medium));
				}
			}
			const total =
				diffs.length +
				(wantBranches ? snap.branches.length : 0) +
				(wantCommits ? snap.commits.length : 0) +
				(wantTags ? snap.tags.length : 0);
			return {
				category: "vcs",
				items: items.slice(0, MAX_VCS_ITEMS),
				bestTier: items.length > 0 ? MATCH_TIER.Medium : MATCH_TIER.None,
				total,
				loading,
				available: true,
			};
		}

		const fuzzyQuery = new FuzzyQuery(trimmed);
		const looksHex = HEX_PREFIX_RE.test(trimmed);
		const looksTag = TAG_HINT_RE.test(trimmed);
		const looksBranch = trimmed.includes("/");
		const scored: ScoredVcsItem[] = [];

		for (const row of diffs) {
			const words = `${row.keywords} ${row.detail}`.toLowerCase().split(/\s+/);
			let tier: MatchTier | null = null;
			if (words.includes(lower)) tier = MATCH_TIER.Exact;
			else if (words.some(word => word.startsWith(lower))) tier = MATCH_TIER.Strong;
			else if (q.subKind === "diff" && words.some(word => word.includes(lower))) tier = MATCH_TIER.Medium;
			if (tier === null) continue;
			scored.push({ item: buildDiffItem(row.kind, row.detail, tier, row.base), kindOrder: 0, score: 0 });
		}

		if (wantBranches) {
			for (const branch of snap.branches) {
				const bLower = branch.toLowerCase();
				let tier: MatchTier | null = null;
				let score = 0;
				if (bLower === lower) {
					tier = MATCH_TIER.Exact;
				} else if (bLower.startsWith(lower) || bLower.includes(`/${lower}`) || bLower.includes(`-${lower}`)) {
					tier = MATCH_TIER.Strong;
					score = bLower.startsWith(lower) ? 5 : 15;
				} else if (bLower.includes(lower)) {
					tier = MATCH_TIER.Medium;
					score = 30;
				} else {
					const hit = fuzzyQuery.match(new FuzzyText(branch));
					if (hit.matches) {
						tier = MATCH_TIER.Weak;
						score = 60 + hit.score;
					}
				}
				if (tier === null) continue;
				const currentBonus = branch === snap.currentBranch ? -3 : 0;
				const kindOrder = looksBranch ? 0 : looksHex || looksTag ? 2 : 0;
				scored.push({
					item: buildBranchItem(branch, branch === snap.currentBranch, tier),
					kindOrder,
					score: score + currentBonus,
				});
			}
		}

		if (wantCommits) {
			for (let idx = 0; idx < snap.commits.length; idx++) {
				const commit = snap.commits[idx]!;
				const shaLower = commit.sha.toLowerCase();
				const subjLower = commit.subject.toLowerCase();
				let tier: MatchTier | null = null;
				let score = idx * 0.1;
				if (shaLower === lower || shaLower.startsWith(lower)) {
					tier = shaLower === lower || lower.length >= 7 ? MATCH_TIER.Exact : MATCH_TIER.Strong;
					score += 0;
				} else if (subjLower.startsWith(lower)) {
					tier = MATCH_TIER.Strong;
					score += 12;
				} else if (subjLower.includes(lower)) {
					tier = MATCH_TIER.Medium;
					score += 25;
				} else {
					const hit = fuzzyQuery.match(new FuzzyText(commit.subject));
					if (hit.matches) {
						tier = MATCH_TIER.Weak;
						score += 70 + hit.score;
					}
				}
				if (tier === null) continue;
				const kindOrder = looksHex ? 0 : 1;
				scored.push({ item: buildCommitItem(commit, tier), kindOrder, score });
			}
		}

		if (wantTags) {
			for (const tag of snap.tags) {
				const tLower = tag.toLowerCase();
				let tier: MatchTier | null = null;
				let score = 0;
				if (tLower === lower) {
					tier = MATCH_TIER.Exact;
				} else if (tLower.startsWith(lower)) {
					tier = MATCH_TIER.Strong;
					score = 8;
				} else if (tLower.includes(lower)) {
					tier = MATCH_TIER.Medium;
					score = 28;
				} else {
					const hit = fuzzyQuery.match(new FuzzyText(tag));
					if (hit.matches) {
						tier = MATCH_TIER.Weak;
						score = 65 + hit.score;
					}
				}
				if (tier === null) continue;
				const kindOrder = looksTag ? 0 : 2;
				scored.push({ item: buildTagItem(tag, tier), kindOrder, score });
			}
		}

		scored.sort((a, b) => a.item.tier - b.item.tier || a.kindOrder - b.kindOrder || a.score - b.score);
		const items = scored.slice(0, MAX_VCS_ITEMS).map(entry => entry.item);
		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		return {
			category: "vcs",
			items,
			bestTier,
			total: scored.length,
			loading,
			available: true,
		};
	}

	querySync(q: MentionQuery): MentionSourceResult {
		const cwd = this.#getCwd();
		const repo = vcs.git(cwd);
		if (!repo) {
			return { category: "vcs", items: [], bestTier: MATCH_TIER.None, total: 0, available: false };
		}
		const { key, branch } = headCacheKey(repo);
		const fresh = this.#isFresh(cwd, key);
		if (this.#snapshot?.cwd === cwd) {
			return this.#querySnapshot(q, this.#snapshot, !fresh);
		}
		// Cold snapshot: still emit HEAD branch synchronously on frame 0 while full refresh runs.
		const cold: VcsSnapshot = {
			cwd,
			headKey: key,
			currentBranch: branch,
			branches: branch ? [branch] : [],
			commits: [],
			tags: [],
			dirtyFiles: new Set(),
			staged: 0,
			unstaged: 0,
			defaultBranch: undefined,
			loadedAt: 0,
		};
		return this.#querySnapshot(q, cold, true);
	}

	async queryAsync(
		q: MentionQuery,
		signal: AbortSignal,
		_onPartial: (result: MentionSourceResult) => void,
	): Promise<MentionSourceResult | null> {
		const cwd = this.#getCwd();
		const repo = vcs.git(cwd);
		if (!repo || signal.aborted) return null;
		const { key } = headCacheKey(repo);
		let snap = this.#snapshot?.cwd === cwd ? this.#snapshot : undefined;
		if (!this.#isFresh(cwd, key)) {
			snap = await this.#refresh(cwd, repo, key);
			if (signal.aborted || !snap) return null;
		}
		if (!snap) return null;

		const base = this.#querySnapshot(q, snap, false);

		// For a hex SHA query not in the top 80 commits, resolve directly via native git.
		const trimmed = q.query.trim();
		if (
			HEX_PREFIX_RE.test(trimmed) &&
			(!q.subKind || q.subKind === "commit") &&
			!base.items.some(
				item =>
					item.value.startsWith("git://commit/") && item.label.toLowerCase().startsWith(trimmed.toLowerCase()),
			)
		) {
			try {
				const details = await repo.commitDetails(trimmed, signal);
				if (signal.aborted) return null;
				const subject = details.message.split("\n", 1)[0]?.trim() ?? "";
				const extra = buildCommitItem({ sha: details.sha, subject }, MATCH_TIER.Exact);
				return {
					...base,
					items: [extra, ...base.items].slice(0, MAX_VCS_ITEMS),
					bestTier: MATCH_TIER.Exact,
					total: base.total + 1,
					loading: false,
				};
			} catch {
				// Not a valid commit SHA; keep snapshot result.
			}
		}

		return base;
	}
}
