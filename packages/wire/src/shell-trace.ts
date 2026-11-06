/**
 * `ShellTrace`: the live model of one embedded-shell run, produced by pi-shell's
 * `RunTrace` (`crates/pi-shell/src/bash/trace.rs`), polled over napi, carried in
 * the bash tool's `details.trace`, and forwarded verbatim to Tern as the `shell`
 * node's props. Every offset is a BYTE offset; UIs convert bytes to characters
 * when the script is not ASCII. Fields at their default are omitted.
 */

/** NodeKind of the engine's AST, snake_case. `assign` and `word` are not statements. */
export type ShellTraceNodeKind =
	| "and_or"
	| "pipeline"
	| "simple"
	| "brace"
	| "subshell"
	| "if"
	| "while"
	| "until"
	| "for"
	| "arith_for"
	| "select"
	| "case"
	| "arith"
	| "cond"
	| "func_def"
	| "coproc"
	| "assign"
	| "word";

/** How the engine resolved a simple command's name. */
export type ShellTraceResolved =
	| "function"
	| "intrinsic"
	| "tool"
	| "native"
	| "device"
	| "self_shell"
	| "external"
	| "not_found"
	| "none";

/** Derived at snapshot time (contract §3); always present. */
export type ShellTraceState = "pending" | "running" | "ok" | "fail" | "skipped";

export interface ShellTraceRedir {
	fd: number;
	op: string;
	target: string;
}

export interface ShellTraceDiag {
	code: string;
	message: string;
}

/** One AST node of a unit; the unit's `nodes` index is the AstNodeId. */
export interface ShellTraceNode {
	k: ShellTraceNodeKind;
	/** Byte span relative to the unit source. */
	lo: number;
	hi: number;
	/** Parent node id; absent for the root. */
	p?: number;
	state: ShellTraceState;
	/** CmdStart count. */
	runs?: number;
	/** CmdStart − CmdEnd. */
	live?: number;
	/** Status of the last CmdEnd. */
	st?: number;
	/** CmdEnds with a non-zero status. */
	fails?: number;
	/** Sum of `dur_ns` over the ended runs. */
	ns?: number;
	/** `t_ns` of the last CmdStart, relative to RunStart. */
	at?: number;
	/** Last CmdExpanded argv (each arg ≤ 256 bytes, ≤ 64 args). */
	argv?: string[];
	/** The full argv length when `argv` was cut. */
	argc?: number;
	/** Last CmdExpanded assigns. */
	env?: [string, string][];
	res?: ShellTraceResolved;
	redirs?: ShellTraceRedir[];
	/** Pipestatus of the last CmdEnd. */
	pipe?: number[];
	/** Last IterStart n. */
	iter?: number;
	/** LoopEnd iterations. */
	iters?: number;
	/** Last Branch decision. */
	taken?: boolean;
	/** A Background event named this node. */
	bg?: boolean;
	/** Last Spawn pid. */
	pid?: number;
	/** Actual last command completion timestamp and trace revision. */
	end_ns?: number;
	end_seq?: number;
}

/** One compiled unit (a top-level command, or an eval/function body). */
export interface ShellTraceUnit {
	/** Byte offset of the unit inside `script`; absent when the unit is not part of the script. */
	at?: number;
	/** 1-based script line. */
	line: number;
	/** Exact UTF-8 source byte length, including heredocs; absent in older traces. */
	bytes?: number;
	/** The unit's source; present only for unlocated units. */
	source?: string;
	/** Opaque canonical native syntax archive. Only pi-shell may interpret it. */
	syntax?: unknown;
	/** Compiler-known wrapper bytes removed from this unit's displayed source. */
	projection?: number;
	/** Script a callout (`timeout`, `git`, `xargs`, …) ran for its operands; its calling command stands for it. */
	callout?: boolean;
	nodes: ShellTraceNode[];
}

/** Exact output/execution identity; repeated visits to one node have distinct seq values. */
export interface ShellTraceCommandTag {
	/** Actual engine field: descendant vprocs without a root run queue use 0.
	 * Do not reject those tags; capture generation and explicit fork events
	 * establish run ownership, while vpid/seq distinguish the producer. */
	run: number;
	vpid: number;
	seq: number;
}

/** Proven byte fragment of a decoded scalar spanning different producers.
 * The containing Output has no single primary producer; these at-most-four
 * bytes retain the exact contributing executions without guessing ownership. */
export interface ShellTraceOutputContributor {
	t_ns: number;
	bytes: number[];
	command?: ShellTraceCommandTag;
	vpid?: number;
	u?: number;
	n?: number;
}

/** Bounded replay journal entry. Missing u/n explicitly means unknown attribution. */
export interface ShellTraceHistoryEvent {
	/** Trace revision, including coalesced output growth. */
	seq: number;
	/** Measured monotonic engine/host nanoseconds since RunStart, like node.at. */
	t_ns: number;
	/** Original engine event sequence; absent for Output callbacks. */
	event_seq?: number;
	/** Zero-based actual minimizer segment submission; lifecycle entries remain real engine events. */
	segment?: number;
	/** The last real root RunEnd finalized the entire logical segmented call. */
	logicalEnd?: boolean;
	/** Actual host outcome after output/close draining, without replacing engine status. */
	logicalStatus?: number;
	/** Actual emitting vproc, present on semantic entries even without a command tag. */
	vpid?: number;
	kind:
		| "CmdStart"
		| "CmdExpanded"
		| "CmdEnd"
		| "Pipeline"
		| "Branch"
		| "IterStart"
		| "LoopEnd"
		| "Background"
		| "FuncEnter"
		| "FuncExit"
		| "Assign"
		| "RunStart"
		| "RunEnd"
		| "Output"
		| "Diag"
		| "Exit"
		| "ErrExit"
		| "Spawn";
	u?: number;
	n?: number;
	command?: ShellTraceCommandTag;
	status?: number;
	dur_ns?: number;
	pipestatus?: number[];
	argv?: string[];
	assigns?: [string, string][];
	resolved?: ShellTraceResolved;
	redirs?: ShellTraceRedir[];
	name?: string;
	value?: string;
	full_len?: number;
	scope?: string;
	iteration?: number;
	iterations?: number;
	taken?: boolean;
	construct?: string;
	text?: string;
	contributors?: ShellTraceOutputContributor[];
	/** Final visible capture descriptor; merged stderr uses stdout's descriptor. */
	fd?: number;
	pid?: number;
}

export interface ShellTrace {
	v: 1;
	/** Semantic/output revision, including assignments/coalesced bytes; monotonic poll key. */
	seq: number;
	/** Root RunEnd status; absent while running. */
	status?: number;
	/** Actual root vproc, even if history trimming removed its RunStart. */
	rootVpid?: number;
	/** Run clock (ns since RunStart) at the last folded event. */
	t_ns: number;
	/** The command text given at construction. */
	script: string;
	/** Compiled units, in announce order. */
	units: ShellTraceUnit[];
	/** Newest ≤20,000 semantic/output records, ≤2 MiB visible output and ≤8 MiB retained payload.
	 * Adjacent output from the same execution may coalesce; its seq changes
	 * when text grows. Consumers must replace the full journal on revision. */
	history?: ShellTraceHistoryEvent[];
	/** True when any replay record or output byte was evicted. */
	historyTruncated?: boolean;
	/** The last ≤ 8 diagnostics. */
	diags?: ShellTraceDiag[];
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function numbers(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(finite);
}

function pairs(value: unknown): value is [string, string][] {
	return (
		Array.isArray(value) &&
		value.every(
			(item: unknown) =>
				Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string",
		)
	);
}

function optional(value: Record<string, unknown>, key: string, check: (item: unknown) => boolean): boolean {
	return value[key] === undefined || check(value[key]);
}

function string(value: unknown): value is string {
	return typeof value === "string";
}

function boolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function resolved(value: unknown): value is ShellTraceResolved {
	return (
		value === "function" ||
		value === "intrinsic" ||
		value === "tool" ||
		value === "native" ||
		value === "device" ||
		value === "self_shell" ||
		value === "external" ||
		value === "not_found" ||
		value === "none"
	);
}

function redirection(value: unknown): value is ShellTraceRedir {
	return record(value) && finite(value.fd) && string(value.op) && string(value.target);
}

function redirections(value: unknown): value is ShellTraceRedir[] {
	return Array.isArray(value) && value.every(redirection);
}

function traceNode(value: unknown): value is ShellTraceNode {
	if (!record(value) || !finite(value.lo) || !finite(value.hi)) return false;
	if (
		!string(value.k) ||
		![
			"and_or",
			"pipeline",
			"simple",
			"brace",
			"subshell",
			"if",
			"while",
			"until",
			"for",
			"arith_for",
			"select",
			"case",
			"arith",
			"cond",
			"func_def",
			"coproc",
			"assign",
			"word",
		].includes(value.k)
	)
		return false;
	if (
		value.state !== "pending" &&
		value.state !== "running" &&
		value.state !== "ok" &&
		value.state !== "fail" &&
		value.state !== "skipped"
	)
		return false;
	for (const key of ["p", "runs", "live", "st", "fails", "ns", "at", "argc", "iter", "iters", "pid"]) {
		if (!optional(value, key, finite)) return false;
	}
	return (
		optional(value, "argv", strings) &&
		optional(value, "env", pairs) &&
		optional(value, "res", resolved) &&
		optional(value, "redirs", redirections) &&
		optional(value, "pipe", numbers) &&
		optional(value, "taken", boolean) &&
		optional(value, "bg", boolean)
	);
}

function traceUnit(value: unknown): value is ShellTraceUnit {
	return (
		record(value) &&
		finite(value.line) &&
		optional(value, "at", finite) &&
		optional(value, "bytes", finite) &&
		optional(value, "source", string) &&
		optional(value, "callout", boolean) &&
		Array.isArray(value.nodes) &&
		value.nodes.every(traceNode)
	);
}

function commandTag(value: unknown): value is ShellTraceCommandTag {
	return record(value) && finite(value.run) && finite(value.vpid) && finite(value.seq);
}

function outputContributor(value: unknown): value is ShellTraceOutputContributor {
	return (
		record(value) &&
		finite(value.t_ns) &&
		Array.isArray(value.bytes) &&
		value.bytes.every((byte: unknown) => finite(byte) && Number.isInteger(byte) && byte >= 0 && byte <= 255) &&
		optional(value, "u", finite) &&
		optional(value, "n", finite) &&
		optional(value, "vpid", finite) &&
		optional(value, "command", commandTag)
	);
}

function historyEntry(value: unknown): value is ShellTraceHistoryEvent {
	if (!record(value) || !finite(value.seq) || !finite(value.t_ns)) return false;
	if (
		!string(value.kind) ||
		![
			"CmdStart",
			"CmdExpanded",
			"CmdEnd",
			"Pipeline",
			"Branch",
			"IterStart",
			"LoopEnd",
			"Background",
			"FuncEnter",
			"FuncExit",
			"Assign",
			"RunStart",
			"RunEnd",
			"Output",
			"Diag",
			"Exit",
			"ErrExit",
			"Spawn",
		].includes(value.kind)
	)
		return false;
	for (const key of [
		"event_seq",
		"segment",
		"logicalStatus",
		"vpid",
		"u",
		"n",
		"status",
		"dur_ns",
		"full_len",
		"iteration",
		"iterations",
		"fd",
		"pid",
	]) {
		if (!optional(value, key, finite)) return false;
	}
	for (const key of ["name", "value", "scope", "construct", "text"]) {
		if (!optional(value, key, string)) return false;
	}
	return (
		optional(value, "argv", strings) &&
		optional(value, "assigns", pairs) &&
		optional(value, "redirs", redirections) &&
		optional(value, "resolved", resolved) &&
		optional(value, "pipestatus", numbers) &&
		optional(value, "taken", boolean) &&
		optional(value, "logicalEnd", boolean) &&
		optional(value, "command", commandTag) &&
		optional(value, "contributors", items => Array.isArray(items) && items.every(outputContributor)) &&
		(value.kind !== "Output" || (string(value.text) && finite(value.fd))) &&
		(value.kind !== "Assign" ||
			(string(value.name) && string(value.value) && finite(value.full_len) && string(value.scope)))
	);
}

/** Validate an untrusted persisted/native trace, including nested nodes and replay entries.
 * Callers should memoize by input reference; validating a journal is linear in its retained size.
 * This guard never caches mutable input objects as trusted. */
export function isShellTrace(value: unknown): value is ShellTrace {
	if (!record(value) || value.v !== 1 || !finite(value.seq) || !finite(value.t_ns) || !string(value.script))
		return false;
	return (
		optional(value, "status", finite) &&
		optional(value, "rootVpid", finite) &&
		Array.isArray(value.units) &&
		value.units.every(traceUnit) &&
		optional(
			value,
			"diags",
			items =>
				Array.isArray(items) &&
				items.every((item: unknown) => record(item) && string(item.code) && string(item.message)),
		) &&
		optional(value, "history", items => Array.isArray(items) && items.every(historyEntry)) &&
		optional(value, "historyTruncated", boolean)
	);
}
