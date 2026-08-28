/**
 * Project/Worktree/Branch/Task/Agent scoping.
 *
 * Generates and manages hierarchical identifiers for memory isolation.
 * All memory records must include these IDs for proper namespace isolation.
 *
 * Every generator is deterministic for the same input (except
 * {@link generateScopedSessionId}, which is intentionally unique per call), so
 * two processes observing the same repository derive identical scope IDs
 * without coordination.
 */

import { createHash, randomBytes } from "node:crypto";

/** Scoping context containing all hierarchical identifiers. */
export interface ScopingContext {
	/** Project-level identifier (derived from the repository root path). */
	projectId: string;
	/** Worktree identifier (for multi-worktree repositories). */
	worktreeId: string;
	/** Git branch identifier. */
	branchId: string;
	/** Task identifier (for multi-task sessions). */
	taskId?: string;
	/** Agent identifier (for multi-agent sessions). */
	agentId?: string;
	/** Session identifier. */
	sessionId: string;
}

/** Scope filter for queries. Only `projectId` is mandatory. */
export interface ScopeFilter {
	projectId: string;
	worktreeId?: string;
	branchId?: string;
	taskId?: string;
	agentId?: string;
	sessionId?: string;
}

/** The record shape scope matching operates on. */
export interface ScopedRecord {
	projectId: string;
	worktreeId?: string;
	branchId?: string;
	taskId?: string;
	agentId?: string;
	sessionId?: string;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function sha256Hex(input: string, length: number): string {
	return createHash("sha256").update(input).digest("hex").slice(0, length);
}

/** Generate a deterministic project ID from the repository root path. */
export function generateProjectId(cwd: string): string {
	return `proj_${sha256Hex(normalizePath(cwd), 16)}`;
}

/** Generate a deterministic worktree ID from the worktree path. */
export function generateWorktreeId(worktreePath: string): string {
	return `wt_${sha256Hex(normalizePath(worktreePath), 12)}`;
}

/**
 * Generate a deterministic branch ID from the git branch name.
 *
 * The hash is computed over the raw branch name (not the sanitized form) so
 * `feat/a-b` and `feat/a_b` — which sanitize identically — still receive
 * distinct IDs; the sanitized slice exists only for human readability.
 */
export function generateBranchId(branchName: string): string {
	const readable = branchName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20);
	return `br_${sha256Hex(branchName, 8)}_${readable}`;
}

/** Generate a deterministic task ID, optionally namespaced under a parent task. */
export function generateTaskId(taskName: string, parentTaskId?: string): string {
	const base = parentTaskId ? `${parentTaskId}_${taskName}` : taskName;
	return `task_${sha256Hex(base, 12)}`;
}

/** Generate a deterministic agent ID from the agent name and type. */
export function generateAgentId(agentName: string, agentType = "main"): string {
	return `agent_${sha256Hex(`${agentType}_${agentName}`, 10)}`;
}

/** Generate a unique session ID (time-ordered prefix + cryptographic suffix). */
export function generateScopedSessionId(): string {
	const timestamp = Date.now().toString(36);
	const random = randomBytes(6).toString("hex");
	return `sess_${timestamp}_${random}`;
}

/** Inputs for {@link buildScopingContext}. */
export interface BuildScopingContextParams {
	cwd: string;
	worktreePath?: string;
	branchName: string;
	taskName?: string;
	agentName?: string;
	agentType?: string;
	sessionId?: string;
}

/** Build a complete scoping context from raw repository facts. */
export function buildScopingContext(params: BuildScopingContextParams): ScopingContext {
	const context: ScopingContext = {
		projectId: generateProjectId(params.cwd),
		worktreeId: params.worktreePath ? generateWorktreeId(params.worktreePath) : "main",
		branchId: generateBranchId(params.branchName),
		sessionId: params.sessionId ?? generateScopedSessionId(),
	};
	if (params.taskName) context.taskId = generateTaskId(params.taskName);
	if (params.agentName) context.agentId = generateAgentId(params.agentName, params.agentType);
	return context;
}

/**
 * Create a scope filter for queries.
 *
 * Throws when `projectId` is absent: a filter without a project boundary
 * would silently match records across projects, which is exactly the leak
 * scoping exists to prevent.
 */
export function createScopeFilter(context: Partial<ScopingContext>): ScopeFilter {
	if (!context.projectId) {
		throw new Error("createScopeFilter requires a projectId; refusing to build a cross-project filter");
	}
	const filter: ScopeFilter = { projectId: context.projectId };
	if (context.worktreeId) filter.worktreeId = context.worktreeId;
	if (context.branchId) filter.branchId = context.branchId;
	if (context.taskId) filter.taskId = context.taskId;
	if (context.agentId) filter.agentId = context.agentId;
	if (context.sessionId) filter.sessionId = context.sessionId;
	return filter;
}

/**
 * Check whether a record matches the scope filter. Filter fields that are
 * unset act as wildcards; set fields must match exactly.
 */
export function matchesScope(record: ScopedRecord, filter: ScopeFilter): boolean {
	if (record.projectId !== filter.projectId) return false;
	if (filter.worktreeId && record.worktreeId !== filter.worktreeId) return false;
	if (filter.branchId && record.branchId !== filter.branchId) return false;
	if (filter.taskId && record.taskId !== filter.taskId) return false;
	if (filter.agentId && record.agentId !== filter.agentId) return false;
	if (filter.sessionId && record.sessionId !== filter.sessionId) return false;
	return true;
}

/** Describe a scope for logging/debugging. */
export function describeScope(context: Partial<ScopingContext>): string {
	const parts: string[] = [];
	if (context.projectId) parts.push(`project=${context.projectId}`);
	if (context.worktreeId) parts.push(`worktree=${context.worktreeId}`);
	if (context.branchId) parts.push(`branch=${context.branchId}`);
	if (context.taskId) parts.push(`task=${context.taskId}`);
	if (context.agentId) parts.push(`agent=${context.agentId}`);
	if (context.sessionId) parts.push(`session=${context.sessionId}`);
	return parts.join(", ");
}
