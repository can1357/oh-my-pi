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

/** Turn 1 already invoked the tool; these follow-up classes must not FAIL the id. */
export function isSoftPassToolFollowup(errorClass: string): boolean {
	return errorClass === "incomplete-tool" || errorClass === "empty-body" || errorClass === "provider-policy-block";
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
