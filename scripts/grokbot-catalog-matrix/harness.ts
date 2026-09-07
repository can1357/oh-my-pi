/**
 * Pure catalog-matrix harness helpers (no grokbot/natives imports).
 */
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import toolBashUserPrompt from "./tool-bash-user.md" with { type: "text" };
import toolReadUserPrompt from "./tool-read-user.md" with { type: "text" };
import toolWriteUserPrompt from "./tool-write-user.md" with { type: "text" };

export type Mode = "text" | "tools" | "all";
export type Slice = "representative" | "all";
export type ToolsSet = "bash" | "core";
export type ToolSmokeKind = "bash" | "read" | "write";

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
	return /(?:^|[;&|\n]\s*)(?:echo|printf|cat|tee)\b/.test(cmd) && /(?:>>?|tee\b)/.test(cmd);
}

export function readLikeShellCommand(command: string): boolean {
	const cmd = command.trim();
	if (!cmd || writeLikeShellCommand(cmd)) return false;
	return /(?:^|[;&|\n]\s*)(?:cat|head|sed)\b/.test(cmd);
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
		return shellCommandOf(call).includes(ping);
	}
	if (kind === "read") {
		const path = expectedReadPath(safe);
		if (/^(read|Read)$/i.test(name)) {
			const filePath = filePathOf(call);
			return filePath === path || filePath.endsWith(`/${path}`) || filePath.endsWith(path);
		}
		if (/^(bash|Shell|shell)$/i.test(name)) {
			const cmd = shellCommandOf(call);
			return readLikeShellCommand(cmd) && cmd.includes(path);
		}
		return false;
	}
	const path = expectedWritePath(safe);
	if (/^(write|Write)$/i.test(name)) {
		const filePath = filePathOf(call);
		const content = fileContentOf(call);
		const pathOk = filePath === path || filePath.endsWith(`/${path}`) || filePath.endsWith(path);
		return pathOk && content.includes(ping);
	}
	if (/^(bash|Shell|shell)$/i.test(name)) {
		const cmd = shellCommandOf(call);
		return writeLikeShellCommand(cmd) && cmd.includes(path) && cmd.includes(ping);
	}
	return false;
}

/** Turn 1 already invoked the tool; these follow-up classes must not FAIL the id. */
export function isSoftPassToolFollowup(errorClass: string): boolean {
	return errorClass === "incomplete-tool" || errorClass === "empty-body" || errorClass === "provider-policy-block";
}

/**
 * Turn-2 text gate after a successful tool call. The unique ping must appear
 * unless this is the documented Gemini Write empty-stop exception.
 */
export function evaluateToolFollowupText(opts: {
	kind: ToolSmokeKind;
	body: string;
	ping: string;
	stopReason: string;
}): { pass: boolean; detail?: string } {
	if (opts.body.includes(opts.ping) || opts.body.includes("tools-pong")) return { pass: true };
	if (opts.kind === "write" && opts.body.trim().length === 0 && opts.stopReason === "stop") {
		return { pass: true, detail: "empty-followup-after-write" };
	}
	return {
		pass: false,
		detail: `${opts.kind}: follow-up omitted ping; text=${opts.body.slice(0, 120)}`,
	};
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
