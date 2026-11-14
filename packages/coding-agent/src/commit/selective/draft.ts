/**
 * A proposed commit of one agent tree's changes in a shared, dirty worktree.
 *
 * {@link createDraft} reads every changed path of the repository (HEAD vs worktree), attributes
 * its change lines to agents from the session's {@link ChangeJournal}, and preselects the lines
 * of the agents in scope. The calling agent reviews what the journal could not decide, adjusts
 * the selection with {@link Draft.take}/{@link Draft.drop}/{@link Draft.only}, and hands
 * {@link Draft.selection} to `apply.ts`, which commits exactly that content.
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
	PRE,
	type RecordedEdit,
	type ReviewReason,
	TAIL,
	toLines,
	UNRECORDED,
} from "./attribution";
import type { CallRecord, ChangeJournal, ChangeRecord } from "./journal";
import { formatTextPatch } from "./patch";

/** Files above this size are selected whole, without line attribution. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** Git mode of a symlink. */
const SYMLINK_MODE = "120000";
/** Tolerance when matching a file's mtime to a tool call window (event and fs clock skew). */
const WINDOW_SLACK_MS = 1500;
/** Concurrent file reads while building a draft. */
const READ_CONCURRENCY = 16;
/** Display cap for one change line. */
const LINE_DISPLAY_CHARS = 160;

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

/** Content to commit for one path; produced by {@link Draft.selection}. */
export type SelectedChange =
	/** HEAD's state (`null`: absent) → the selected state (`null`: deleted). */
	| { kind: "text"; path: string; before: FileState | null; after: FileState | null }
	/** Committed as its current worktree state; `added` when HEAD lacks the path. */
	| { kind: "whole"; path: string; added: boolean };

/**
 * Why a file has no line attribution and is committed whole: binary, non-UTF-8, or oversized
 * content; a symlink on either side; or a mode change with identical content.
 */
type WholeReason = "content" | "symlink" | "mode";

/** What to select or deselect: a path (exact, glob, or unique suffix), hunk/unit ids, and/or a regex over change lines. */
export interface SelectionTarget {
	path?: string;
	/** Hunk numbers (`"3"`) or units (`"3b"`) of the targeted file. */
	units?: readonly string[];
	grep?: string;
}

interface FileChange {
	path: string;
	head: string | null;
	work: string | null;
	/** Git mode at HEAD; `null` when HEAD lacks the path. */
	headMode: string | null;
	/** Git mode in the worktree; `null` when the file is deleted. */
	mode: string | null;
	/** Set exactly when `attribution` is absent: the file selects whole. */
	whole?: WholeReason;
	/** Line attribution of the content change. */
	attribution?: Attribution;
	classification?: Classification;
	selected: Set<number>;
	wholeSelected: boolean;
	/** Agents with recorded edits of this path. */
	editors: string[];
	/** Call window covering the last modification of a file no usable record explains. */
	hint?: CallRecord;
}

/** Content of `bytes` as text, or `undefined` when it must be handled as an opaque whole file. */
function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.byteLength > MAX_TEXT_BYTES || isProbablyBinaryHeader(bytes.subarray(0, BINARY_SNIFF_BYTES))) {
		return undefined;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
			return "unrecorded";
		default:
			return actor;
	}
}

function clock(ms: number): string {
	const date = new Date(ms);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function describeCall(call: CallRecord): string {
	return `${call.agent}'s ${call.tool} \`${call.label}\` (${clock(call.end)})`;
}

function describeReason(reason: ReviewReason): string {
	switch (reason.kind) {
		case "entangled":
			return `edits lines added by ${reason.with.map(actorName).join(", ")} that were never committed`;
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

/** Recorded edit history of one file, as consecutive content snapshots; `undefined` when unusable. */
async function loadEdits(
	journal: ChangeJournal,
	records: readonly ChangeRecord[],
	windowAgent: (ms: number | undefined) => string | undefined,
): Promise<RecordedEdit[] | undefined> {
	const edits: RecordedEdit[] = [];
	for (const record of records) {
		if (record.before === undefined || record.after === undefined) return undefined;
		const before = record.before === null ? null : await journal.blob(record.before);
		const after = record.after === null ? null : await journal.blob(record.after);
		if (before === undefined || after === undefined) return undefined;
		edits.push({
			actor: record.agent,
			before: toLines(before),
			after: toLines(after),
			gapHint: edits.length > 0 ? windowAgent(record.beforeMtimeMs) : undefined,
		});
	}
	return edits;
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
	const calls = records.filter((record): record is CallRecord => record.type === "call");
	/** The single in-scope agent whose call window covers `ms`; none when out-of-scope calls overlap too. */
	const windowCall = (ms: number | undefined): CallRecord | undefined => {
		if (ms === undefined) return undefined;
		const covering = calls.filter(call => call.start - WINDOW_SLACK_MS <= ms && ms <= call.end + WINDOW_SLACK_MS);
		if (covering.length === 0 || covering.some(call => !scope.has(call.agent))) return undefined;
		return covering[covering.length - 1];
	};

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
	const files: FileChange[] = [];
	const skipped: string[] = [];
	const load = async (entry: { path: string }) => {
		const result = await loadFile(
			repo,
			root,
			{ sha: head, mode: headModes.get(entry.path) ?? null },
			entry.path,
			byPath.get(entry.path) ?? [],
			source.journal,
			windowCall,
		);
		if (result === "skip") skipped.push(entry.path);
		else if (result) files.push(result);
	};
	for (let start = 0; start < dirty.length; start += READ_CONCURRENCY) {
		source.signal?.throwIfAborted();
		await Promise.all(dirty.slice(start, start + READ_CONCURRENCY).map(load));
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	for (const file of files) {
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
	});
}

/**
 * One changed path of the worktree against `head` (`sha: null` on an unborn HEAD; `mode: null`
 * when HEAD lacks the path). `"skip"` for submodules and other directories.
 */
async function loadFile(
	repo: VcsGitRepo,
	root: string,
	head: { sha: string | null; mode: string | null },
	file: string,
	records: readonly ChangeRecord[],
	journal: ChangeJournal | null,
	windowCall: (ms: number | undefined) => CallRecord | undefined,
): Promise<FileChange | "skip" | undefined> {
	const absolute = path.join(root, file);
	let workBytes: Uint8Array | null = null;
	let mtimeMs: number | undefined;
	let mode: string | null = null;
	try {
		const stat = await fs.lstat(absolute);
		mtimeMs = stat.mtimeMs;
		if (stat.isSymbolicLink()) mode = SYMLINK_MODE;
		else if (!stat.isFile()) return "skip";
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
	};
	const whole = (reason: WholeReason): FileChange => ({
		...base,
		head: null,
		work: null,
		whole: reason,
		hint: records.length === 0 ? windowCall(mtimeMs) : undefined,
	});
	// Symlinks commit as their link target, whole; this also covers a file replaced by a link and back.
	if (head.mode === SYMLINK_MODE || mode === SYMLINK_MODE) return whole("symlink");
	const headBytes = head.sha && head.mode ? (await repo.showBlob(`${head.sha}:${file}`)).data : null;
	const headText = headBytes === null ? null : decodeText(headBytes);
	const workText = workBytes === null ? null : decodeText(workBytes);
	if (headText === undefined || workText === undefined) return whole("content");
	if (headText === workText) return head.mode === mode ? undefined : whole("mode");
	const headLines = toLines(headText);
	const workLines = toLines(workText);
	const windowAgent = (ms: number | undefined) => windowCall(ms)?.agent;
	const edits = journal && records.length > 0 ? await loadEdits(journal, records, windowAgent) : undefined;
	const steps = historySteps(headLines, edits ?? [], workLines, windowAgent(mtimeMs));
	return {
		...base,
		head: headText,
		work: workText,
		attribution: attribute(headLines, steps, workLines),
		hint: edits === undefined ? windowCall(mtimeMs) : undefined,
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
}

/** Line counts of a set of change ops. */
interface Counts {
	added: number;
	removed: number;
}

/**
 * Line counts of `file`'s ops (all of them, or `ops`). A created or deleted file's final newline
 * is an op of its own (an empty last line, see `toLines`) and is not counted as a line.
 */
function countOps(file: FileChange, ops: Iterable<ChangeOp> = file.attribution?.ops ?? []): Counts {
	const last = file.attribution?.ops.at(-1);
	const newline = (file.head === null || file.work === null) && last?.text === "" ? last : undefined;
	const counts = { added: 0, removed: 0 };
	for (const op of ops) {
		if (op === newline) continue;
		if (op.kind === "+") counts.added++;
		else counts.removed++;
	}
	return counts;
}

/** ` mode 100644 → 100755` when a file that exists on both sides changes mode; empty otherwise. */
function modeChange(file: FileChange): string {
	return file.headMode && file.mode && file.headMode !== file.mode ? ` mode ${file.headMode} → ${file.mode}` : "";
}

/** What a whole-file change is, for the summary and `show()`. */
function wholeLabel(file: FileChange): string {
	switch (file.whole) {
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
			if (!file.attribution) {
				if (file.wholeSelected) changes.push({ kind: "whole", path: file.path, added: file.headMode === null });
				continue;
			}
			if (file.selected.size === 0) continue;
			const content = fromLines(buildContent(file.attribution, file.selected));
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

	/** Deselect every path matching none of `globs` (exact paths, globs, or unique suffixes). */
	only(globs: readonly string[]): string {
		if (globs.length === 0) throw new Error("Name at least one path or glob to keep.");
		const keep = new Set(globs.flatMap(glob => this.#match(glob)));
		let dropped = 0;
		for (const file of this.#files) {
			if (keep.has(file) || (file.selected.size === 0 && !file.wholeSelected)) continue;
			file.selected.clear();
			file.wholeSelected = false;
			dropped++;
		}
		return `Deselected ${dropped} path(s) outside ${globs.join(", ")}.`;
	}

	#select(target: SelectionTarget, take: boolean): string {
		if (target.path === undefined && target.grep === undefined) {
			throw new Error("Name a path, units, or grep pattern.");
		}
		if (target.units?.length && target.path === undefined) throw new Error("Units need a path.");
		const files = target.path === undefined ? this.#files : this.#match(target.path);
		const pattern = target.grep === undefined ? undefined : new RegExp(target.grep);
		let touched = 0;
		for (const file of files) {
			const ops = this.#targetOps(file, target.units, pattern);
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
		if (pattern && touched === 0 && !files.some(file => this.#targetOps(file, target.units, pattern) !== "whole")) {
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
		if (!file.attribution) {
			if (units?.length && !units.every(unit => unit === "1" || unit === "1a")) {
				throw new Error(`${file.path} is a whole-file change; it has only unit 1.`);
			}
			return "whole";
		}
		const { hunks } = file.attribution;
		const ops: ChangeOp[] = [];
		const wanted = units?.length ? units : undefined;
		hunks.forEach((hunk, hunkIndex) => {
			const units = [...hunkUnits(hunk).values()];
			units.forEach((unitOps, unitIndex) => {
				const id = `${hunkIndex + 1}${unitLetter(unitIndex)}`;
				if (wanted && !wanted.includes(String(hunkIndex + 1)) && !wanted.includes(id)) return;
				if (pattern && !unitOps.some(op => pattern.test(op.text))) return;
				ops.push(...unitOps);
			});
		});
		if (wanted) {
			for (const unit of wanted) {
				const match = /^(\d+)([a-z]*)$/.exec(unit);
				const hunk = match ? hunks[Number(match[1]) - 1] : undefined;
				if (!hunk || (match?.[2] && !hunkUnits(hunk).size)) {
					throw new Error(`${file.path} has no unit "${unit}" (hunks 1-${hunks.length}).`);
				}
			}
		}
		return ops;
	}

	/** Files a path argument names: exact path, glob, or unique path suffix. @throws when none or several suffix matches. */
	#match(target: string): FileChange[] {
		const exact = this.#files.find(file => file.path === target);
		if (exact) return [exact];
		if (/[*?[{]/.test(target)) {
			const glob = new Bun.Glob(target);
			const matched = this.#files.filter(file => glob.match(file.path));
			if (matched.length === 0) throw new Error(`No changed path matches ${target}.`);
			return matched;
		}
		const suffix = this.#files.filter(file => file.path.endsWith(`/${target}`));
		if (suffix.length === 1) return suffix;
		if (suffix.length > 1) {
			throw new Error(`"${target}" is ambiguous: ${suffix.map(file => file.path).join(", ")}`);
		}
		throw new Error(`No changed path matches "${target}".`);
	}

	/** Summary of the selection, review items, and what stays out; shown on draft creation and in `/commit`. */
	summary(): string {
		const running = this.agents.filter(agent => agent.inScope && agent.running).map(agent => agent.id);
		const scopeNames = [...this.scope].join(", ");
		const lines = [
			`HEAD ${this.head?.slice(0, 10) ?? "(no commits yet)"}${this.branch ? ` on ${this.branch}` : ""} · scope: ${scopeNames}` +
				(running.length > 0 ? ` (still running: ${running.join(", ")})` : ""),
		];
		const selected: string[] = [];
		const review: string[] = [];
		const otherAgents = new Map<string, number>();
		let notYours = 0;
		for (const file of this.#files) {
			const counted = this.#describeFile(file);
			if (counted.selected) selected.push(counted.selected);
			review.push(...counted.review);
			for (const agent of counted.outOfScopeAgents) otherAgents.set(agent, (otherAgents.get(agent) ?? 0) + 1);
			if (!counted.selected && counted.review.length === 0 && counted.outOfScopeAgents.size === 0) notYours++;
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
		const tail = [`Not yours: ${notYours} path(s).`];
		if (this.staged.length > 0) tail.push(`Staged by others: ${this.staged.length} path(s), left staged.`);
		if (this.skipped.length > 0) tail.push(`Skipped: ${this.skipped.join(", ")} (submodule or nested repository).`);
		lines.push(tail.join(" "));
		return lines.join("\n");
	}

	#describeFile(file: FileChange): { selected?: string; review: string[]; outOfScopeAgents: Set<string> } {
		const outOfScopeAgents = new Set(file.editors.filter(agent => !this.scope.has(agent)));
		if (!file.attribution) {
			const label = wholeLabel(file);
			if (file.wholeSelected) return { selected: `  ✓ ${file.path}  whole ${label}`, review: [], outOfScopeAgents };
			const reason = file.hint
				? `modified during ${describeCall(file.hint)}`
				: file.editors.some(agent => this.scope.has(agent))
					? `edited by ${file.editors.join(", ")}`
					: undefined;
			return { review: reason ? [`  ? ${file.path}  whole ${label}; ${reason}`] : [], outOfScopeAgents };
		}
		const { ops, hunks } = file.attribution;
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
		if (chosen.length === 0 && file.hint && review.length === 0) {
			review.push(
				`  ? ${file.path}  ${formatCounts(countOps(file))}${modeChange(file)}; no edit record; modified during ${describeCall(file.hint)}`,
			);
		}
		for (const op of ops) {
			if (status[op.id] === "other" && !op.by.startsWith("~") && !this.scope.has(op.by)) outOfScopeAgents.add(op.by);
		}
		if (chosen.length === 0) return { review, outOfScopeAgents };
		const leftOut = ops.filter(op => !file.selected.has(op.id));
		const owners = [...new Set(chosen.map(op => (op.by.startsWith("~") && op.hint ? op.hint : op.by)))];
		const mark = leftOut.length === 0 ? "✓" : "◐";
		let line = `  ${mark} ${file.path}  ${formatCounts(countOps(file, chosen))}${modeChange(file)}`;
		if (leftOut.length > 0) {
			const others = [...new Set(leftOut.map(op => actorName(op.by)))];
			line += ` of ${formatCounts(countOps(file))}; left out: ${others.join(", ")}`;
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

	#needsAttention(file: FileChange): boolean {
		if (!file.attribution) return file.hint !== undefined && !file.wholeSelected;
		const status = file.classification?.status ?? [];
		const selected = file.selected.size;
		if (selected > 0 && selected < file.attribution.ops.length) return true;
		return file.attribution.ops.some(op => status[op.id] === "review" && !file.selected.has(op.id));
	}

	#renderFile(file: FileChange): string {
		if (!file.attribution) {
			const mark = file.wholeSelected ? "✓" : file.hint ? "?" : "·";
			const hint = file.hint ? `; modified during ${describeCall(file.hint)}` : "";
			return `${file.path}  whole-file change (${wholeLabel(file)})${hint}\n  1 ${mark} whole file`;
		}
		const { ops, hunks } = file.attribution;
		const status = file.classification?.status ?? [];
		const chosen = ops.filter(op => file.selected.has(op.id));
		const lines = [
			`${file.path}  ${formatCounts(countOps(file, chosen))} of ${formatCounts(countOps(file))} selected${modeChange(file)}`,
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
			for (const op of hunk.ops) {
				const mark = file.selected.has(op.id) ? "✓" : status[op.id] === "review" ? "?" : "·";
				const owner =
					op.by.startsWith("~") && op.hint && file.classification?.likely.has(op.id)
						? `${actorName(op.by)}, during ${op.hint}'s call`
						: actorName(op.by);
				lines.push(`  ${unitOf.get(op.id)} ${mark} ${op.kind}${displayLine(op.text)}    ← ${owner}`);
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
				: `diff --git a/${change.path} b/${change.path}\n(whole-file change committed as in the worktree)\n`,
		);
		return parts.join("") || "Nothing selected.";
	}
}
