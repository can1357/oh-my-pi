/**
 * Memory fabric — git behavioral intelligence.
 *
 * Derives *behavioral* signals from git history — how files actually change
 * together, who owns them, how hot they are — and turns them into pre-edit
 * guardian advisories. Disabled by default (`DEFAULT_GIT_INTELLIGENCE_CONFIG.enabled === false`,
 * `mode === "observe"`): nothing surfaces to the model until explicitly enabled.
 *
 * Everything here is deterministic given (commits, config, now). No network,
 * no LLM, no wall clock unless the caller omits `now`. The only side effect is
 * reading git history through an injectable `RunGit` function, so the whole
 * module is unit-testable without a real repository.
 *
 * Guardrails baked in:
 *  - Cold-start silence: `insufficient` history suppresses advisories entirely;
 *    `limited` history marks them provisional and downgrades `active` to `suggest`.
 *  - Bounded working-tree overlay (`<= config.workingTree.maxBoost`).
 *  - Observe mode never surfaces to the model (the decision is still traced).
 *  - Every query on the facade fails open (null / empty / zero) when disabled,
 *    cold, or the history read failed.
 */

// ---------------------------------------------------------------------------
// History primitives
// ---------------------------------------------------------------------------

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface GitFileChange {
	path: string;
	previousPath?: string;
	status: FileChangeStatus;
	additions: number;
	deletions: number;
	binary: boolean;
}

export interface GitCommitRecord {
	sha: string;
	parentIds: string[];
	/** ISO-8601 author date. */
	authoredAt: string;
	/** ISO-8601 committer date. */
	committedAt: string;
	authorName: string;
	authorEmail: string;
	subject: string;
	files: GitFileChange[];
	isMerge: boolean;
	isRevert: boolean;
}

export interface RunGitResult {
	stdout: string;
	exitCode: number;
}

/** Injectable git runner so history reads are testable without a real repo. */
export type RunGit = (args: string[], opts: { cwd: string }) => Promise<RunGitResult>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TimeDecayPolicy {
	halfLifeDays: number;
	minWeight: number;
}

export interface ChurnPolicy {
	firstParentOnly: boolean;
	includeMerges: boolean;
	decay: TimeDecayPolicy;
}

export interface CoChangePolicy {
	includeMerges: boolean;
	decay: TimeDecayPolicy;
	topK: number;
	maxFilesPerCommit: number;
	minShared: number;
	findCopies: boolean;
}

export interface ContributionPolicy {
	includeMerges: boolean;
	decay: TimeDecayPolicy;
	busFactorThreshold: number;
}

export interface ColdStartPolicy {
	minCommits: number;
	minActiveDays: number;
	minSpanDays: number;
}

export type AdvisoryMode = "observe" | "suggest" | "active";

export interface GitIntelligenceConfig {
	/** Master switch. Default: false. */
	enabled: boolean;
	/** Rollout mode. Default: observe (never surfaces to the model). */
	mode: AdvisoryMode;
	churn: ChurnPolicy;
	coChange: CoChangePolicy;
	contribution: ContributionPolicy;
	coldStart: ColdStartPolicy;
	workingTree: { enabled: boolean; maxBoost: number };
	/** Emit an advisory only when riskScore >= this (or related tests exist). */
	riskThreshold: number;
	maxSuggestions: number;
}

export const DEFAULT_GIT_INTELLIGENCE_CONFIG: GitIntelligenceConfig = {
	enabled: false,
	mode: "observe",
	churn: {
		firstParentOnly: true,
		includeMerges: true,
		decay: { halfLifeDays: 270, minWeight: 0.01 },
	},
	coChange: {
		includeMerges: false,
		decay: { halfLifeDays: 180, minWeight: 0.01 },
		topK: 25,
		maxFilesPerCommit: 100,
		minShared: 2,
		findCopies: false,
	},
	contribution: {
		includeMerges: false,
		decay: { halfLifeDays: 365, minWeight: 0.01 },
		busFactorThreshold: 0.8,
	},
	coldStart: {
		minCommits: 50,
		minActiveDays: 14,
		minSpanDays: 30,
	},
	workingTree: { enabled: true, maxBoost: 0.1 },
	riskThreshold: 0.35,
	maxSuggestions: 5,
};

// ---------------------------------------------------------------------------
// Path identity / lineage
// ---------------------------------------------------------------------------

export type LineageEventKind = "added" | "renamed" | "copied" | "deleted" | "restored";

export interface LineageEvent {
	kind: LineageEventKind;
	sha: string;
	at: string;
	fromPath?: string;
	toPath?: string;
}

export interface PathIdentity {
	id: string;
	currentPath: string;
	historicalPaths: string[];
	lineage: LineageEvent[];
	createdAt: string;
	lastSeenAt: string;
	alive: boolean;
	/** Lowered when lineage is ambiguous (e.g. two files converge on one path). */
	confidence: number;
	copiedFromId?: string;
}

export interface PathIdentityIndex {
	identities: Map<string, PathIdentity>;
	/** Any historical or current path -> identity id (latest write wins). */
	byPath: Map<string, string>;
	resolve(path: string): PathIdentity | undefined;
}

const TEST_PATH_RE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestPath(path: string): boolean {
	return TEST_PATH_RE.test(path);
}

function commitOrder(a: GitCommitRecord, b: GitCommitRecord): number {
	const ta = Date.parse(a.committedAt);
	const tb = Date.parse(b.committedAt);
	if (ta !== tb) return ta - tb;
	return a.sha.localeCompare(b.sha);
}

/**
 * Files are renamed, copied, deleted and restored over their lifetime. Churn
 * and co-change must follow the *identity* of a file, not its current path, or
 * every rename silently resets a file's history. This builds stable identities
 * by replaying commits oldest-first and tracking rename/copy/delete lineage.
 * Ambiguity (two live files converging on one path) lowers confidence rather
 * than destructively merging histories.
 */
export function buildPathIdentities(commits: GitCommitRecord[]): PathIdentityIndex {
	const identities = new Map<string, PathIdentity>();
	const byPath = new Map<string, string>();
	let seq = 0;

	const chronological = [...commits].sort(commitOrder);

	const newIdentity = (path: string, at: string, copiedFromId?: string): PathIdentity => {
		const id = `pi_${(seq++).toString(36)}`;
		const identity: PathIdentity = {
			id,
			currentPath: path,
			historicalPaths: [path],
			lineage: [{ kind: copiedFromId ? "copied" : "added", sha: "", at, toPath: path }],
			createdAt: at,
			lastSeenAt: at,
			alive: true,
			confidence: 1,
			copiedFromId,
		};
		identities.set(id, identity);
		byPath.set(path, id);
		return identity;
	};

	for (const commit of chronological) {
		const at = commit.committedAt;
		for (const file of commit.files) {
			if (file.status === "renamed" && file.previousPath) {
				const fromId = byPath.get(file.previousPath);
				const identity = fromId ? identities.get(fromId) : undefined;
				if (fromId && identity) {
					const targetId = byPath.get(file.path);
					if (targetId && targetId !== fromId && identities.get(targetId)?.alive) {
						// Convergence: two live identities collide on one path.
						identity.confidence = Math.min(identity.confidence, 0.5);
					}
					if (!identity.historicalPaths.includes(file.path)) identity.historicalPaths.push(file.path);
					// Keep the old path resolvable so pre-rename commits still map to
					// this identity (latest write wins if a new file reuses the path).
					identity.currentPath = file.path;
					identity.lastSeenAt = at;
					identity.alive = true;
					identity.lineage.push({
						kind: "renamed",
						sha: commit.sha,
						at,
						fromPath: file.previousPath,
						toPath: file.path,
					});
					byPath.set(file.path, fromId);
				} else {
					newIdentity(file.path, at);
				}
			} else if (file.status === "copied") {
				const srcId = file.previousPath ? byPath.get(file.previousPath) : undefined;
				newIdentity(file.path, at, srcId);
			} else if (file.status === "deleted") {
				const id = byPath.get(file.path);
				const identity = id ? identities.get(id) : undefined;
				if (identity) {
					identity.alive = false;
					identity.lastSeenAt = at;
					identity.lineage.push({ kind: "deleted", sha: commit.sha, at, toPath: file.path });
				}
			} else if (file.status === "added") {
				const existingId = byPath.get(file.path);
				const existing = existingId ? identities.get(existingId) : undefined;
				if (existing && !existing.alive) {
					existing.alive = true;
					existing.lastSeenAt = at;
					existing.lineage.push({ kind: "restored", sha: commit.sha, at, toPath: file.path });
				} else if (existing) {
					existing.lastSeenAt = at;
				} else {
					newIdentity(file.path, at);
				}
			} else {
				// modified
				const existingId = byPath.get(file.path);
				const existing = existingId ? identities.get(existingId) : undefined;
				if (existing) {
					existing.lastSeenAt = at;
					existing.alive = true;
				} else {
					newIdentity(file.path, at);
				}
			}
		}
	}

	const resolve = (path: string): PathIdentity | undefined => {
		const id = byPath.get(path);
		return id ? identities.get(id) : undefined;
	};

	return { identities, byPath, resolve };
}

/** Convenience: map a commit's file changes to their identity ids (deduped). */
export function resolveCommitIdentities(
	commit: GitCommitRecord,
	index: PathIdentityIndex,
): Array<{ id: string; path: string }> {
	const out: Array<{ id: string; path: string }> = [];
	const seen = new Set<string>();
	for (const file of commit.files) {
		const identity = index.resolve(file.path) ?? (file.previousPath ? index.resolve(file.previousPath) : undefined);
		if (identity && !seen.has(identity.id)) {
			seen.add(identity.id);
			out.push({ id: identity.id, path: identity.currentPath });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// History reader (pure parser over a deterministic framing)
// ---------------------------------------------------------------------------

const REC = "\x1e";
const FS = "\x1f";

/**
 * Framing requested from git:
 *   git log -z --numstat [--find-renames|--find-copies] --format=<FMT>
 *   FMT = \x1e %H \x1f %P \x1f %aI \x1f %cI \x1f %an \x1f %ae \x1f %s
 *
 * With `-z`, each commit's header block is followed by NUL-separated numstat
 * entries; renames/copies emit an empty path field followed by two extra
 * NUL-separated tokens (old, new). `\x1e` (record sep) and `\x1f` (unit sep)
 * do not occur in git object metadata, so they are safe sentinels.
 */
export const GIT_LOG_FORMAT = `${REC}%H${FS}%P${FS}%aI${FS}%cI${FS}%an${FS}%ae${FS}%s`;

export interface BuildLogArgsOptions {
	range?: string;
	findCopies?: boolean;
	maxCount?: number;
	firstParentOnly?: boolean;
}

export function buildLogArgs(opts: BuildLogArgsOptions = {}): string[] {
	const args = ["log", "-z", "--numstat", `--format=${GIT_LOG_FORMAT}`];
	args.push(opts.findCopies ? "--find-copies" : "--find-renames");
	if (opts.firstParentOnly) args.push("--first-parent");
	if (typeof opts.maxCount === "number") args.push(`--max-count=${opts.maxCount}`);
	if (opts.range) args.push(opts.range);
	return args;
}

function parseNumstatValue(v: string): { n: number; binary: boolean } {
	// Real `git log -z` can leave a stray record/newline separator glued to the
	// front of a numstat value between commits; trim so "\n-" is still detected
	// as binary and "\n5" still parses as 5.
	const t = v.trim();
	if (t === "-") return { n: 0, binary: true };
	const n = Number.parseInt(t, 10);
	return { n: Number.isFinite(n) ? n : 0, binary: false };
}

function classifyChange(
	prev: string | undefined,
	additions: number,
	deletions: number,
	copied: boolean,
): FileChangeStatus {
	if (copied) return "copied";
	if (prev) return "renamed";
	if (deletions > 0 && additions === 0) return "deleted";
	if (additions > 0 && deletions === 0) return "added";
	return "modified";
}

function parseNumstatBlock(blob: string): GitFileChange[] {
	// Tokens are NUL-separated. A normal entry is a single token "add\tdel\tpath".
	// A rename/copy entry is "add\tdel\t" (empty path) followed by two tokens
	// old, new.
	const tokens = blob.split("\0");
	const files: GitFileChange[] = [];
	let i = 0;
	while (i < tokens.length) {
		const tok = tokens[i] ?? "";
		if (tok === "" || tok === REC) {
			i++;
			continue;
		}
		if (!tok.includes("\t")) {
			i++;
			continue;
		}
		const parts = tok.split("\t");
		const add = parseNumstatValue(parts[0] ?? "0");
		const del = parseNumstatValue(parts[1] ?? "0");
		const inlinePath = parts.slice(2).join("\t");
		if (inlinePath === "") {
			// Rename/copy: the next two tokens are old, new.
			const oldPath = tokens[i + 1] ?? "";
			const newPath = tokens[i + 2] ?? "";
			i += 3;
			files.push({
				path: newPath,
				previousPath: oldPath || undefined,
				status: classifyChange(oldPath, add.n, del.n, false),
				additions: add.n,
				deletions: del.n,
				binary: add.binary || del.binary,
			});
		} else {
			i++;
			files.push({
				path: inlinePath,
				status: classifyChange(undefined, add.n, del.n, false),
				additions: add.n,
				deletions: del.n,
				binary: add.binary || del.binary,
			});
		}
	}
	return files;
}

/** Pure parser for the framing produced by `buildLogArgs()`. */
export function parseGitLog(raw: string): GitCommitRecord[] {
	if (!raw) return [];
	const chunks = raw.split(REC);
	const commits: GitCommitRecord[] = [];
	for (const chunk of chunks) {
		if (!chunk) continue;
		// The header runs until the first NUL (from -z terminating the format).
		const nul = chunk.indexOf("\0");
		const header = nul >= 0 ? chunk.slice(0, nul) : chunk;
		const numstatBlob = nul >= 0 ? chunk.slice(nul + 1) : "";
		const fields = header.split(FS);
		if (fields.length < 7) continue;
		// A stray inter-record separator can glue onto the leading sha field.
		const sha = (fields[0] ?? "").trim();
		const parentsRaw = (fields[1] ?? "").trim();
		const authoredAt = fields[2] ?? "";
		const committedAt = fields[3] ?? "";
		const authorName = fields[4] ?? "";
		const authorEmail = fields[5] ?? "";
		const subject = fields.slice(6).join(FS);
		const parentIds = parentsRaw ? parentsRaw.split(/\s+/) : [];
		commits.push({
			sha,
			parentIds,
			authoredAt,
			committedAt,
			authorName,
			authorEmail,
			subject,
			files: parseNumstatBlock(numstatBlob),
			isMerge: parentIds.length > 1,
			isRevert: /^Revert\b/.test(subject),
		});
	}
	return commits;
}

export interface ReadHistoryOptions extends BuildLogArgsOptions {
	cwd: string;
	runGit: RunGit;
}

/**
 * Reads git history via the injected runner and parses it. Never throws for
 * empty history; propagates hard runner failures to the caller (which should
 * treat git intelligence as unavailable / fail open).
 */
export async function readHistory(opts: ReadHistoryOptions): Promise<GitCommitRecord[]> {
	const args = buildLogArgs(opts);
	const result = await opts.runGit(args, { cwd: opts.cwd });
	if (result.exitCode !== 0) {
		throw new Error(`git log failed with exit code ${result.exitCode}`);
	}
	return parseGitLog(result.stdout);
}

// ---------------------------------------------------------------------------
// Analyzers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** weight(ageDays) = max(minWeight, 2^(-ageDays / halfLifeDays)) — recent behavior dominates. */
export function decayWeight(ageDays: number, policy: TimeDecayPolicy): number {
	if (ageDays <= 0) return 1;
	return Math.max(policy.minWeight, 2 ** (-ageDays / policy.halfLifeDays));
}

function ageInDays(at: string, now: number): number {
	return Math.max(0, (now - Date.parse(at)) / DAY_MS);
}

export type HistoryQualityLevel = "insufficient" | "limited" | "sufficient";

export interface HistoryQualityReport {
	level: HistoryQualityLevel;
	commitCount: number;
	activeDays: number;
	spanDays: number;
	reasons: string[];
}

/** Cold-start gate: grades how much signal the history can actually support. */
export function assessHistoryQuality(commits: GitCommitRecord[], config: GitIntelligenceConfig): HistoryQualityReport {
	const reasons: string[] = [];
	const nonMerge = commits.filter(c => !c.isMerge);
	const days = new Set(nonMerge.map(c => c.committedAt.slice(0, 10)));
	const times = nonMerge.map(c => Date.parse(c.committedAt)).filter(t => Number.isFinite(t));
	const spanDays = times.length ? (Math.max(...times) - Math.min(...times)) / DAY_MS : 0;
	const commitCount = nonMerge.length;
	const activeDays = days.size;

	const { minCommits, minActiveDays, minSpanDays } = config.coldStart;
	if (commitCount < minCommits) reasons.push(`commits ${commitCount}<${minCommits}`);
	if (activeDays < minActiveDays) reasons.push(`activeDays ${activeDays}<${minActiveDays}`);
	if (spanDays < minSpanDays) reasons.push(`spanDays ${spanDays.toFixed(0)}<${minSpanDays}`);

	let level: HistoryQualityLevel;
	if (commitCount < Math.ceil(minCommits / 5) || activeDays < 2) level = "insufficient";
	else if (reasons.length > 0) level = "limited";
	else level = "sufficient";

	return { level, commitCount, activeDays, spanDays, reasons };
}

export interface FileChurnMetrics {
	id: string;
	path: string;
	commitCount: number;
	decayedCommitCount: number;
	additions: number;
	deletions: number;
	lastChangedAt: string;
	/** Rank in [0,1] across all identities (1 = hottest). */
	churnPercentile: number;
}

export function analyzeChurn(
	commits: GitCommitRecord[],
	index: PathIdentityIndex,
	policy: ChurnPolicy,
	now: number,
): Map<string, FileChurnMetrics> {
	const acc = new Map<string, FileChurnMetrics>();
	for (const commit of commits) {
		if (commit.isMerge && !policy.includeMerges) continue;
		const w = decayWeight(ageInDays(commit.committedAt, now), policy.decay);
		for (const file of commit.files) {
			const identity =
				index.resolve(file.path) ?? (file.previousPath ? index.resolve(file.previousPath) : undefined);
			if (!identity) continue;
			let m = acc.get(identity.id);
			if (!m) {
				m = {
					id: identity.id,
					path: identity.currentPath,
					commitCount: 0,
					decayedCommitCount: 0,
					additions: 0,
					deletions: 0,
					lastChangedAt: commit.committedAt,
					churnPercentile: 0,
				};
				acc.set(identity.id, m);
			}
			m.commitCount += 1;
			m.decayedCommitCount += w;
			m.additions += file.additions;
			m.deletions += file.deletions;
			if (Date.parse(commit.committedAt) > Date.parse(m.lastChangedAt)) m.lastChangedAt = commit.committedAt;
		}
	}
	const sorted = [...acc.values()].sort((a, b) => a.decayedCommitCount - b.decayedCommitCount);
	const n = sorted.length;
	sorted.forEach((m, i) => {
		m.churnPercentile = n <= 1 ? 1 : i / (n - 1);
	});
	return acc;
}

export interface CoChangePartner {
	id: string;
	path: string;
	/** Time-decayed, large-commit-adjusted association weight. */
	weight: number;
	/** Number of commits in which the pair changed together. */
	rawSupport: number;
	/** P(partner | target) estimate in [0,1]. */
	confidence: number;
	lastChangedTogetherAt: string;
	isTest: boolean;
}

export interface SparseCoChangeIndex {
	/** identity id -> top-K partners (descending weight). */
	partners: Map<string, CoChangePartner[]>;
	topK: number;
	totalEdges: number;
	prunedEdges: number;
}

function pruneTopK(map: Map<string, CoChangePartner>, topK: number): number {
	if (map.size <= topK) return 0;
	const sorted = [...map.entries()].sort((a, b) => b[1].weight - a[1].weight);
	let pruned = 0;
	for (let i = topK; i < sorted.length; i++) {
		const entry = sorted[i];
		if (!entry) continue;
		map.delete(entry[0]);
		pruned++;
	}
	return pruned;
}

function addCoChangeEdge(
	edges: Map<string, Map<string, CoChangePartner>>,
	from: { id: string; path: string },
	to: { id: string; path: string },
	weight: number,
	at: string,
): void {
	let map = edges.get(from.id);
	if (!map) {
		map = new Map();
		edges.set(from.id, map);
	}
	const existing = map.get(to.id);
	if (existing) {
		existing.weight += weight;
		existing.rawSupport += 1;
		if (Date.parse(at) > Date.parse(existing.lastChangedTogetherAt)) existing.lastChangedTogetherAt = at;
	} else {
		map.set(to.id, {
			id: to.id,
			path: to.path,
			weight,
			rawSupport: 1,
			confidence: 0,
			lastChangedTogetherAt: at,
			isTest: isTestPath(to.path),
		});
	}
}

/**
 * Sparse top-K co-change: only the top-K partners per identity are retained,
 * pruned during accumulation, so memory stays bounded (<= identities * K
 * edges) even on large repositories. Weight is time-decayed and down-weighted
 * for large commits (`w / log2(members + 1)` — weaker association per pair).
 */
export function analyzeCoChange(
	commits: GitCommitRecord[],
	index: PathIdentityIndex,
	policy: CoChangePolicy,
	now: number,
): SparseCoChangeIndex {
	const edges = new Map<string, Map<string, CoChangePartner>>();
	const changeCount = new Map<string, number>();
	let prunedEdges = 0;
	const pruneEvery = 256;
	let processed = 0;

	for (const commit of commits) {
		if (commit.isMerge && !policy.includeMerges) continue;
		const members = resolveCommitIdentities(commit, index);
		if (members.length < 2 || members.length > policy.maxFilesPerCommit) {
			// Solo change, or a large sprawling commit: count the change but skip
			// the pairwise explosion.
			for (const m of members) changeCount.set(m.id, (changeCount.get(m.id) ?? 0) + 1);
			continue;
		}
		const w = decayWeight(ageInDays(commit.committedAt, now), policy.decay);
		const sizeAdj = w / Math.log2(members.length + 1);
		for (const m of members) changeCount.set(m.id, (changeCount.get(m.id) ?? 0) + 1);
		for (let a = 0; a < members.length; a++) {
			const ma = members[a];
			if (!ma) continue;
			for (let b = a + 1; b < members.length; b++) {
				const mb = members[b];
				if (!mb) continue;
				addCoChangeEdge(edges, ma, mb, sizeAdj, commit.committedAt);
				addCoChangeEdge(edges, mb, ma, sizeAdj, commit.committedAt);
			}
		}
		if (++processed % pruneEvery === 0) {
			for (const partners of edges.values()) prunedEdges += pruneTopK(partners, policy.topK);
		}
	}

	const partners = new Map<string, CoChangePartner[]>();
	let totalEdges = 0;
	for (const [id, map] of edges) {
		prunedEdges += pruneTopK(map, policy.topK);
		const denom = changeCount.get(id) ?? 0;
		const list = [...map.values()]
			.filter(p => p.rawSupport >= policy.minShared)
			.map(p => {
				const d = denom > 0 ? denom : p.rawSupport;
				return { ...p, confidence: d > 0 ? Math.min(1, p.rawSupport / d) : 0 };
			})
			.sort((x, y) => y.weight - x.weight);
		if (list.length) {
			partners.set(id, list);
			totalEdges += list.length;
		}
	}

	return { partners, topK: policy.topK, totalEdges, prunedEdges };
}

export interface RelatedTestRecommendation {
	testId: string;
	testPath: string;
	coChangeConfidence: number;
	rawSupport: number;
}

/** Source-to-test recall: test partners of a source identity, as first-class recommendations. */
export function relatedTests(sourceId: string, coChange: SparseCoChangeIndex, max = 5): RelatedTestRecommendation[] {
	const partners = coChange.partners.get(sourceId) ?? [];
	return partners
		.filter(p => p.isTest)
		.slice(0, max)
		.map(p => ({ testId: p.id, testPath: p.path, coChangeConfidence: p.confidence, rawSupport: p.rawSupport }));
}

export interface AuthorShare {
	authorEmail: string;
	authorName: string;
	/** Decayed contribution share in [0,1]. */
	share: number;
}

export interface ContributionConcentration {
	id: string;
	path: string;
	authors: AuthorShare[];
	/** Min authors covering >= busFactorThreshold of decayed contribution. */
	busFactor: number;
	topAuthorShare: number;
}

export function analyzeContribution(
	commits: GitCommitRecord[],
	index: PathIdentityIndex,
	policy: ContributionPolicy,
	now: number,
): Map<string, ContributionConcentration> {
	const perId = new Map<string, Map<string, { name: string; weight: number }>>();
	for (const commit of commits) {
		if (commit.isMerge && !policy.includeMerges) continue;
		const w = decayWeight(ageInDays(commit.committedAt, now), policy.decay);
		const email = commit.authorEmail.toLowerCase();
		for (const file of commit.files) {
			const identity =
				index.resolve(file.path) ?? (file.previousPath ? index.resolve(file.previousPath) : undefined);
			if (!identity) continue;
			let authors = perId.get(identity.id);
			if (!authors) {
				authors = new Map();
				perId.set(identity.id, authors);
			}
			const cur = authors.get(email) ?? { name: commit.authorName, weight: 0 };
			cur.weight += w;
			authors.set(email, cur);
		}
	}

	const out = new Map<string, ContributionConcentration>();
	for (const [id, authors] of perId) {
		const total = [...authors.values()].reduce((s, a) => s + a.weight, 0) || 1;
		const shares = [...authors.entries()]
			.map(([e, a]) => ({ authorEmail: e, authorName: a.name, share: a.weight / total }))
			.sort((x, y) => y.share - x.share);
		let acc = 0;
		let busFactor = 0;
		for (const s of shares) {
			acc += s.share;
			busFactor++;
			if (acc >= policy.busFactorThreshold) break;
		}
		out.set(id, {
			id,
			path: index.identities.get(id)?.currentPath ?? id,
			authors: shares,
			busFactor,
			topAuthorShare: shares[0]?.share ?? 0,
		});
	}
	return out;
}

export interface AnalysisResult {
	index: PathIdentityIndex;
	quality: HistoryQualityReport;
	churn: Map<string, FileChurnMetrics>;
	coChange: SparseCoChangeIndex;
	contribution: Map<string, ContributionConcentration>;
}

export function analyze(commits: GitCommitRecord[], config: GitIntelligenceConfig, now: number): AnalysisResult {
	const index = buildPathIdentities(commits);
	return {
		index,
		quality: assessHistoryQuality(commits, config),
		churn: analyzeChurn(commits, index, config.churn, now),
		coChange: analyzeCoChange(commits, index, config.coChange, now),
		contribution: analyzeContribution(commits, index, config.contribution, now),
	};
}

// ---------------------------------------------------------------------------
// Guardian advisory
// ---------------------------------------------------------------------------

export type AdvisoryDisposition = "suppressed" | "emitted";

export interface RiskFactor {
	name: string;
	weight: number;
	/** [0,1]; -1 means "unavailable" and the factor is excluded from the score. */
	value: number;
	/** weight*value after normalization over available factors. */
	contribution: number;
}

export interface WorkingTreeActivity {
	/** Paths currently modified/staged in the working tree. */
	dirtyPaths: Set<string>;
	/** Bounded boost (<= config maxBoost) applied to co-change of dirty neighbours. */
	maxBoost: number;
}

export interface AdvisoryDecisionTrace {
	disposition: AdvisoryDisposition;
	mode: AdvisoryMode;
	targetPath: string;
	targetId?: string;
	/** [0,1]. */
	riskScore: number;
	provisional: boolean;
	factors: RiskFactor[];
	relatedTests: RelatedTestRecommendation[];
	coChangeSuggestions: CoChangePartner[];
	ownership?: ContributionConcentration;
	historyQuality: HistoryQualityLevel;
	reasons: string[];
}

/** Shape-compatible with the session-integration MemoryToolAdvisory. */
export interface ToolAdvisory {
	text: string;
	memoryIds: string[];
	severity: "info" | "warning" | "critical";
}

export interface AdvisoryInput {
	targetPath: string;
	analysis: AnalysisResult;
	config: GitIntelligenceConfig;
	workingTree?: WorkingTreeActivity;
	now?: number;
}

function normalizeFactors(factors: RiskFactor[]): { score: number; provisional: boolean } {
	const available = factors.filter(f => f.value >= 0);
	const totalWeight = available.reduce((s, f) => s + f.weight, 0);
	if (totalWeight === 0) return { score: 0, provisional: true };
	let score = 0;
	for (const f of available) {
		f.contribution = (f.weight / totalWeight) * f.value;
		score += f.contribution;
	}
	// Provisional if fewer than all intended signals were available.
	const provisional = available.length < factors.length;
	return { score: Math.max(0, Math.min(1, score)), provisional };
}

/**
 * Turns analysis signals into a pre-edit advisory decision for a target file:
 * a fully explainable decision trace (factor breakdown, reasons, disposition)
 * that `toToolAdvisory` renders into a compact model-facing advisory.
 */
export function evaluateAdvisory(input: AdvisoryInput): AdvisoryDecisionTrace {
	const { targetPath, analysis, config } = input;
	const reasons: string[] = [];
	const identity = analysis.index.resolve(targetPath);
	const targetId = identity?.id;

	const churn = targetId ? analysis.churn.get(targetId) : undefined;
	const ownership = targetId ? analysis.contribution.get(targetId) : undefined;
	let partners: CoChangePartner[] = targetId ? (analysis.coChange.partners.get(targetId) ?? []) : [];

	// Working-tree overlay: bounded boost for dirty neighbours.
	const workingTree = input.workingTree;
	if (config.workingTree.enabled && workingTree) {
		const maxBoost = Math.min(config.workingTree.maxBoost, workingTree.maxBoost);
		partners = partners
			.map(p =>
				workingTree.dirtyPaths.has(p.path)
					? { ...p, weight: p.weight + Math.min(maxBoost, maxBoost * p.confidence) }
					: p,
			)
			.sort((a, b) => b.weight - a.weight);
	}

	const tests = targetId ? relatedTests(targetId, analysis.coChange, config.maxSuggestions) : [];
	const coChangeSuggestions = partners.filter(p => !p.isTest).slice(0, config.maxSuggestions);
	const topSuggestion = coChangeSuggestions[0];

	// Risk factors (value in [0,1]; -1 means "unavailable" -> excluded).
	const factors: RiskFactor[] = [
		{ name: "churn", weight: 0.3, value: churn ? churn.churnPercentile : -1, contribution: 0 },
		{
			name: "coupling",
			weight: 0.3,
			value: topSuggestion ? Math.min(1, topSuggestion.confidence + coChangeSuggestions.length / 10) : -1,
			contribution: 0,
		},
		{
			name: "ownership",
			weight: 0.25,
			value: ownership ? (ownership.busFactor <= 1 ? 1 : ownership.busFactor === 2 ? 0.5 : 0.2) : -1,
			contribution: 0,
		},
		{
			name: "test-gap",
			weight: 0.15,
			value: coChangeSuggestions.length > 0 && tests.length === 0 ? 1 : tests.length > 0 ? 0.2 : -1,
			contribution: 0,
		},
	];

	const { score, provisional } = normalizeFactors(factors);

	// Cold-start gating.
	const historyQuality = analysis.quality.level;
	let disposition: AdvisoryDisposition = "suppressed";
	let mode = config.mode;

	if (!config.enabled) {
		reasons.push("disabled");
	} else if (historyQuality === "insufficient") {
		reasons.push(`cold-start-silence: ${analysis.quality.reasons.join(", ")}`);
	} else if (score < config.riskThreshold && tests.length === 0) {
		reasons.push(`below-threshold ${score.toFixed(2)}<${config.riskThreshold}`);
	} else {
		if (historyQuality === "limited") {
			mode = mode === "active" ? "suggest" : mode;
			reasons.push("provisional: limited history");
		}
		reasons.push(`risk ${score.toFixed(2)} >= ${config.riskThreshold} or related tests present`);
		disposition = mode === "observe" ? "suppressed" : "emitted";
		if (mode === "observe") reasons.push("observe-mode: traced but not surfaced");
	}

	return {
		disposition,
		mode,
		targetPath,
		targetId,
		riskScore: score,
		provisional: provisional || historyQuality === "limited",
		factors,
		relatedTests: tests,
		coChangeSuggestions,
		ownership,
		historyQuality,
		reasons,
	};
}

export function renderAdvisoryText(trace: AdvisoryDecisionTrace): string {
	const lines: string[] = [];
	const risk = Math.round(trace.riskScore * 100);
	lines.push(
		`Git behavioral note for \`${trace.targetPath}\` (risk ${risk}%${trace.provisional ? ", provisional" : ""}):`,
	);
	if (trace.ownership && trace.ownership.busFactor <= 1) {
		const share = Math.round(trace.ownership.topAuthorShare * 100);
		const owner = trace.ownership.authors[0]?.authorName ?? "one author";
		lines.push(`- Bus factor 1 — ${share}% by ${owner}.`);
	}
	if (trace.coChangeSuggestions.length) {
		const names = trace.coChangeSuggestions
			.slice(0, 3)
			.map(p => `\`${p.path}\` (${Math.round(p.confidence * 100)}%)`);
		lines.push(`- Frequently changes with: ${names.join(", ")}.`);
	}
	if (trace.relatedTests.length) {
		const t = trace.relatedTests.slice(0, 3).map(r => `\`${r.testPath}\``);
		lines.push(`- Related tests to update: ${t.join(", ")}.`);
	} else if (trace.factors.find(f => f.name === "test-gap")?.value === 1) {
		lines.push("- No co-changing test detected — consider adding coverage.");
	}
	return lines.join("\n");
}

/** Model-facing advisory; null unless the trace was actually emitted. */
export function toToolAdvisory(trace: AdvisoryDecisionTrace): ToolAdvisory | null {
	if (trace.disposition !== "emitted") return null;
	const severity: ToolAdvisory["severity"] = trace.riskScore >= 0.7 ? "warning" : "info";
	return {
		text: renderAdvisoryText(trace),
		memoryIds: [],
		severity,
	};
}

// ---------------------------------------------------------------------------
// Feedback & evidence loop
// ---------------------------------------------------------------------------

/** Terminal outcome of an advisory, observed at the following tool boundary. */
export type AdvisoryOutcome =
	/** Advisory surfaced and the edit still proceeded (informational accept). */
	| "surfaced-proceeded"
	/** Advisory was suppressed (observe mode / cold-start / below threshold). */
	| "suppressed"
	/** No trace to offer (disabled / cold / unavailable). */
	| "no-advisory";

/** One immutable advisory-outcome record. */
export interface FeedbackEvent {
	readonly kind: "gi-advisory-feedback";
	readonly schemaVersion: 1;
	/** Deterministic id: hash of (projectId, targetPath, decidedAt). */
	readonly id: string;
	readonly projectId: string;
	readonly targetPath: string;
	readonly targetId?: string;
	readonly disposition: AdvisoryDisposition;
	readonly mode: AdvisoryMode;
	readonly outcome: AdvisoryOutcome;
	readonly riskScore: number;
	readonly provisional: boolean;
	readonly historyQuality: HistoryQualityLevel;
	readonly relatedTestCount: number;
	readonly coChangeCount: number;
	/** Wall-clock cost of producing the advisory (ms). */
	readonly latencyMs: number;
	/** Approximate token cost of the surfaced advisory text (0 when suppressed). */
	readonly tokenCount: number;
	readonly decidedAt: string;
}

export interface MakeFeedbackEventInput {
	projectId: string;
	trace: AdvisoryDecisionTrace;
	outcome: AdvisoryOutcome;
	latencyMs: number;
	/** Surfaced advisory text (used to estimate token cost); empty when none. */
	advisoryText?: string;
	now?: () => Date;
	hash?: (text: string) => string;
}

/** ~4 chars/token heuristic — deterministic, no tokenizer dependency. */
export function estimateTokens(text: string): number {
	return text ? Math.ceil(text.length / 4) : 0;
}

/** Small deterministic non-crypto hash (djb2), base36. Test-overridable. */
export function defaultHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** Build a frozen (immutable) FeedbackEvent from an advisory decision. */
export function makeFeedbackEvent(input: MakeFeedbackEventInput): FeedbackEvent {
	const now = (input.now ?? (() => new Date()))();
	const hash = input.hash ?? defaultHash;
	const decidedAt = now.toISOString();
	const { trace } = input;
	const event: FeedbackEvent = {
		kind: "gi-advisory-feedback",
		schemaVersion: 1,
		id: `fb_${hash(`${input.projectId}|${trace.targetPath}|${decidedAt}`)}`,
		projectId: input.projectId,
		targetPath: trace.targetPath,
		targetId: trace.targetId,
		disposition: trace.disposition,
		mode: trace.mode,
		outcome: input.outcome,
		riskScore: trace.riskScore,
		provisional: trace.provisional,
		historyQuality: trace.historyQuality,
		relatedTestCount: trace.relatedTests.length,
		coChangeCount: trace.coChangeSuggestions.length,
		latencyMs: Math.max(0, input.latencyMs),
		tokenCount: estimateTokens(input.advisoryText ?? ""),
		decidedAt,
	};
	return Object.freeze(event);
}

/** Append-only sink for feedback events. Return value ignored; must not throw. */
export type FeedbackJournalSink = (event: FeedbackEvent) => void | Promise<void>;

/** In-memory append-only journal for tests and evidence collection. */
export class InMemoryFeedbackJournal {
	readonly #events: FeedbackEvent[] = [];

	readonly sink: FeedbackJournalSink = event => {
		this.#events.push(event);
	};

	all(): readonly FeedbackEvent[] {
		return this.#events;
	}

	forProject(projectId: string): FeedbackEvent[] {
		return this.#events.filter(e => e.projectId === projectId);
	}

	get size(): number {
		return this.#events.length;
	}
}

/**
 * Emit one feedback event to a sink, fail-open. Never throws; reports failures
 * through the optional `onError` hook so a journal outage can't break a tool.
 */
export async function emitFeedback(
	sink: FeedbackJournalSink | undefined,
	event: FeedbackEvent,
	onError?: (error: unknown) => void,
): Promise<void> {
	if (!sink) return;
	try {
		await sink(event);
	} catch (error) {
		try {
			onError?.(error);
		} catch {
			// Diagnostics must never throw.
		}
	}
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

export type BuildState = "not-started" | "building" | "ready" | "stale" | "failed" | "disabled";

export interface GitIntelligenceOptions {
	cwd: string;
	runGit: RunGit;
	config?: Partial<GitIntelligenceConfig>;
	now?: () => number;
	/** Cap history depth passed to `git log --max-count`. */
	maxCount?: number;
}

/**
 * Warm-buildable facade. Construction is cheap; `warm()` builds the analysis
 * in the background. All queries fail open (return null / empty / zero) when
 * git intelligence is disabled, cold, or the history read failed.
 */
export class GitIntelligence {
	readonly config: GitIntelligenceConfig;
	readonly #cwd: string;
	readonly #runGit: RunGit;
	readonly #now: () => number;
	readonly #maxCount?: number;
	#analysis: AnalysisResult | null = null;
	#buildState: BuildState;
	#warming: Promise<void> | null = null;

	constructor(options: GitIntelligenceOptions) {
		this.config = { ...DEFAULT_GIT_INTELLIGENCE_CONFIG, ...options.config };
		this.#cwd = options.cwd;
		this.#runGit = options.runGit;
		this.#now = options.now ?? (() => Date.now());
		this.#maxCount = options.maxCount;
		this.#buildState = this.config.enabled ? "not-started" : "disabled";
	}

	get state(): BuildState {
		return this.#buildState;
	}

	get isReady(): boolean {
		return this.#buildState === "ready" && this.#analysis !== null;
	}

	/** Build analysis. Idempotent; concurrent callers share one build. Fail-open. */
	async warm(): Promise<void> {
		if (!this.config.enabled) {
			this.#buildState = "disabled";
			return;
		}
		if (this.#warming) return this.#warming;
		this.#buildState = "building";
		this.#warming = (async () => {
			try {
				const commits = await readHistory({
					cwd: this.#cwd,
					runGit: this.#runGit,
					findCopies: this.config.coChange.findCopies,
					maxCount: this.#maxCount,
				});
				this.#analysis = analyze(commits, this.config, this.#now());
				this.#buildState = "ready";
			} catch {
				this.#analysis = null;
				this.#buildState = "failed";
			} finally {
				this.#warming = null;
			}
		})();
		return this.#warming;
	}

	markStale(): void {
		if (this.#buildState === "ready") this.#buildState = "stale";
	}

	/** Fail-open counters for host snapshots; 0 when disabled, cold, or failed. */
	coChangePairCount(): number {
		return this.#analysis?.coChange.totalEdges ?? 0;
	}

	indexedCommitCount(): number {
		return this.#analysis?.quality.commitCount ?? 0;
	}

	pathIdentityCount(): number {
		return this.#analysis?.index.identities.size ?? 0;
	}

	/** Full decision trace for a target path (null when unavailable). */
	adviseTrace(targetPath: string, workingTree?: WorkingTreeActivity): AdvisoryDecisionTrace | null {
		if (!this.isReady || !this.#analysis) return null;
		try {
			return evaluateAdvisory({
				targetPath,
				analysis: this.#analysis,
				config: this.config,
				workingTree,
				now: this.#now(),
			});
		} catch {
			return null;
		}
	}

	/** Model-facing advisory (null in observe mode / suppressed / unavailable). */
	advise(targetPath: string, workingTree?: WorkingTreeActivity): ToolAdvisory | null {
		const trace = this.adviseTrace(targetPath, workingTree);
		return trace ? toToolAdvisory(trace) : null;
	}
}
