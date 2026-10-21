/**
 * Tool approval resolution.
 *
 * Approval policy is declared by each tool. This module only knows how to:
 * - normalize user `tools.approval.<tool>: allow | deny | prompt` overrides,
 * - compare a tool capability tier against the active approval mode,
 * - format the generic approval prompt body.
 */
import { isRecord, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import approvalFolderTemplate from "../prompts/tools/approval-folder.md" with { type: "text" };
import type { AgentTool, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import { normalizeToLF } from "../edit/normalize";
import type {
	ExtensionApprovalAnswer,
	ExtensionApprovalGrant,
	ExtensionApprovalPrompt,
	ExtensionUIContext,
} from "../extensibility/extensions/types";

import {
	type ApprovalGrantStore,
	type ApprovalGrants,
	approvalGrantKey,
	commonApprovalDirectoryKey,
} from "./approval-cache";
import { cfgToolsApproval, cfgToolsApprovalMode } from "./settings";
import {
	approvalFolderListing,
	type ApprovalFolderListing,
	approvalTargetDirectory,
	approvalTargetNamesFile,
	approvalTreeSearchFolderKey,
} from "./approval-targets";

export type { ToolApproval, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";

export type ApprovalPolicy = "allow" | "deny" | "prompt";

/** Every approval mode: the type below and `isApprovalMode` read from one list. */
const APPROVAL_MODES = ["always-ask", "always-ask-cached", "write", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** The slice of `AgentToolContext` that approval resolution actually reads. */
export type ApprovalContextSource = {
	autoApprove?: boolean;
	settings?: Settings;
};

export interface ResolvedExecuteTimeApproval {
	approvalMode: ApprovalMode;
	userPolicies: Record<string, unknown>;
}

type ApprovalSubject = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails" | "approvalCacheTargets"> & {
	/**
	 * Previous public name of this tool, when a rename changed how it mints.
	 * MCP tools minted before digits were kept carry their digit-stripped name
	 * here so user `deny`/`prompt` policies written against it still apply
	 * (`allow` is deliberately not inherited — see resolveApproval).
	 */
	readonly legacyName?: string;
};

/** Whether a runtime value names a supported approval mode. */
function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && APPROVAL_MODES.some(mode => mode === value);
}

function asPolicyMap(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Resolve approval mode and per-tool user policies from the execute-time
 * `AgentToolContext`.
 *
 * Missing context (or context with no settings and no `--auto-approve`) is
 * fail-closed: `always-ask` with an empty policy map — no user grant. When
 * settings are present, the configured `tools.approvalMode` is used (schema
 * default remains `yolo`). `--auto-approve` still forces `yolo`.
 *
 * Shared by `ExtensionToolWrapper.execute`, `refuseByWritePolicy`,
 * `mcpApprovalPreflight`, and eval prelude host calls so those sites cannot
 * drift. `ExtensionToolWrapper.execute` still inherits the runner's session
 * settings when the caller omits context, so a live session keeps its
 * configured (schema-default `yolo`) grant.
 */
export function resolveApprovalFromContext(context?: ApprovalContextSource | null): ResolvedExecuteTimeApproval {
	if (context?.autoApprove === true) {
		return {
			approvalMode: "yolo",
			userPolicies: context.settings ? asPolicyMap(cfgToolsApproval.get(context.settings)) : {},
		};
	}
	const settings = context?.settings;
	if (!settings) {
		return { approvalMode: "always-ask", userPolicies: {} };
	}
	const configured: unknown = cfgToolsApprovalMode.get(settings);
	return {
		approvalMode: isApprovalMode(configured) ? configured : "yolo",
		userPolicies: asPolicyMap(cfgToolsApproval.get(settings)),
	};
}

export interface ResolvedApproval {
	policy: ApprovalPolicy;
	tier: ToolTier;
	reason?: string;
	override: boolean;
	source?: "tool" | "user" | "mode";
	/**
	 * User-policy key that produced `source: "user"` (defaults to the tool name), or the keyed
	 * sub-tool (an `xd://` device) a tool-owned or mode decision is about.
	 */
	policyKey?: string;
}

const POLICY_VALUES: ReadonlySet<ApprovalPolicy> = new Set(["allow", "deny", "prompt"]);
const TIER_VALUES: ReadonlySet<ToolTier> = new Set(["read", "write", "exec"]);

/** Ordering of capability tiers, least to most privileged. */
export const TIER_RANK: Readonly<Record<ToolTier, number>> = {
	read: 0,
	write: 1,
	exec: 2,
};

/**
 * Fold the per-target decisions of a multi-target write tool (`edit`, `ast_edit`): the first
 * `policy: "deny"` decision wins with its reason (a read-only URL target); otherwise the highest
 * tier, starting from "read".
 */
export function strictestApproval(decisions: Iterable<ToolApprovalDecision>): ToolApprovalDecision {
	let tier: ToolTier = "read";
	for (const decision of decisions) {
		if (typeof decision !== "string" && decision.policy === "deny") return decision;
		const decisionTier = typeof decision === "string" ? decision : decision.tier;
		if (TIER_RANK[decisionTier] > TIER_RANK[tier]) tier = decisionTier;
	}
	return tier;
}

const APPROVAL_MODE_MAX_TIER: Record<ApprovalMode, ToolTier> = {
	"always-ask": "read",
	"always-ask-cached": "read",
	write: "write",
	yolo: "exec",
};

/** Cache targets a tool reports for this call, blanks dropped; empty when the tool declares none. */
function approvalCacheTargets(tool: ApprovalSubject, args: unknown): string[] {
	return (tool.approvalCacheTargets?.(args) ?? []).filter(target => typeof target === "string" && target.length > 0);
}

/**
 * Grant keys any one of which covers `target` for a call at `capability`: grants at that tier or a
 * more privileged one, on the target itself or — for a file key — on the folder holding it. Folder
 * grants cover their own entries only, so a directory or tree key never inherits its parent's.
 */
function coveringGrantKeys(target: string, capability: ToolTier): string[] {
	const subjects = [target];
	if (path.isAbsolute(target) && !target.endsWith("/") && !target.endsWith("\\")) {
		const parent = path.dirname(target);
		subjects.push(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
	}
	const tiers = (["read", "write", "exec"] as const).filter(tier => TIER_RANK[tier] >= TIER_RANK[capability]);
	return tiers.flatMap(tier => subjects.map(subject => approvalGrantKey(tier, subject)));
}

/**
 * Mode step for `always-ask-cached`, reached only when no tool or user policy decided. A call
 * whose cache targets are all granted runs; a read-tier call with no targets runs as in
 * `always-ask`; everything else prompts. Without `grants` nothing counts as remembered.
 */
function resolveCachedModeApproval(
	tool: ApprovalSubject,
	args: unknown,
	decision: Omit<ResolvedApproval, "policy">,
	grants: ApprovalGrantStore | undefined,
): ResolvedApproval {
	const base = {
		tier: decision.tier,
		override: false,
		source: "mode" as const,
		...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
	};
	const targets = approvalCacheTargets(tool, args);
	if (targets.length === 0) {
		if (decision.tier === "read") return { ...base, policy: "allow" };
		return { ...base, policy: "prompt", ...(decision.reason ? { reason: decision.reason } : {}) };
	}
	const candidates = targets.map(target => coveringGrantKeys(target, decision.tier));
	const present = grants?.present(candidates.flat());
	if (present && candidates.every(keys => keys.some(key => present.has(key)))) return { ...base, policy: "allow" };
	return { ...base, policy: "prompt", reason: decision.reason ?? "target not yet approved" };
}

/**
 * The folder a directory answer would grant: the deepest directory holding every path target — a
 * directory target is that directory itself, a file target its parent. `undefined` when the call
 * names no filesystem path.
 */
export function approvalFolderCandidate(
	tool: ApprovalSubject,
	args: unknown,
): { key: string; label: string } | undefined {
	const directories: string[] = [];
	for (const target of approvalCacheTargets(tool, args)) {
		if (!path.isAbsolute(target)) continue;
		const directory = approvalTargetDirectory(target);
		if (directory !== undefined) directories.push(directory);
	}
	const key = commonApprovalDirectoryKey(directories);
	if (key === undefined) return undefined;
	// A filesystem root keeps its separator: stripping it would leave POSIX "" or drive-relative "C:".
	const label = shortenPath(path.parse(key).root === key ? key : key.replace(/[\\/]+$/, ""));
	return { key, label: sanitizeText(label) };
}

/**
 * Record the grant an approved `always-ask-cached` prompt answered, keyed by the capability the
 * call resolved to: the folder for a directory answer, else every exact target. A tree target (a
 * recursive search) also records the folder grant it includes.
 */
export function recordApprovalGrant(
	tool: ApprovalSubject,
	args: unknown,
	grants: ApprovalGrants,
	capability: ToolTier,
	answer: { grant: "folder" | "target"; always: boolean },
): void {
	const tier = answer.always ? "global" : "session";
	const folder = answer.grant === "folder" ? approvalFolderCandidate(tool, args) : undefined;
	if (folder) {
		grants.record(approvalGrantKey(capability, folder.key), tool.name, tier);
		return;
	}
	for (const target of approvalCacheTargets(tool, args)) {
		grants.record(approvalGrantKey(capability, target), tool.name, tier);
		const folderKey = approvalTreeSearchFolderKey(target);
		if (folderKey !== undefined) grants.record(approvalGrantKey(capability, folderKey), tool.name, tier);
	}
}

const DEFAULT_PROMPT_TRUNCATE_CHARS = 2000;

/** Best-effort conversion of an arbitrary user-supplied value to a policy. */
function normalizePolicy(value: unknown): ApprovalPolicy | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	return POLICY_VALUES.has(lowered as ApprovalPolicy) ? (lowered as ApprovalPolicy) : undefined;
}

function isToolTier(value: unknown): value is ToolTier {
	return typeof value === "string" && TIER_VALUES.has(value as ToolTier);
}

function normalizeDecision(value: unknown): Omit<ResolvedApproval, "policy"> & { policy?: ApprovalPolicy } {
	if (isToolTier(value)) {
		return { tier: value, override: false };
	}

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const tier = isToolTier(record.tier) ? record.tier : "exec";
		const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : undefined;
		const policy = normalizePolicy(record.policy);
		const policyKey =
			typeof record.policyKey === "string" && record.policyKey.length > 0 ? record.policyKey : undefined;
		return {
			tier,
			override: record.override === true,
			...(policy ? { policy } : {}),
			...(reason ? { reason } : {}),
			...(policyKey ? { policyKey } : {}),
		};
	}

	return { tier: "exec", override: false };
}

function getToolDecision(
	tool: ApprovalSubject,
	args: unknown,
): Omit<ResolvedApproval, "policy"> & { policy?: ApprovalPolicy } {
	const approval = tool.approval;
	const decision: ToolApprovalDecision | undefined = typeof approval === "function" ? approval(args) : approval;
	return normalizeDecision(decision);
}

/**
 * Evaluate a tool's own approval declaration against `args` and return the
 * resulting capability tier, defaulting to `exec` when the tool omits an
 * approval. Unlike reading `tool.approval` directly, this runs function-valued
 * approvals — the write tool's `xd://` gate uses it to take a mounted device's
 * argument-dependent tier instead of falling back to `exec`.
 */
export function resolveToolTier(tool: ApprovalSubject, args: unknown): ToolTier {
	return getToolDecision(tool, args).tier;
}

function modeApprovesTier(mode: ApprovalMode, tier: ToolTier): boolean {
	return TIER_RANK[tier] <= TIER_RANK[APPROVAL_MODE_MAX_TIER[mode]];
}

/**
 * Resolve approval policy for a tool call.
 *
 * Resolution order:
 *  1. Tool `approval(args)` decision, defaulting to tier "exec" when omitted.
 *     A decision may carry a `policyKey` — `tools.approval.<policyKey>` is then
 *     the user override consulted instead of `tools.approval.<tool.name>`, with
 *     the invoking tool's own policy as the fallback when the user set none for
 *     the keyed sub-tool (e.g. an `xd://` device dispatch without a device
 *     policy still honors `tools.approval.write`).
 *  2. User per-tool override, if set and valid.
 *  3. Active mode tier comparison. In `always-ask-cached`, a call whose
 *     `approvalCacheTargets` are all granted in `grants` is allowed instead
 *     (see {@link resolveCachedModeApproval}).
 *
 * In yolo mode, override-based tool prompts are ignored; user `tools.approval`
 * settings remain authoritative.
 */
export function resolveApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	grants?: ApprovalGrantStore,
): ResolvedApproval {
	const decision = getToolDecision(tool, args);
	const policyKey = decision.policyKey ?? tool.name;
	const userPolicy = Object.hasOwn(userConfig, policyKey) ? normalizePolicy(userConfig[policyKey]) : undefined;
	const fallbackPolicy =
		policyKey !== tool.name && userPolicy === undefined && Object.hasOwn(userConfig, tool.name)
			? normalizePolicy(userConfig[tool.name])
			: undefined;
	const effectiveUserPolicy = userPolicy ?? fallbackPolicy;
	const userPolicyKey = userPolicy !== undefined ? policyKey : tool.name;

	// Legacy-name fallback for renamed tools (e.g. MCP mints that gained digits).
	// Fail-closed: only `deny`/`prompt` carry over from the old key, so a
	// forgotten restrictive policy keeps protecting the renamed tool, while a
	// stale `allow` cannot mask a `deny` another user sets under the new name.
	const legacyPolicy =
		effectiveUserPolicy === undefined &&
		typeof tool.legacyName === "string" &&
		tool.legacyName !== tool.name &&
		Object.hasOwn(userConfig, tool.legacyName)
			? normalizePolicy(userConfig[tool.legacyName])
			: undefined;
	const inheritedPolicy = legacyPolicy === "deny" || legacyPolicy === "prompt" ? legacyPolicy : undefined;
	const inheritedPolicyKey = inheritedPolicy !== undefined ? tool.legacyName : undefined;
	const combinedUserPolicy = effectiveUserPolicy ?? inheritedPolicy;
	const combinedUserPolicyKey = effectiveUserPolicy !== undefined ? userPolicyKey : inheritedPolicyKey;

	if (decision.policy === "deny") {
		return {
			policy: "deny",
			tier: decision.tier,
			override: decision.override,
			source: "tool",
			...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}
	if (combinedUserPolicy === "deny") {
		return {
			policy: "deny",
			tier: decision.tier,
			override: decision.override,
			source: "user",
			...(combinedUserPolicyKey ? { policyKey: combinedUserPolicyKey } : {}),
		};
	}

	if (mode === "yolo") {
		if (decision.policy) {
			return {
				policy: decision.policy,
				tier: decision.tier,
				override: false,
				source: "tool",
				...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
				...(decision.reason ? { reason: decision.reason } : {}),
			};
		}
		return {
			policy: combinedUserPolicy ?? "allow",
			tier: decision.tier,
			override: false,
			source: combinedUserPolicy ? "user" : "mode",
			...(combinedUserPolicyKey ? { policyKey: combinedUserPolicyKey } : {}),
		};
	}

	if (decision.override) {
		return {
			policy: decision.policy === "allow" ? "allow" : "prompt",
			tier: decision.tier,
			override: true,
			source: "tool",
			...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}

	if (decision.policy === "allow" || decision.policy === "prompt") {
		return {
			policy: decision.policy,
			tier: decision.tier,
			override: false,
			source: "tool",
			...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}

	if (combinedUserPolicy) {
		return {
			policy: combinedUserPolicy,
			tier: decision.tier,
			override: false,
			source: "user",
			...(combinedUserPolicyKey ? { policyKey: combinedUserPolicyKey } : {}),
		};
	}

	if (mode === "always-ask-cached") {
		return resolveCachedModeApproval(tool, args, decision, grants);
	}

	if (modeApprovesTier(mode, decision.tier)) {
		return { policy: "allow", tier: decision.tier, override: false, source: "mode" };
	}

	return {
		policy: "prompt",
		tier: decision.tier,
		override: false,
		source: "mode",
		...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
		...(decision.reason ? { reason: decision.reason } : {}),
	};
}

/**
 * What an "approve for this session" answer may cover for a `resolved` prompt: the subject the
 * prompt names (the tool, or its `xd://` device) and a grant key that also pins the tier, so
 * approving a write never covers an exec call of the same tool. Undefined when the prompt must
 * stay per-call: only a prompt the approval mode raised is grantable, never a critical override
 * or an explicit `prompt` policy (the user's or the tool's own).
 */
export function sessionApprovalScope(
	resolved: ResolvedApproval,
	toolName: string,
): { subject: string; key: string } | undefined {
	if (resolved.policy !== "prompt" || resolved.source !== "mode") return undefined;
	const subject = resolved.policyKey ?? toolName;
	return { subject, key: `${subject}\0${resolved.tier}` };
}

/**
 * Error for a resolved deny. Distinguishes tool-owned policy from user config.
 */
export function denyError(resolved: ResolvedApproval, toolName: string): Error {
	const { source, reason, policyKey } = resolved;
	if (source === "tool") {
		return new Error(`Tool "${toolName}" is blocked by tool policy.${reason ? `\nReason: ${reason}` : ""}`);
	}
	return new Error(
		`Tool "${policyKey ?? toolName}" is blocked by user policy.\n` +
			`To allow: remove "tools.approval.${policyKey ?? toolName}: deny" from config.`,
	);
}

/**
 * Check if a tool call requires user approval.
 *
 * @throws Error if policy is 'deny'
 * @returns Object with required flag and optional reason for the prompt
 */
export function requiresApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
): { required: boolean; reason?: string } {
	const resolved = resolveApproval(tool, args, mode, userConfig);
	const { policy, reason } = resolved;

	if (policy === "deny") {
		throw denyError(resolved, tool.name);
	}

	if (policy === "prompt") return { required: true, reason };
	return { required: false };
}

export function truncateForPrompt(value: string, maxChars = DEFAULT_PROMPT_TRUNCATE_CHARS): string {
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	return `${value.slice(0, maxChars)}[…${omitted}ch elided…]`;
}

function formatPayloadValue(value: unknown, indent: number): string {
	if (value === null) return "null";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") {
		const normalized = replaceTabs(normalizeToLF(value));
		if (normalized.includes("\n")) {
			const padding = " ".repeat(indent);
			// Keep delimiters and commas outside the body, including in arrays.
			// JSON-escape each row so terminal controls remain visible text.
			const lines = normalized
				.split("\n")
				.map(line => `${padding}  ${sanitizeText(JSON.stringify(line).slice(1, -1))}`);
			return `"\n${lines.join("\n")}\n${padding}"`;
		}
		return sanitizeText(JSON.stringify(normalized));
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const items = value.map((item, index) => {
			const isLast = index === value.length - 1;
			const nextIndent = indent + 2;
			const formatted = formatPayloadValue(item, nextIndent);
			return " ".repeat(nextIndent) + formatted + (isLast ? "" : ",");
		});
		return "[\n" + items.join("\n") + "\n" + " ".repeat(indent) + "]";
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) return "{}";
		const lines: string[] = ["{"];
		for (let i = 0; i < entries.length; i++) {
			const [key, entryValue] = entries[i]!;
			const isLast = i === entries.length - 1;
			const keyStr = sanitizeText(JSON.stringify(key));
			const keyIndent = " ".repeat(indent + 2);
			const formatted = formatPayloadValue(entryValue, indent + 2);
			lines.push(`${keyIndent}${keyStr}: ${formatted}${isLast ? "" : ","}`);
		}
		lines.push(" ".repeat(indent) + "}");
		return lines.join("\n");
	}
	return replaceTabs(sanitizeText(String(value)));
}

/**
 * Layout a decoded device or MCP argument payload:
 * - standard JSON layout with 2-space indentation
 * - multiline strings (manifests, scripts, policy documents) expanded into quoted blocks
 * - tabs sanitized to spaces
 */
export function formatApprovalArguments(args: unknown, options?: { showEmpty?: boolean }): string[] {
	if (args === undefined) {
		return [];
	}
	if (!options?.showEmpty && (args === null || (typeof args === "object" && Object.keys(args).length === 0))) {
		return [];
	}
	const formatted = formatPayloadValue(args, 0);
	return [`Arguments:\n${truncateForPrompt(formatted)}`];
}

/** The prompt's header rows: tool name, MCP origin, and the reason it asks. */
function approvalHeader(tool: ApprovalSubject, reason?: string): string[] {
	const lines = [`Allow tool: ${tool.name}`];

	if (tool.name.startsWith("mcp__") && tool.approval === undefined) {
		lines.push("Origin: MCP server tool");
	}

	if (reason) {
		lines.push(`Reason: ${reason}`);
	}
	return lines;
}

/** The tool's own detail rows for `args` (command, path, content), blanks dropped. */
function approvalDetails(tool: ApprovalSubject, args: unknown): string[] {
	const details = tool.formatApprovalDetails?.(args);
	if (details !== undefined) {
		return (typeof details === "string" ? [details] : details).filter(detail => detail.length > 0);
	}
	if (tool.name.startsWith("mcp__")) {
		return formatApprovalArguments(args);
	}
	return [];
}

/** Format the approval prompt body shown to the user: the header, then the tool's own details. */
export function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string {
	return [...approvalHeader(tool, reason), ...approvalDetails(tool, args)].join("\n");
}

/**
 * The details as one row for a prompt that must stay small: each detail's first line, joined
 * by ` · `, ending in `…` when any detail has more lines. A label alone (`Code:`, its body on
 * the following lines) takes the body's first line after it.
 */
function approvalSummary(details: readonly string[]): string | undefined {
	if (details.length === 0) return undefined;
	let omitted = false;
	const heads = details.map(detail => {
		const lines = detail.split("\n", 3);
		const head = lines[0]!.trimEnd();
		const labelOnly = head.endsWith(":") && lines.length > 1;
		if (lines.length > (labelOnly ? 2 : 1)) omitted = true;
		return labelOnly ? `${head} ${lines[1]!.trim()}` : head;
	});
	const row = heads.join(" · ");
	return omitted ? `${row} …` : row;
}

/** Entries the full prompt lists for the folder a grant would cover; the rest are counted, not named. */
const APPROVAL_FOLDER_FULL_LISTING = 24;
/** Entries the compact prompt lists before the count takes over. */
const APPROVAL_FOLDER_COMPACT_LISTING = 4;
/** Counts one entry, one folder, one file — "1 folder", "3 files". */
const count = (n: number, singular: string, plural: string): string => `${n} ${n === 1 ? singular : plural}`;

/**
 * The prompt section naming the folder a grant would cover and listing its own entries — the whole
 * reach of a folder grant — so the prompt shows what it is about to allow before the user approves
 * it. Names come from the filesystem, so they are sanitized; a folder nothing occupies yet still
 * gets its name, with no counts. `undefined` without a folder answer.
 */
function approvalFolderPromptBlock(
	folder: string | undefined,
	listing: ApprovalFolderListing | undefined,
	limit: number,
): string | undefined {
	if (folder === undefined) return undefined;
	const entries = listing === undefined ? [] : listing.entries.slice(0, limit).map(entry => sanitizeText(entry));
	const hidden = listing === undefined ? 0 : listing.total - entries.length;
	const summary =
		listing === undefined
			? undefined
			: listing.truncated
				? `${listing.total}+ entries`
				: `${count(listing.total, "entry", "entries")} (${count(listing.folders, "folder", "folders")}, ${count(listing.files, "file", "files")})`;
	const block = prompt.render(approvalFolderTemplate, {
		folder: sanitizeText(folder),
		summary,
		entries,
		more: hidden > 0 ? count(hidden, "more", "more") : undefined,
	});
	return block.trimEnd() || undefined;
}

/**
 * The grants an `always-ask-cached` prompt offers for this call, in display order: the directory
 * around it, when it names a filesystem path, then its exact targets — unless the only target is
 * that directory itself, which the directory answer already covers.
 */
function approvalGrantChoices(
	tool: ApprovalSubject,
	args: unknown,
	folder: { key: string; label: string } | undefined,
): ExtensionApprovalGrant[] {
	const grants: ExtensionApprovalGrant[] = [];
	if (folder) {
		grants.push({
			scope: "folder",
			label: `Approve Directory: ${folder.label}`,
			alwaysLabel: `Always Approve Directory: ${folder.label}`,
		});
	}
	const targets = approvalCacheTargets(tool, args);
	if (targets.some(target => target !== folder?.key)) {
		const files = targets.every(approvalTargetNamesFile);
		grants.push({
			scope: "target",
			label: files ? "Approve File" : "Approve",
			alwaysLabel: files ? "Always Approve File" : "Always Approve",
		});
	}
	return grants;
}

/**
 * Ask the user to approve a call: the host's approval dialog when it has one (it gets the full
 * prompt and a compact one with the details summarized to a row, so the composer beneath it
 * keeps its room), else a select with the full prompt (RPC, ACP, extension hosts). `appendix`
 * lines follow the prompt on both. With a `sessionSubject`, both also offer to approve that
 * subject for the rest of the session; with `grants`, both offer the `always-ask-cached` grants
 * the call can record, and the prompt lists the folder a directory grant would cover. Anything
 * but an explicit approval is `deny`.
 */
export async function requestApproval(
	ui: Pick<ExtensionUIContext, "select" | "approve">,
	tool: ApprovalSubject,
	args: unknown,
	options: { reason?: string; appendix?: readonly string[]; sessionSubject?: string; grants?: boolean } = {},
): Promise<ExtensionApprovalAnswer> {
	const { reason, appendix = [], sessionSubject } = options;
	const header = approvalHeader(tool, reason);
	const details = approvalDetails(tool, args);
	const session = sessionSubject === undefined ? undefined : `Approve ${sessionSubject} for this session`;
	const folder = options.grants ? approvalFolderCandidate(tool, args) : undefined;
	const grants = options.grants ? approvalGrantChoices(tool, args, folder) : [];
	// A directory answer names what it covers: the folder's own entries, listed in the prompt.
	const listing = folder ? await approvalFolderListing(folder.key, APPROVAL_FOLDER_FULL_LISTING) : undefined;
	const folderBlock = approvalFolderPromptBlock(folder?.label, listing, APPROVAL_FOLDER_FULL_LISTING);
	const full = [...header, ...details, ...(folderBlock ? [folderBlock] : []), ...appendix].join("\n");
	if (ui.approve) {
		const summary = approvalSummary(details);
		const compactBlock = approvalFolderPromptBlock(folder?.label, listing, APPROVAL_FOLDER_COMPACT_LISTING);
		const compact = [
			...header,
			...(summary ? [summary] : []),
			...(compactBlock ? [compactBlock] : []),
			...appendix,
		].join("\n");
		const answer = await ui.approve({
			full,
			compact,
			...(session ? { session } : {}),
			...(grants.length > 0 ? { grants } : {}),
		});
		if (answer === "once" || (answer === "session" && session)) return answer;
		if (typeof answer === "object" && answer !== null && grants.some(grant => grant.scope === answer.grant)) {
			return { grant: answer.grant, always: answer.always === true };
		}
		return "deny";
	}
	const choices = { ...(session ? { session } : {}), ...(grants.length > 0 ? { grants } : {}) };
	return approvalAnswerForChoice(choices, await ui.select(full, approvalChoiceLabels(choices)));
}

/** The approve-this-call-only label: "Approve", or "Approve Once" beside grants that remember more. */
export function approvalOnceLabel(prompt: Pick<ExtensionApprovalPrompt, "grants">): string {
	return prompt.grants?.length ? "Approve Once" : "Approve";
}

/**
 * An approval prompt's choices as select-menu labels, for hosts without an approval dialog (RPC,
 * ACP, collab guests): each grant for this session, each grant across sessions, this call only,
 * the session answer when offered, and Deny.
 */
export function approvalChoiceLabels(prompt: Pick<ExtensionApprovalPrompt, "session" | "grants">): string[] {
	const grants = prompt.grants ?? [];
	return [
		...grants.map(grant => grant.label),
		...grants.map(grant => grant.alwaysLabel),
		approvalOnceLabel(prompt),
		...(prompt.session ? [prompt.session] : []),
		"Deny",
	];
}

/** The answer a label from {@link approvalChoiceLabels} stands for; anything else denies. */
export function approvalAnswerForChoice(
	prompt: Pick<ExtensionApprovalPrompt, "session" | "grants">,
	choice: string | undefined,
): ExtensionApprovalAnswer {
	if (choice === undefined) return "deny";
	if (choice === approvalOnceLabel(prompt)) return "once";
	if (prompt.session && choice === prompt.session) return "session";
	for (const grant of prompt.grants ?? []) {
		if (choice === grant.label) return { grant: grant.scope, always: false };
		if (choice === grant.alwaysLabel) return { grant: grant.scope, always: true };
	}
	return "deny";
}
