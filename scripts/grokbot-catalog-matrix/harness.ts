/**
 * Pure catalog-matrix harness helpers (no grokbot/natives imports).
 */
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import toolBashUserPrompt from "./tool-bash-user.md" with { type: "text" };
import toolReadUserPrompt from "./tool-read-user.md" with { type: "text" };
import toolWriteUserPrompt from "./tool-write-user.md" with { type: "text" };

export type Mode = "text" | "tools" | "all";
export type Slice = "representative" | "all";
export type ToolsSet = "bash" | "core";
export type ToolSmokeKind = "bash" | "read" | "write";

/**
 * Probe effort for a matrix row: prefer the built model's thinking default /
 * supported ladder, then discovered sand defaults. Omit when nothing is known
 * so adaptive-only / max-only / non-reasoning rows do not send an invented `low`.
 */
export function matrixProbeEffort(model: Model<Api>): Effort | string | undefined {
	const levels = getSupportedEfforts(model);
	const preferred = model.thinking?.defaultLevel;
	if (preferred && levels.includes(preferred)) return preferred;
	if (levels.includes(Effort.Low)) return Effort.Low;
	if (levels[0]) return levels[0];
	const defaults = model.sandParameterDefaults;
	const fromDefaults = defaults?.effort?.trim() || defaults?.reasoning?.trim();
	return fromDefaults || undefined;
}

/** CLI `--thinking` args for the omp `-p` slice; omit when no supported tier is known. */
export function matrixOmpThinkingArgs(model: Model<Api>): string[] {
	const levels = getSupportedEfforts(model);
	const preferred = model.thinking?.defaultLevel;
	let effort: Effort | undefined;
	if (preferred && levels.includes(preferred)) effort = preferred;
	else if (levels.includes(Effort.Low)) effort = Effort.Low;
	else if (levels[0]) effort = levels[0];
	// Do not forward sand-only defaults (e.g. `adaptive`) — omp CLI accepts only
	// ThinkingLevel vocabulary from getSupportedEfforts().
	return effort !== undefined ? ["--thinking", String(effort)] : [];
}

export type MatrixArgs = {
	mode: Mode;
	slice: Slice;
	limit?: number;
	ids?: string[];
	concurrency: number;
	json?: string;
	omp: boolean;
	allowMissingCreds: boolean;
	probeGated: boolean;
	dryRun: boolean;
	toolsSet: ToolsSet;
};

/**
 * Split a `--ids` list on commas, but keep commas inside `[...]`
 * (`gpt-5.3-codex[reasoning=medium,fast=false]` is one id).
 */
export function splitMatrixIds(raw: string): string[] {
	const out: string[] = [];
	let current = "";
	let depth = 0;
	for (const ch of raw) {
		if (ch === "[") {
			depth++;
			current += ch;
			continue;
		}
		if (ch === "]") {
			depth = Math.max(0, depth - 1);
			current += ch;
			continue;
		}
		if (ch === "," && depth === 0) {
			const token = current.trim();
			if (token) out.push(token);
			current = "";
			continue;
		}
		current += ch;
	}
	const last = current.trim();
	if (last) out.push(last);
	return out;
}

export function parseArgs(argv: string[]): MatrixArgs {
	const get = (flag: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const mode = (get("--mode") ?? "all") as Mode;
	const slice = (get("--slice") ?? "all") as Slice;
	const limitRaw = get("--limit");
	const idsRaw = get("--ids");
	const concurrencyRaw = get("--concurrency");
	const toolsSetRaw = get("--tools-set");
	return {
		mode: mode === "text" || mode === "tools" ? mode : "all",
		slice: slice === "representative" ? "representative" : "all",
		limit: limitRaw ? Number(limitRaw) : undefined,
		ids: idsRaw ? splitMatrixIds(idsRaw) : undefined,
		concurrency: Math.max(1, Number(concurrencyRaw ?? 3) || 3),
		json: get("--json"),
		omp: argv.includes("--omp"),
		allowMissingCreds: argv.includes("--allow-missing-creds"),
		probeGated: argv.includes("--probe-gated"),
		dryRun: argv.includes("--dry-run"),
		toolsSet: toolsSetRaw === "bash" ? "bash" : "core",
	};
}

/**
 * Resolve `--ids` against the live catalog. Missing ids must fail the gate —
 * silently dropping them can yield an empty PASS.
 */
export function resolveExplicitMatrixIds(
	requested: readonly string[],
	liveIds: ReadonlySet<string>,
): { selected: string[] } | { missing: string[] } {
	const missing = requested.filter(id => !liveIds.has(id));
	if (missing.length > 0) return { missing };
	return { selected: [...requested] };
}

/** Row status for matrix printing: text failures beat tool-skip labels. */
export function matrixRowFlag(
	row: { skip?: string; textPass?: boolean; toolsPass?: boolean },
	mode: Mode,
): "PASS" | "FAIL" | "SKIP" {
	if (row.toolsPass === false || (mode !== "tools" && row.textPass === false)) return "FAIL";
	if (row.skip) return "SKIP";
	return "PASS";
}

export function idSafe(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

export function classifyError(message: string | undefined, status?: number): string {
	const text = message ?? "";
	// Before HTTP 400: keep-model opus-thinking rows can 400 with this body
	// while the product wire is fine — a safety classifier, not a schema miss.
	if (/Request blocked by Anthropic|blocked under Anthropic['’]?s Usage Policy/i.test(text)) {
		return "provider-policy-block";
	}
	if (status === 422 || /HTTP 422/.test(text)) return "http-422";
	if (status === 400 || /HTTP 400/.test(text) || /ERROR_PROVIDER_ERROR/.test(text)) return "http-400";
	if (status === 401 || /HTTP 401|unauthenticated/i.test(text)) return "http-401";
	if (status === 504 || /HTTP 504|gateway timeout/i.test(text)) return "http-504";
	if (status === 502 || /HTTP 502|bad gateway/i.test(text)) return "http-502";
	if (status === 404 || /model.?not.?found/i.test(text)) return "model-not-found";
	if (/no text or tool call/i.test(text)) return "empty-body";
	if (/incomplete tool call/i.test(text)) return "incomplete-tool";
	if (text) return "provider-error";
	return "unknown";
}

export function writeLikeShellCommand(command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	return shellStatementSegments(cmd).some(segment => shellWriteRedirect(segment) != null);
}

export function readLikeShellCommand(command: string): boolean {
	const cmd = command.trim();
	if (!cmd || writeLikeShellCommand(cmd)) return false;
	return /(?:^|[;&|\n]\s*)(?:cat|head|sed)\b/.test(cmd);
}

/** Strip `#` comments, then split into statements (`\n`, `;`, `&&`, `&`). Pipes stay together. */
function shellStatementSegments(command: string): string[] {
	const withoutComments = command
		.split("\n")
		.map(line => line.replace(/(^|[\t ;&|])#[^\n]*/g, "$1"))
		.join("\n");
	return withoutComments
		.split(/\n|&&|&|;/)
		.map(s => s.trim())
		.filter(Boolean);
}

/** True when a statement would prevent later statements from running. */
function earlyExitShellSegment(segment: string): boolean {
	return /^(?:exit|return)\b/.test(segment);
}

/**
 * Split on the first unquoted `>`, `>>`, or `| tee` so quoted redirect
 * characters (`echo 'ping > path'`) do not count as writes.
 */
function shellWriteRedirect(segment: string): { before: string; after: string; op: ">" | ">>" | "tee" } | null {
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote) {
			if (ch === "\\" && quote !== "'") {
				escaped = true;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === ">") {
			const op = segment[i + 1] === ">" ? ">>" : ">";
			const before = segment.slice(0, i).trim();
			const after = segment.slice(i + op.length).trim();
			if (!/^(?:echo|printf|cat)\b/.test(before)) return null;
			return { before, after, op };
		}
		if (ch === "|") {
			const rest = segment.slice(i + 1).trim();
			if (!/^tee\b/.test(rest)) continue;
			const before = segment.slice(0, i).trim();
			if (!/^(?:echo|printf|cat)\b/.test(before)) return null;
			return { before, after: rest.replace(/^tee\b/, "").trim(), op: "tee" };
		}
	}
	return null;
}

/** True when `filePath` appears as a whole path segment (not a prefix of `….txt.bak`). */
function commandMentionsPath(segment: string, filePath: string): boolean {
	let from = 0;
	while (from <= segment.length) {
		const idx = segment.indexOf(filePath, from);
		if (idx < 0) return false;
		const beforeOk = idx === 0 || isLeadingPathBoundary(segment[idx - 1]!);
		const afterIdx = idx + filePath.length;
		const afterOk = afterIdx >= segment.length || isTrailingPathBoundary(segment[afterIdx]!);
		if (beforeOk && afterOk) return true;
		from = idx + 1;
	}
	return false;
}

function isLeadingPathBoundary(ch: string): boolean {
	return ch === "/" || /\s/.test(ch) || ch === "'" || ch === '"' || ch === "`";
}

function isTrailingPathBoundary(ch: string): boolean {
	return /\s/.test(ch) || ch === "'" || ch === '"' || ch === "`" || /[;&|<>()]/.test(ch);
}

/**
 * Bash smoke must actually echo/printf the ping to stdout — not in a sibling
 * statement, comment, redirect filename (`echo wrong > ping`), diverted stdout
 * (`echo ping >/dev/null`, `echo ping | tee file`), or a pipeline that can
 * filter the token away (`echo ping | grep -v ping`).
 */
export function echoLikeShellCommand(command: string, ping: string): boolean {
	if (!ping) return false;
	const cmd = command.trim();
	if (!cmd) return false;
	return shellStatementSegments(cmd).some(segment => {
		if (!/^(?:echo|printf)\b/.test(segment)) return false;
		// Redirects / any pipeline can discard or transform stdout.
		if (/(?:>>?|\|)/.test(segment)) return false;
		return segment.includes(ping);
	});
}

/** Read smoke: path must appear in the same cat/head/sed statement. */
export function readPathInShellCommand(command: string, filePath: string): boolean {
	if (!filePath) return false;
	const cmd = command.trim();
	if (!cmd || writeLikeShellCommand(cmd)) return false;
	return shellStatementSegments(cmd).some(segment => {
		if (!/^(?:cat|head|sed)\b/.test(segment)) return false;
		// Redirects / any pipeline can discard or transform stdout — `runOneTool`
		// fabricates the expected token without executing, so `cat path | grep -v`
		// would otherwise pass the gate.
		if (/(?:>>?|\|)/.test(segment)) return false;
		return commandMentionsPath(segment, filePath);
	});
}

/**
 * Write smoke: unquoted redirect/`tee` of the ping into `filePath` in the same
 * statement. Quoted `>` (`echo 'ping > path'`) and earlier `exit`/`return`
 * statements do not count — `runOneTool` fabricates success without executing.
 */
export function writePathPingInShellCommand(command: string, filePath: string, ping: string): boolean {
	if (!filePath || !ping) return false;
	const cmd = command.trim();
	if (!cmd) return false;
	for (const segment of shellStatementSegments(cmd)) {
		if (earlyExitShellSegment(segment)) return false;
		const redirect = shellWriteRedirect(segment);
		if (!redirect) continue;
		if (!redirect.before.includes(ping)) continue;
		if (!commandMentionsPath(redirect.after, filePath)) continue;
		return true;
	}
	return false;
}

export function expectedReadPath(safeId: string): string {
	return `notes/grokbot-read-${safeId}.txt`;
}

export function expectedWritePath(safeId: string): string {
	return `notes/grokbot-write-${safeId}.txt`;
}

type SmokeToolCall = {
	name: string;
	arguments?: unknown;
};

function argRecord(call: SmokeToolCall): Record<string, unknown> {
	return call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
		? (call.arguments as Record<string, unknown>)
		: {};
}

function shellCommandOf(call: SmokeToolCall): string {
	return String(argRecord(call).command ?? "");
}

function filePathOf(call: SmokeToolCall): string {
	const args = argRecord(call);
	return String(args.path ?? args.target_file ?? "");
}

function fileContentOf(call: SmokeToolCall): string {
	const args = argRecord(call);
	return String(args.content ?? args.contents ?? "");
}

/**
 * Accept a tool call only when it targets the smoke operation under test
 * (token / path / payload), not merely a matching tool name.
 */
export function matchesToolSmokeCall(kind: ToolSmokeKind, call: SmokeToolCall, ping: string, id: string): boolean {
	const safe = idSafe(id);
	const name = call.name;
	if (kind === "bash") {
		if (!/^(bash|Shell|shell)$/i.test(name)) return false;
		return echoLikeShellCommand(shellCommandOf(call), ping);
	}
	if (kind === "read") {
		const path = expectedReadPath(safe);
		if (/^(read|Read)$/i.test(name)) {
			const filePath = filePathOf(call);
			// Exact relative path or absolute path ending in /${path} — never a bare
			// endsWith(path) (wrongnotes/... would otherwise match notes/...).
			return filePath === path || filePath.endsWith(`/${path}`);
		}
		if (/^(bash|Shell|shell)$/i.test(name)) {
			const cmd = shellCommandOf(call);
			return readPathInShellCommand(cmd, path);
		}
		return false;
	}
	const path = expectedWritePath(safe);
	if (/^(write|Write)$/i.test(name)) {
		const filePath = filePathOf(call);
		const content = fileContentOf(call);
		const pathOk = filePath === path || filePath.endsWith(`/${path}`);
		return pathOk && content.includes(ping);
	}
	if (/^(bash|Shell|shell)$/i.test(name)) {
		const cmd = shellCommandOf(call);
		return writePathPingInShellCommand(cmd, path, ping);
	}
	return false;
}

/**
 * Turn-2 text gate after a successful tool call. Requires a finished `stop`
 * reply that includes the unique row ping, unless this is the documented
 * Gemini Write empty-stop exception.
 */
export function evaluateToolFollowupText(opts: {
	kind: ToolSmokeKind;
	body: string;
	ping: string;
	stopReason: string;
	/**
	 * Canonical request model id (prefer `model.requestModelId` over display
	 * `model.id`). Empty Write acceptance is Gemini-class only; opaque
	 * variant/legacy selectors classify as unknown and would false-fail.
	 */
	modelId: string;
}): { pass: boolean; detail?: string } {
	const isGemini = classifyModel("grokbot", opts.modelId, { lenient: true }).class === "gemini";
	if (isGemini && opts.kind === "write" && opts.body.trim().length === 0 && opts.stopReason === "stop") {
		return { pass: true, detail: "empty-followup-after-write" };
	}
	if (opts.stopReason !== "stop") {
		return {
			pass: false,
			detail: `${opts.kind}: follow-up stopReason=${opts.stopReason} (expected stop); text=${opts.body.slice(0, 120)}`,
		};
	}
	if (opts.body.includes(opts.ping)) return { pass: true };
	return {
		pass: false,
		detail: `${opts.kind}: follow-up omitted ping; text=${opts.body.slice(0, 120)}`,
	};
}

function jsonContainsToken(value: unknown, token: string): boolean {
	if (typeof value === "string") return value.includes(token);
	if (Array.isArray(value)) return value.some(entry => jsonContainsToken(entry, token));
	if (value && typeof value === "object") {
		return Object.values(value as Record<string, unknown>).some(entry => jsonContainsToken(entry, token));
	}
	return false;
}

function isBashLikeToolName(name: unknown): boolean {
	return typeof name === "string" && /^(bash|Shell|shell)$/i.test(name);
}

/**
 * Evidence that the omp tools smoke actually executed bash (not assistant prose).
 * Expects `--mode json` event lines: only `tool_execution_end` / toolResult payloads count.
 */
export function ompToolsExecutionEvidence(out: string, token: string): boolean {
	for (const line of out.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!event || typeof event !== "object") continue;
		const rec = event as Record<string, unknown>;
		if (rec.type === "tool_execution_end" && rec.isError !== true && isBashLikeToolName(rec.toolName)) {
			if (jsonContainsToken(rec.result, token)) return true;
		}
		if (rec.type === "turn_end" && Array.isArray(rec.toolResults)) {
			for (const toolResult of rec.toolResults) {
				if (!toolResult || typeof toolResult !== "object") continue;
				const tr = toolResult as Record<string, unknown>;
				if (tr.isError === true) continue;
				if (!isBashLikeToolName(tr.toolName) && !isBashLikeToolName(tr.name)) continue;
				if (jsonContainsToken(tr, token)) return true;
			}
		}
		if (rec.type === "message_end" && rec.message && typeof rec.message === "object") {
			const message = rec.message as Record<string, unknown>;
			if (message.role !== "toolResult" || message.isError === true) continue;
			if (!isBashLikeToolName(message.toolName)) continue;
			if (jsonContainsToken(message, token)) return true;
		}
	}
	return false;
}

// Live keep-model: explicit Read/Write tools trip Anthropic Usage Policy on
// opus-thinking ids. Shell echo/cat/printf-redirect is accepted and remaps
// to product Shell; isReadLikeCall / isWriteLikeCall count those as read/write.
export function toolSmokePrompt(kind: ToolSmokeKind, ping: string, id: string): string {
	const safe = idSafe(id);
	if (kind === "bash") {
		return prompt.render(toolBashUserPrompt, { ping }).trim();
	}
	if (kind === "read") {
		return prompt.render(toolReadUserPrompt, { safeId: safe }).trim();
	}
	return prompt.render(toolWriteUserPrompt, { ping, safeId: safe }).trim();
}
