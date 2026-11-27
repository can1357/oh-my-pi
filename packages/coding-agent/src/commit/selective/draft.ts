/**
 * A proposed commit of one agent tree's changes in a shared, dirty worktree.
 *
 * {@link createDraft} reads every changed path of the repository (HEAD vs worktree), attributes
 * its change lines to agents from the session's {@link ChangeJournal}, and preselects the lines
 * of the agents in scope. Only writes of the edit tools and of the shell's own builtins and
 * redirections are journaled: whatever a spawned program (a script, a formatter) or the user
 * changed is unrecorded and never preselected. The calling agent adds the unrecorded
 * changes that belong to its work and settles what the journal could not decide with
 * {@link Draft.take}/{@link Draft.drop}/{@link Draft.only}, and hands {@link Draft.selection} to
 * `apply.ts`, which commits exactly that content.
 *
 * Scope: by default the calling agent plus its subagents; `"self"` for the caller alone, `"*"`
 * for every agent of the session, or agent ids (each with its own subagents).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { BINARY_SNIFF_BYTES, isEnoent, isProbablyBinaryHeader } from "@oh-my-pi/pi-utils";
import { parseDirtyPathsWithStatus } from "../../autoresearch/git";
import {
	type Attribution,
	attribute,
	buildContent,
	type Classification,
	type ChangeOp,
	classify,
	fromLines,
	GAP,
	type Hunk,
	historySteps,
	isPseudoActor,
	PRE,
	type RecordedEdit,
	REORDERED,
	type ReviewReason,
	TAIL,
	toLines,
	UNRECORDED,
} from "./attribution";
import type { ChangeJournal, ChangeRecord } from "./journal";
import { formatTextPatch } from "./patch";

/** Files above this size are selected whole, without line attribution. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** Git mode of a symlink. */
const SYMLINK_MODE = "120000";
/** Concurrent file reads while building a draft. */
const READ_CONCURRENCY = 16;
/** First-parent commits walked back from HEAD to find where it was when recording began. */
const RECENT_COMMIT_LIMIT = 256;
/** Author dates have whole seconds; a commit in the same second as a record counts as after it. */
const COMMIT_DATE_SLACK_MS = 1000;
/** Display cap for one change line. */
const LINE_DISPLAY_CHARS = 160;
/** Unrecorded paths the summary names; the rest are counted. */
const UNRECORDED_LIST_LIMIT = 12;

/** Scope selector: `undefined` → caller + subagents; `"self"`; `"*"`; agent id(s), each with its subagents. */
export type ScopeSpec = string | readonly string[] | undefined;

/** Inputs for {@link createDraft}. */
export interface DraftSource {
	cwd: string;
	/** Journal of the session's agent tree; `null` when the session keeps no artifacts (nothing is attributed). */
	journal: ChangeJournal | null;
	/** Agent creating the draft; the root of the default scope. */
	caller: string;
	agents?: ScopeSpec;
	/** Whether an agent is still running (its edits may not be finished). */
	isRunning?: (agent: string) => boolean;
	signal?: AbortSignal;
}

/** A file's text and git mode (`100644`, `100755`) on one side of a change. */
export interface FileState {
	text: string;
	mode: string;
}

/** A blob and its git mode on one side of a whole-file change. */
export interface WholeFileState {
	id: string;
	mode: string;
}

/** Content to commit for one path; produced by {@link Draft.selection}. */
export type SelectedChange =
	/** HEAD's state (`null`: absent) → the selected state (`null`: deleted). */
	| { kind: "text"; path: string; before: FileState | null; after: FileState | null }
	/** Frozen blobs captured at draft time (`null`: absent). */
	| { kind: "whole"; path: string; before: WholeFileState | null; after: WholeFileState | null };

/**
 * Why a file has no line attribution and is committed whole: binary, non-UTF-8, or oversized
 * content; a symlink on either side; or a mode change with identical content.
 */
type WholeReason = "content" | "symlink" | "mode" | "gitlink";

/** What to select or deselect: a path (exact, glob, or unique suffix), hunk/unit ids, and/or a regex over change lines. */
export interface SelectionTarget {
	path?: string;
	/** Hunk numbers (`"3"`) or units (`"3b"`) of the targeted file. */
	units?: readonly string[];
	grep?: string;
}

interface FileChangeBase {
	path: string;
	head: string | null;
	work: string | null;
	/** Git mode at HEAD; `null` when HEAD lacks the path. */
	headMode: string | null;
	/** Git mode in the worktree; `null` when the file is deleted. */
	mode: string | null;
	/** Line counts of every change op; zero for a whole-file change. */
	counts: Counts;
	selected: Set<number>;
	wholeSelected: boolean;
	/** Agents with recorded edits of this path. */
	editors: string[];
}

interface TextFileChange extends FileChangeBase {
	/**
	 * Line attribution of the content change, kept only when recorded edits shaped it. A file no
	 * usable record explains is one unrecorded step from `head` to `work`, which
	 * {@link lineAttribution} rebuilds on use: kept for every untracked file of a worktree, its
	 * per-line objects cost tens of times the files' size.
	 */
	attribution?: Attribution;
	classification?: Classification;
	whole?: never;
}

interface WholeFileChange extends FileChangeBase {
	head: null;
	work: null;
	/** Set exactly for a whole-file change: frozen object ids and the display reason. */
	whole: {
		reason: WholeReason;
		before: WholeFileState | null;
		after: WholeFileState | null;
	};
	attribution?: never;
	classification?: never;
}

type FileChange = TextFileChange | WholeFileChange;

/**
 * Content of `bytes` as text, or `undefined` when it must be handled as an opaque whole file.
 * A leading UTF-8 BOM is kept: the text is rendered back into the committed blob.
 */
function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.byteLength > MAX_TEXT_BYTES || isProbablyBinaryHeader(bytes.subarray(0, BINARY_SNIFF_BYTES))) {
		return undefined;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function actorName(actor: string): string {
	switch (actor) {
		case PRE:
			return "pre-existing";
		case GAP:
		case TAIL:
		case UNRECORDED:
		case REORDERED:
			return "unrecorded";
		default:
			return actor;
	}
}

function describeReason(reason: ReviewReason): string {
	switch (reason.kind) {
		case "reordered":
			return "replayed edits disagree with the HEAD-to-worktree diff after a reorder; review the net change";
		case "entangled":
			return `edits lines added by ${reason.with.map(actorName).join(", ")} that were never committed`;
		case "placement":
			return `placement depends on an uncommitted replacement by ${reason.with.map(actorName).join(", ")}`;
		case "rewritten":
			return reason.by === GAP || reason.by === TAIL
				? `in-scope lines rewritten afterwards by an unrecorded change${reason.by === GAP ? " before a later edit" : ""}`
				: `in-scope lines rewritten afterwards by ${reason.by}`;
		case "hunk":
			return "shares a hunk with a change that needs review";
	}
}

function displayLine(text: string): string {
	return text.length > LINE_DISPLAY_CHARS ? `${text.slice(0, LINE_DISPLAY_CHARS)}…` : text;
}

/** Units of a hunk: its ops grouped by actor, lettered in order of first appearance. */
function hunkUnits(hunk: Hunk): Map<string, ChangeOp[]> {
	const units = new Map<string, ChangeOp[]>();
	for (const op of hunk.ops) {
		const unit = units.get(op.by);
		if (unit) unit.push(op);
		else units.set(op.by, [op]);
	}
	return units;
}

function unitLetter(index: number): string {
	return String.fromCharCode(97 + (index % 26)).repeat(Math.floor(index / 26) + 1);
}

/** Agent ids reachable from `roots` through the parent links, roots included. */
function subtree(roots: Iterable<string>, children: Map<string, string[]>): Set<string> {
	const result = new Set<string>();
	const pending = [...roots];
	for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
		if (result.has(id)) continue;
		result.add(id);
		pending.push(...(children.get(id) ?? []));
	}
	return result;
}

/**
 * Agent ids a scope spec covers.
 * @throws on an agent id that neither the journal nor the caller knows.
 */
function resolveScope(spec: ScopeSpec, caller: string, parents: Map<string, string | undefined>): Set<string> {
	const children = new Map<string, string[]>();
	for (const [id, parent] of parents) {
		if (parent === undefined) continue;
		const siblings = children.get(parent);
		if (siblings) siblings.push(id);
		else children.set(parent, [id]);
	}
	if (spec === undefined) return subtree([caller], children);
	if (spec === "self") return new Set([caller]);
	if (spec === "*") return new Set([caller, ...parents.keys()]);
	const ids = typeof spec === "string" ? [spec] : spec;
	for (const id of ids) {
		if (id !== caller && !parents.has(id)) {
			const known = [...parents.keys()].join(", ") || "none";
			throw new Error(`Unknown agent "${id}"; agents with recorded changes: ${known}`);
		}
	}
	return subtree(ids, children);
}

/**
 * A changed text-or-binary file whose worktree bytes and recorded snapshots still need converting to
 * their git form (EOL attributes, `core.autocrlf`, clean filters such as Git LFS), as `git add` would.
 */
interface PendingFile {
	/** Contents to convert, all under the file's path. */
	inputs: Array<{ path: string; data: Uint8Array }>;
	/** The change once `cleaned` holds `inputs` in their git form, in order; `undefined` when nothing changed. */
	finish(cleaned: readonly Uint8Array[]): Promise<FileChange | undefined>;
}

/**
 * Build a draft of the repository's current changes for the agents in scope.
 * @throws when `cwd` is not inside a git checkout or the scope names an unknown agent.
 */
export async function createDraft(source: DraftSource): Promise<Draft> {
	if (vcs.isPureJj(source.cwd)) throw new Error("Selective commits need git; this is a Jujutsu workspace.");
	const repo = vcs.git(source.cwd);
	if (!repo) throw new Error(`Not inside a git repository: ${source.cwd}`);
	const root = repo.info().repoRoot;
	const [headSha, branch] = await Promise.all([repo.headSha(source.signal), repo.currentBranch(source.signal)]);
	const head = headSha ?? null;

	const records = source.journal ? await source.journal.read() : [];
	const parents = new Map<string, string | undefined>();
	for (const record of records) {
		if (!parents.has(record.agent) || record.parent !== undefined) parents.set(record.agent, record.parent);
	}
	const scope = resolveScope(source.agents, source.caller, parents);
	const realRoot = await fs.realpath(root).catch(() => root);
	// Journaled paths keep the spelling the agent used, which may run through a symlinked
	// directory (`~/.agent` → `~/.dotfiles/agent`). Resolve the directory, not the file: the
	// file may be a symlink itself or already deleted.
	const realDirs = new Map<string, string>();
	const byPath = new Map<string, ChangeRecord[]>();
	for (const record of records) {
		if (record.type !== "change") continue;
		let rel = path.relative(root, record.path);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			const dir = path.dirname(record.path);
			let realDir = realDirs.get(dir);
			if (realDir === undefined) {
				realDir = await fs.realpath(dir).catch(() => dir);
				realDirs.set(dir, realDir);
			}
			rel = path.relative(realRoot, path.join(realDir, path.basename(record.path)));
		}
		if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
		rel = rel.split(path.sep).join("/");
		const list = byPath.get(rel);
		if (list) list.push(record);
		else byPath.set(rel, [record]);
	}

	const [statusText, staged] = await Promise.all([
		repo.statusPorcelain({ untracked: "all", nulTerminated: true }, source.signal),
		repo.changedFiles({ cached: true }, source.signal),
	]);
	const dirty = parseDirtyPathsWithStatus(statusText);
	const tracked = dirty.filter(entry => !entry.untracked).map(entry => entry.path);
	const headModes = new Map(
		head && tracked.length > 0
			? (await repo.lsTree(head, tracked, source.signal)).map(entry => [entry.path, entry.mode])
			: [],
	);
	const recent = head && byPath.size > 0 ? await recentCommits(repo, head, byPath, source.signal) : [];
	const files: FileChange[] = [];
	const skipped: string[] = [];
	const load = (entry: { path: string }) =>
		loadFile(
			repo,
			root,
			{ sha: head, mode: headModes.get(entry.path) ?? null, recent },
			entry.path,
			byPath.get(entry.path) ?? [],
			source.journal,
			source.signal,
		);
	for (const chunk of await readChunks(root, dirty)) {
		source.signal?.throwIfAborted();
		const results = await Promise.all(chunk.map(load));
		// One conversion per chunk: each call loads the index and attributes afresh.
		const pending = results.filter(
			(result): result is PendingFile => typeof result === "object" && "finish" in result,
		);
		const inputs = pending.flatMap(file => file.inputs);
		const cleaned = inputs.length > 0 ? await repo.worktreeToGit(inputs, source.signal) : [];
		let offset = 0;
		const finished = await Promise.all(
			results.map(result =>
				result && typeof result === "object" && "finish" in result
					? result.finish(cleaned.slice(offset, (offset += result.inputs.length)))
					: result,
			),
		);
		finished.forEach((result, index) => {
			if (result === "skip") skipped.push(chunk[index].path);
			else if (result) files.push(result);
		});
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	for (const file of files) {
		// A file without kept attribution has only unrecorded lines, all `other`: nothing to select.
		if (file.attribution) {
			file.classification = classify(file.attribution, scope);
			for (const op of file.attribution.ops) {
				if (file.classification.status[op.id] === "own") file.selected.add(op.id);
			}
		}
	}
	const agents = [...new Set([source.caller, ...parents.keys()])].map(id => ({
		id,
		parent: parents.get(id),
		inScope: scope.has(id),
		running: source.isRunning?.(id) ?? false,
	}));
	return new Draft({
		root,
		head,
		branch: branch ?? undefined,
		caller: source.caller,
		scope,
		agents,
		files,
		staged,
		skipped,
		journaled: source.journal !== null,
	});
}

/**
 * Splits `entries` into the chunks a draft reads and converts together: at most READ_CONCURRENCY files
 * and at most MAX_TEXT_BYTES of content, so one conversion never holds several large files at once. A
 * file larger than that is a chunk of its own. Sizes are lstat sizes, taken before any file is read.
 */
async function readChunks<T extends { path: string }>(root: string, entries: readonly T[]): Promise<T[][]> {
	const sizes = await Promise.all(
		entries.map(entry =>
			fs.lstat(path.join(root, entry.path)).then(
				stat => stat.size,
				() => 0,
			),
		),
	);
	const chunks: T[][] = [];
	let chunk: T[] = [];
	let bytes = 0;
	entries.forEach((entry, index) => {
		const size = sizes[index];
		if (chunk.length > 0 && (chunk.length === READ_CONCURRENCY || bytes + size > MAX_TEXT_BYTES)) {
			chunks.push(chunk);
			chunk = [];
			bytes = 0;
		}
		chunk.push(entry);
		bytes += size;
	});
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

/** A first-parent commit on HEAD and its parent (`undefined` for a root commit). */
interface RecentCommit {
	time: number;
	parent: string | undefined;
}

/** First-parent commits on `head` made since the earliest recorded edit, newest first. */
async function recentCommits(
	repo: VcsGitRepo,
	head: string,
	byPath: ReadonlyMap<string, readonly ChangeRecord[]>,
	signal: AbortSignal | undefined,
): Promise<RecentCommit[]> {
	let since = Number.POSITIVE_INFINITY;
	for (const list of byPath.values()) since = Math.min(since, list[0].at);
	const commits: RecentCommit[] = [];
	for (let rev: string | undefined = head; rev !== undefined && commits.length < RECENT_COMMIT_LIMIT;) {
		const details = await repo.commitDetails(rev, signal);
		const time = Date.parse(details.author.date ?? "");
		if (!(time + COMMIT_DATE_SLACK_MS > since)) break;
		rev = details.parents[0];
		commits.push({ time, parent: rev });
	}
	return commits;
}

/**
 * Whether a commit changed `file` after its first recorded edit at `since`: its blob at HEAD
 * differs from the one in the commit HEAD was on then. Author dates can predate a rebase or a
 * pull, so a miss leaves attribution as plain replay.
 */
async function headMovedSince(
	repo: VcsGitRepo,
	head: string,
	file: string,
	since: number,
	recent: readonly RecentCommit[],
): Promise<boolean> {
	const after = recent.filter(commit => commit.time + COMMIT_DATE_SLACK_MS > since);
	if (after.length === 0) return false;
	const base = after[after.length - 1].parent;
	const [now, then] = await Promise.all([
		repo.resolveRef(`${head}:${file}`),
		base === undefined ? undefined : repo.resolveRef(`${base}:${file}`),
	]);
	return (now ?? null) !== (then ?? null);
}

/**
 * One changed path of the worktree against `head` (`sha: null` on an unborn HEAD; `mode: null`
 * when HEAD lacks the path). `"skip"` for submodules and other directories; a {@link PendingFile}
 * for content compared in its git form.
 */
async function loadFile(
	repo: VcsGitRepo,
	root: string,
	head: { sha: string | null; mode: string | null; recent: readonly RecentCommit[] },
	file: string,
	records: readonly ChangeRecord[],
	journal: ChangeJournal | null,
	signal?: AbortSignal,
): Promise<FileChange | PendingFile | "skip" | undefined> {
	const absolute = path.join(root, file);
	if (head.mode === "160000") {
		const stat = await fs.lstat(absolute).catch(error => {
			if (!isEnoent(error)) throw error;
			return undefined;
		});
		if (!stat?.isDirectory()) return "skip";
		const module = vcs.git(absolute);
		if (!module || (await fs.realpath(module.info().repoRoot)) !== (await fs.realpath(absolute))) return "skip";
		const [before, after] = await Promise.all([repo.resolveRef(`${head.sha}:${file}`), module.headSha()]);
		if (!before || !after) return "skip";
		if (before === after) return undefined;
		return {
			path: file,
			head: null,
			work: null,
			headMode: "160000",
			mode: "160000",
			whole: { reason: "gitlink", before: { id: before, mode: "160000" }, after: { id: after, mode: "160000" } },
			selected: new Set<number>(),
			wholeSelected: false,
			editors: [],
			counts: { added: 0, removed: 0 },
		};
	}
	let workBytes: Uint8Array | null = null;
	let mode: string | null = null;
	try {
		const stat = await fs.lstat(absolute);
		if (stat.isSymbolicLink()) {
			mode = SYMLINK_MODE;
			workBytes = await fs.readlink(absolute, { encoding: "buffer" });
		} else if (!stat.isFile()) return "skip";
		else {
			mode = stat.mode & 0o111 ? "100755" : "100644";
			workBytes = await fs.readFile(absolute);
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (head.mode === null && mode === null) return undefined;
	const base = {
		path: file,
		headMode: head.mode,
		mode,
		selected: new Set<number>(),
		wholeSelected: false,
		editors: [...new Set(records.map(record => record.agent))],
		counts: { added: 0, removed: 0 },
	};
	// Freeze the captured bytes, not a rendered patch: drafts retain only a blob id,
	// and selected paths render from the object database when the commit is built.
	// Regular files are stored in their git form (`stored`, as `git add` would store
	// them), and the worktree file is not read again. Symlink targets stay literal.
	const whole = async (reason: WholeReason, stored: Uint8Array | null): Promise<WholeFileChange> => {
		let before: WholeFileState | null = null;
		if (head.sha !== null && head.mode !== null) {
			const id = await repo.resolveRef(`${head.sha}:${file}`, signal);
			if (!id) throw new Error(`Could not resolve ${file} at draft HEAD ${head.sha}.`);
			before = { id, mode: head.mode };
		}
		let after: WholeFileState | null = null;
		if (mode !== null) {
			if (stored === null) throw new Error(`Could not capture ${file} for the draft.`);
			after = { id: await repo.writeBlob(stored, signal), mode };
		}
		return { ...base, head: null, work: null, whole: { reason, before, after } };
	};
	// Symlinks commit as their link target, whole; this also covers a file replaced by a link and back.
	// The link target stays literal; a regular file that replaced a link is stored in its git form.
	if (head.mode === SYMLINK_MODE || mode === SYMLINK_MODE) {
		const stored =
			mode === SYMLINK_MODE || workBytes === null
				? workBytes
				: (await repo.worktreeToGit([{ path: file, data: workBytes }], signal))[0];
		return whole("symlink", stored);
	}
	// Capped: decodeText rejects anything longer than MAX_TEXT_BYTES, so a larger HEAD blob is never needed whole.
	const headBytes =
		head.sha && head.mode ? (await repo.showBlob(`${head.sha}:${file}`, MAX_TEXT_BYTES + 1, signal)).data : null;
	const [snapshots, headMoved] = await Promise.all([
		journal && records.length > 0 ? journal.snapshots(records) : undefined,
		head.sha && head.mode && records.length > 0
			? headMovedSince(repo, head.sha, file, records[0].at, head.recent)
			: false,
	]);
	const encoder = new TextEncoder();
	const recorded = (snapshots ?? []).flatMap(snapshot => [snapshot.before, snapshot.after]);
	const inputs = [
		...(workBytes === null ? [] : [workBytes]),
		...recorded.flatMap(text => (text === null ? [] : [encoder.encode(text)])),
	].map(data => ({ path: file, data }));
	return {
		inputs,
		async finish(cleaned) {
			let next = 0;
			const gitForm = workBytes === null ? null : cleaned[next++];
			const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
			const snapshotLines = (text: string | null) => toLines(text === null ? null : decoder.decode(cleaned[next++]));
			const headText = headBytes === null ? null : decodeText(headBytes);
			const workText = gitForm === null ? null : decodeText(gitForm);
			if (headText === undefined || workText === undefined) return whole("content", gitForm);
			if (headText === workText) return head.mode === mode ? undefined : whole("mode", gitForm);
			const headLines = toLines(headText);
			const workLines = toLines(workText);
			const edits = snapshots?.map((snapshot): RecordedEdit => ({
				actor: snapshot.agent,
				before: snapshotLines(snapshot.before),
				after: snapshotLines(snapshot.after),
			}));
			const steps = historySteps(headLines, edits ?? [], workLines);
			const attribution = attribute(headLines, steps, workLines, headMoved);
			const change: TextFileChange = { ...base, head: headText, work: workText };
			change.counts = countOps(change, attribution);
			if (edits !== undefined) change.attribution = attribution;
			return change;
		},
	};
}

interface DraftInit {
	root: string;
	head: string | null;
	branch?: string;
	caller: string;
	scope: ReadonlySet<string>;
	agents: ReadonlyArray<{ id: string; parent?: string; inScope: boolean; running: boolean }>;
	files: FileChange[];
	staged: readonly string[];
	skipped: readonly string[];
	journaled: boolean;
}

/** Line counts of a set of change ops. */
interface Counts {
	added: number;
	removed: number;
}

/**
 * Line counts of `attribution`'s ops in `file` (all of them, or `ops`). A created or deleted file's
 * final newline is an op of its own (an empty last line, see `toLines`) and is not counted as a line.
 */
function countOps(file: FileChange, attribution: Attribution, ops: Iterable<ChangeOp> = attribution.ops): Counts {
	const last = attribution.ops.at(-1);
	const newline = (file.head === null || file.work === null) && last?.text === "" ? last : undefined;
	const counts = { added: 0, removed: 0 };
	for (const op of ops) {
		if (op === newline) continue;
		if (op.kind === "+") counts.added++;
		else counts.removed++;
	}
	return counts;
}

/** Line attribution of a file that is not whole, rebuilt when not kept (see {@link FileChange.attribution}). */
function lineAttribution(file: FileChange): Attribution {
	if (file.attribution) return file.attribution;
	const head = toLines(file.head);
	const work = toLines(file.work);
	return attribute(head, historySteps(head, [], work), work);
}

/** ` mode 100644 → 100755` when a file that exists on both sides changes mode; empty otherwise. */
function modeChange(file: FileChange): string {
	return file.headMode && file.mode && file.headMode !== file.mode ? ` mode ${file.headMode} → ${file.mode}` : "";
}

/** What a whole-file change is, for the summary and `show()`. */
function wholeLabel(file: WholeFileChange): string {
	switch (file.whole.reason) {
		case "gitlink":
			return `gitlink ${file.whole.before?.id} → ${file.whole.after?.id}`;
		case "symlink":
			return "symlink";
		case "mode":
			return `file,${modeChange(file)}`;
		default:
			return "binary, non-UTF-8, or large file";
	}
}

function formatCounts(counts: Counts): string {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(`+${counts.added}`);
	if (counts.removed > 0) parts.push(`−${counts.removed}`);
	return parts.join(" ") || "±0";
}

/** One agent tree's proposed commit; see the module docs. */
export class Draft {
	readonly id = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
	readonly root: string;
	/** HEAD commit the draft was computed against; `null` before the first commit. */
	readonly head: string | null;
	readonly branch?: string;
	readonly caller: string;
	readonly scope: ReadonlySet<string>;
	readonly agents: DraftInit["agents"];
	/** Paths whose shared-index entry differs from HEAD (someone staged them); never committed by this draft. */
	readonly staged: readonly string[];
	/** Paths the draft cannot handle (submodules, nested repositories). */
	readonly skipped: readonly string[];
	/** Whether the session keeps a change journal; without one nothing is attributed. */
	readonly journaled: boolean;
	#files: FileChange[];

	constructor(init: DraftInit) {
		this.root = init.root;
		this.head = init.head;
		this.branch = init.branch;
		this.caller = init.caller;
		this.scope = init.scope;
		this.agents = init.agents;
		this.staged = init.staged;
		this.skipped = init.skipped;
		this.journaled = init.journaled;
		this.#files = init.files;
	}

	/** Changed paths in the draft. */
	get paths(): string[] {
		return this.#files.map(file => file.path);
	}

	/** Exact content to commit per path with anything selected. */
	selection(): SelectedChange[] {
		const changes: SelectedChange[] = [];
		for (const file of this.#files) {
			if (file.whole) {
				if (!file.wholeSelected) continue;
				const { reason, before, after } = file.whole;
				if (reason === "gitlink") {
					// Gitlink ids name submodule commits, not blobs: commit the pointer as git renders it.
					changes.push({
						kind: "text",
						path: file.path,
						before: before && { text: `Subproject commit ${before.id}\n`, mode: before.mode },
						after: after && { text: `Subproject commit ${after.id}\n`, mode: after.mode },
					});
				} else {
					changes.push({ kind: "whole", path: file.path, before, after });
				}
				continue;
			}
			if (file.selected.size === 0) continue;
			const content = fromLines(buildContent(lineAttribution(file), file.selected));
			// A partly reverted deletion keeps the file, with its HEAD mode.
			const mode = file.mode ?? file.headMode;
			const before = file.head === null || file.headMode === null ? null : { text: file.head, mode: file.headMode };
			const after = content === null || mode === null ? null : { text: content, mode };
			if (before?.text === after?.text && before?.mode === after?.mode) continue;
			changes.push({ kind: "text", path: file.path, before, after });
		}
		return changes;
	}

	/** Select changes. Returns a one-line report of what changed. @throws on an unmatched path or unit. */
	take(target: SelectionTarget): string {
		return this.#select(target, true);
	}

	/** Deselect changes. Returns a one-line report. @throws on an unmatched path or unit. */
	drop(target: SelectionTarget): string {
		return this.#select(target, false);
	}

	/**
	 * Deselect every path matching none of `globs` (exact paths, globs, or unique suffixes).
	 * Report unmatched targets. @throws if none match, leaving the selection unchanged.
	 */
	only(globs: readonly string[]): string {
		if (globs.length === 0) throw new Error("Name at least one path or glob to keep.");
		const keep = new Set<FileChange>();
		const unmatched: string[] = [];
		for (const glob of globs) {
			const matched = this.#resolve(glob);
			if (matched.length === 0) unmatched.push(glob);
			for (const file of matched) keep.add(file);
		}
		if (keep.size === 0) {
			throw new Error(`No changed path matches any keep target: ${unmatched.join(", ")}.`);
		}
		let dropped = 0;
		for (const file of this.#files) {
			if (keep.has(file) || (file.selected.size === 0 && !file.wholeSelected)) continue;
			file.selected.clear();
			file.wholeSelected = false;
			dropped++;
		}
		const report = `Deselected ${dropped} path(s) outside ${globs.join(", ")}.`;
		return unmatched.length > 0 ? `${report} Unmatched: ${unmatched.join(", ")}.` : report;
	}

	#select(target: SelectionTarget, take: boolean): string {
		if (target.path === undefined && target.grep === undefined) {
			throw new Error("Name a path, units, or grep pattern.");
		}
		if (target.units?.length && target.path === undefined) throw new Error("Units need a path.");
		const files = target.path === undefined ? this.#files : this.#match(target.path);
		const pattern = target.grep === undefined ? undefined : new RegExp(target.grep);
		// Plan every file before changing any: a unit missing from one file rejects the whole request.
		const plans = files.map(file => ({ file, ops: this.#targetOps(file, target.units, pattern) }));
		let touched = 0;
		for (const { file, ops } of plans) {
			if (ops === "whole") {
				if (file.wholeSelected !== take) touched++;
				file.wholeSelected = take;
				continue;
			}
			for (const op of ops) {
				if (file.selected.has(op.id) === take) continue;
				if (take) file.selected.add(op.id);
				else file.selected.delete(op.id);
				touched++;
			}
		}
		if (pattern && touched === 0 && !plans.some(plan => plan.ops !== "whole")) {
			throw new Error(`No change line matches /${target.grep}/.`);
		}
		return `${take ? "Selected" : "Deselected"} ${touched} change line(s).`;
	}

	/** Ops a target covers in `file`; `"whole"` for files without line attribution. */
	#targetOps(
		file: FileChange,
		units: readonly string[] | undefined,
		pattern: RegExp | undefined,
	): ChangeOp[] | "whole" {
		if (file.whole) {
			if (units?.length && !units.every(unit => unit === "1" || unit === "1a")) {
				throw new Error(`${file.path} is a whole-file change; it has only unit 1.`);
			}
			return "whole";
		}
		const { hunks } = lineAttribution(file);
		const ops: ChangeOp[] = [];
		const wanted = units?.length ? units : undefined;
		const known = new Set<string>();
		hunks.forEach((hunk, hunkIndex) => {
			known.add(String(hunkIndex + 1));
			const units = [...hunkUnits(hunk).values()];
			units.forEach((unitOps, unitIndex) => {
				const id = `${hunkIndex + 1}${unitLetter(unitIndex)}`;
				known.add(id);
				if (wanted && !wanted.includes(String(hunkIndex + 1)) && !wanted.includes(id)) return;
				if (pattern && !unitOps.some(op => pattern.test(op.text))) return;
				ops.push(...unitOps);
			});
		});
		if (wanted) {
			for (const unit of wanted) {
				if (!known.has(unit)) {
					throw new Error(`${file.path} has no unit "${unit}" (hunks 1-${hunks.length}).`);
				}
			}
		}
		return ops;
	}

	/** Files a path argument names; unmatched paths and ambiguous suffixes throw. */
	#match(target: string): FileChange[] {
		const matched = this.#resolve(target);
		if (matched.length === 0) {
			const label = /[*?[{]/.test(target) ? target : `"${target}"`;
			throw new Error(`No changed path matches ${label}.`);
		}
		return matched;
	}

	/** Resolve an exact path, glob, or unique path suffix. Only ambiguous suffixes throw. */
	#resolve(target: string): FileChange[] {
		const exact = this.#files.find(file => file.path === target);
		if (exact) return [exact];
		if (/[*?[{]/.test(target)) {
			const glob = new Bun.Glob(target);
			return this.#files.filter(file => glob.match(file.path));
		}
		const suffix = this.#files.filter(file => file.path.endsWith(`/${target}`));
		if (suffix.length > 1) {
			throw new Error(`"${target}" is ambiguous: ${suffix.map(file => file.path).join(", ")}`);
		}
		return suffix;
	}

	/** Summary of the selection, review items, and what stays out; shown on draft creation and in `/commit`. */
	summary(): string {
		const running = this.agents.filter(agent => agent.inScope && agent.running).map(agent => agent.id);
		const scopeNames = [...this.scope].join(", ");
		const lines = [
			`HEAD ${this.head?.slice(0, 10) ?? "(no commits yet)"}${this.branch ? ` on ${this.branch}` : ""} · scope: ${scopeNames}` +
				(running.length > 0 ? ` (still running: ${running.join(", ")})` : ""),
		];
		if (!this.journaled) {
			lines.push(
				"No change journal: this session keeps no artifacts, so nothing is attributed; select with take().",
			);
		}
		const selected: string[] = [];
		const review: string[] = [];
		const otherAgents = new Map<string, number>();
		/** Changed by nobody on record: nothing selected, nothing to review, no agent outside the scope. */
		const unrecorded: FileChange[] = [];
		for (const file of this.#files) {
			const counted = this.#describeFile(file);
			if (counted.selected) selected.push(counted.selected);
			review.push(...counted.review);
			for (const agent of counted.outOfScopeAgents) otherAgents.set(agent, (otherAgents.get(agent) ?? 0) + 1);
			if (!counted.selected && counted.review.length === 0 && counted.outOfScopeAgents.size === 0) {
				unrecorded.push(file);
			}
		}
		lines.push(selected.length > 0 ? "Selected:" : "Selected: nothing", ...selected);
		if (review.length > 0) lines.push("Review:", ...review);
		if (otherAgents.size > 0) {
			const parts = [...otherAgents].map(([agent, count]) => {
				const running = this.agents.find(candidate => candidate.id === agent)?.running ? ", running" : "";
				return `${agent} (${count} path(s)${running})`;
			});
			lines.push(`Other agents of this session, not in scope: ${parts.join(", ")}`);
		}
		if (unrecorded.length > 0) {
			lines.push(
				`Unrecorded: ${unrecorded.length} path(s) changed by other programs or by hand; take() the ones your commands produced.`,
			);
			for (const file of unrecorded.slice(0, UNRECORDED_LIST_LIMIT)) {
				const size = file.whole ? `whole ${wholeLabel(file)}` : `${formatCounts(file.counts)}${modeChange(file)}`;
				lines.push(`  · ${file.path}  ${size}`);
			}
			if (unrecorded.length > UNRECORDED_LIST_LIMIT) {
				lines.push(`  … ${unrecorded.length - UNRECORDED_LIST_LIMIT} more`);
			}
		}
		const tail: string[] = [];
		if (this.staged.length > 0) tail.push(`Staged by others: ${this.staged.length} path(s), left staged.`);
		if (this.skipped.length > 0) tail.push(`Skipped: ${this.skipped.join(", ")} (submodule or nested repository).`);
		if (tail.length > 0) lines.push(tail.join(" "));
		return lines.join("\n");
	}

	#describeFile(file: FileChange): { selected?: string; review: string[]; outOfScopeAgents: Set<string> } {
		const outOfScopeAgents = new Set(file.editors.filter(agent => !this.scope.has(agent)));
		if (file.whole) {
			const label = wholeLabel(file);
			if (file.wholeSelected) return { selected: `  ✓ ${file.path}  whole ${label}`, review: [], outOfScopeAgents };
			const reason = this.#wholeReviewReason(file);
			return { review: reason ? [`  ? ${file.path}  whole ${label}; ${reason}`] : [], outOfScopeAgents };
		}
		// Unkept attribution has no review or out-of-scope lines (see createDraft): rebuild it only for a selection.
		const attribution = file.attribution ?? (file.selected.size > 0 ? lineAttribution(file) : undefined);
		const ops = attribution?.ops ?? [];
		const hunks = attribution?.hunks ?? [];
		const status = file.classification?.status ?? [];
		const chosen = ops.filter(op => file.selected.has(op.id));
		const review: string[] = [];
		hunks.forEach((hunk, index) => {
			const reviewOps = hunk.ops.filter(op => status[op.id] === "review" && !file.selected.has(op.id));
			if (reviewOps.length === 0) return;
			const reasons = new Set(
				reviewOps.flatMap(op => {
					const reason = file.classification?.reasons.get(op.id);
					return reason && reason.kind !== "hunk" ? [describeReason(reason)] : [];
				}),
			);
			review.push(`  ? ${file.path}  hunk ${index + 1}: ${[...reasons].join("; ") || "needs review"}`);
		});
		// Edits the journal cannot replay leave every line unrecorded: the agent picks its own.
		if (!file.attribution && chosen.length === 0 && file.editors.some(agent => this.scope.has(agent))) {
			review.push(
				`  ? ${file.path}  ${formatCounts(file.counts)}${modeChange(file)}; edited by ${file.editors.join(", ")}, but the edit record cannot be replayed`,
			);
		}
		for (const op of ops) {
			if (status[op.id] === "other" && !isPseudoActor(op.by) && !this.scope.has(op.by)) outOfScopeAgents.add(op.by);
		}
		if (!attribution || chosen.length === 0) return { review, outOfScopeAgents };
		const leftOut = ops.filter(op => !file.selected.has(op.id));
		const owners = [...new Set(chosen.map(op => op.by))];
		const mark = leftOut.length === 0 ? "✓" : "◐";
		let line = `  ${mark} ${file.path}  ${formatCounts(countOps(file, attribution, chosen))}${modeChange(file)}`;
		if (leftOut.length > 0) {
			const others = [...new Set(leftOut.map(op => actorName(op.by)))];
			line += ` of ${formatCounts(file.counts)}; left out: ${others.join(", ")}`;
		}
		return { selected: `${line}  [${owners.map(actorName).join(", ")}]`, review, outOfScopeAgents };
	}

	/**
	 * Hunks of `target` with unit ids, selection marks, and owners; without a target, every file
	 * that is partially selected or needs review.
	 */
	show(target?: string): string {
		const files = target === undefined ? this.#files.filter(file => this.#needsAttention(file)) : this.#match(target);
		if (files.length === 0) return "Nothing is partially selected or needs review.";
		return files.map(file => this.#renderFile(file)).join("\n\n");
	}

	/** Partially selected, or listed under Review in {@link summary}. */
	#needsAttention(file: FileChange): boolean {
		const selected = file.selected.size;
		if (selected > 0 && !file.whole && selected < lineAttribution(file).ops.length) return true;
		return this.#describeFile(file).review.length > 0;
	}

	/** Why an unselected whole-file change needs review; `undefined` when it is simply not in scope. */
	#wholeReviewReason(file: FileChange): string | undefined {
		if (file.editors.some(agent => this.scope.has(agent))) return `edited by ${file.editors.join(", ")}`;
		if (file.whole?.reason === "gitlink") return "select explicitly to update the submodule pointer";
		return undefined;
	}

	#renderFile(file: FileChange): string {
		if (file.whole) {
			const reason = file.wholeSelected ? undefined : this.#wholeReviewReason(file);
			const mark = file.wholeSelected ? "✓" : reason ? "?" : "·";
			return `${file.path}  whole-file change (${wholeLabel(file)})${reason ? `; ${reason}` : ""}\n  1 ${mark} whole file`;
		}
		const attribution = lineAttribution(file);
		const { ops, hunks } = attribution;
		const status = file.classification?.status ?? [];
		const chosen = ops.filter(op => file.selected.has(op.id));
		const lines = [
			`${file.path}  ${formatCounts(countOps(file, attribution, chosen))} of ${formatCounts(file.counts)} selected${modeChange(file)}`,
		];
		hunks.forEach((hunk, hunkIndex) => {
			const headRange = `${hunk.headStart + (hunk.headCount > 0 ? 1 : 0)},${hunk.headCount}`;
			const workRange = `${hunk.workStart + (hunk.workCount > 0 ? 1 : 0)},${hunk.workCount}`;
			lines.push(`@@ -${headRange} +${workRange} @@  hunk ${hunkIndex + 1}`);
			const units = [...hunkUnits(hunk).entries()];
			const unitOf = new Map<number, string>();
			units.forEach(([, unitOps], unitIndex) => {
				for (const op of unitOps) unitOf.set(op.id, `${hunkIndex + 1}${unitLetter(unitIndex)}`);
			});
			// Consecutive lines sharing unit, mark, and owner print under one header.
			let header: string | undefined;
			for (const op of hunk.ops) {
				const mark = file.selected.has(op.id) ? "✓" : status[op.id] === "review" ? "?" : "·";
				const next = `  ${unitOf.get(op.id)} ${mark} ${actorName(op.by)}`;
				if (next !== header) {
					header = next;
					lines.push(header);
				}
				lines.push(`    ${op.kind}${displayLine(op.text)}`);
			}
			const reasons = new Set(
				hunk.ops.flatMap(op => {
					const reason = file.classification?.reasons.get(op.id);
					return reason && reason.kind !== "hunk" ? [describeReason(reason)] : [];
				}),
			);
			for (const reason of reasons) lines.push(`  ? review: ${reason}`);
		});
		return lines.join("\n");
	}

	/** The candidate commit as a patch against the draft's HEAD. */
	diff(): string {
		const parts = this.selection().map(change =>
			change.kind === "text"
				? formatTextPatch(change.path, change.before, change.after)
				: `diff --git a/${change.path} b/${change.path}\n(whole-file change; content captured at draft time)\n`,
		);
		return parts.join("") || "Nothing selected.";
	}
}
