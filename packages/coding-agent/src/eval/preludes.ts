import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolApproval } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { type ApprovalMode, denyError, formatApprovalPrompt, resolveApproval } from "../tools/approval";

/** Host context supplied when an eval prelude calls back out of its language VM. */
export interface EvalPreludeContext {
	/** Live owning session; authorization is always resolved against its current preludes. */
	session: ToolSession;
	/** Tool-call-shaped identifier assigned to this individual host invocation. */
	toolCallId: string;
	/** Cancellation signal for the active eval cell. */
	signal?: AbortSignal;
	/** Ordinary agent tool context used for settings, UI, and provider metadata. */
	context?: AgentToolContext;
	/** Progress receiver shared with the active eval call. */
	onUpdate?: AgentToolUpdateCallback<unknown>;
}

/**
 * A language prelude whose snippets run in eval VMs while its privileged handler
 * remains in the host process. Prelude definitions are capabilities, not tools:
 * they have no parameter schema, renderer, label, or load mode and never enter a
 * model tool inventory.
 */
export interface EvalPreludeDefinition {
	/** Stable bridge name and registration key. */
	name: string;
	/** Static Markdown documentation shown only while this prelude is enabled. */
	documentation: string;
	/** JavaScript source installed into an ordinary JavaScript eval realm. */
	javascript: string;
	/** Python source installed into a Python eval kernel. */
	python: string;
	/** Globals owned by the snippets and removed when the prelude is replaced or disabled. */
	exports: readonly string[];
	/** Optional declarations appended to code-mode TypeScript context while enabled. */
	codeModeDeclarations?: string;
	/** Approval tier or argument-dependent approval decision for host calls. */
	approval?: ToolApproval;
	/** Live availability predicate. Omission means enabled. */
	enabled?: () => boolean;
	/** Execute a host call outside the language VM. */
	invoke(parameters: unknown, context: EvalPreludeContext): Promise<AgentToolResult<unknown>>;
}

/**
 * Resolve enabled candidates without consulting a session getter (and therefore
 * without recursion). Later definitions replace earlier definitions of the same
 * name, matching extension tool registration precedence.
 */
export function getEnabledEvalPreludes(definitions: readonly EvalPreludeDefinition[]): EvalPreludeDefinition[] {
	const enabledByName = new Map<string, EvalPreludeDefinition>();
	for (const definition of definitions) {
		if (definition.enabled?.() !== false) enabledByName.set(definition.name, definition);
	}
	return Array.from(enabledByName.values());
}

/** Resolve a prelude from the session's live enabled set. Captured stale VM functions therefore fail closed. */
export function findEnabledEvalPrelude(session: ToolSession, name: string): EvalPreludeDefinition | undefined {
	const definition = session.getEvalPreludes?.().find(candidate => candidate.name === name);
	return definition?.enabled?.() === false ? undefined : definition;
}

function configuredApprovalMode(context: AgentToolContext | undefined): ApprovalMode {
	if (context?.autoApprove === true) return "yolo";
	const mode = context?.settings?.get("tools.approvalMode");
	if (mode === "always-ask" || mode === "write" || mode === "yolo") return mode;
	return "yolo";
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function approvePreludeInvocation(
	definition: EvalPreludeDefinition,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<void> {
	context.signal?.throwIfAborted();
	const mode = configuredApprovalMode(context.context);
	const configuredPolicies = context.context?.settings?.get("tools.approval");
	const policies = isUnknownRecord(configuredPolicies) ? configuredPolicies : {};
	const subject: { name: string; approval?: ToolApproval } = { name: definition.name };
	if (definition.approval !== undefined) subject.approval = definition.approval;
	const resolved = resolveApproval(subject, parameters, mode, policies);
	if (resolved.policy === "deny") throw denyError(resolved, definition.name);
	if (resolved.policy !== "prompt") return;

	const ui = context.context?.ui;
	if (!ui || context.context?.hasUI === false) {
		throw new Error(
			`Eval prelude "${definition.name}" requires approval but no interactive UI is available.\n` +
				`Set tools.approval.${definition.name}: allow or use an interactive UI to approve the call.`,
		);
	}
	const choice = await untilAborted(context.signal, () =>
		ui.select(formatApprovalPrompt(subject, parameters, resolved.reason), ["Approve", "Deny"]),
	);
	if (choice !== "Approve") throw new Error(`Eval prelude call denied by user: ${definition.name}`);
}

/**
 * Invoke a prelude through the live session registry. Authorization is resolved
 * before the handler runs and repeated when an awaited approval raced with a
 * replacement, so a disabled or replaced captured function cannot retain host
 * access under stale policy.
 */
export async function invokeEvalPrelude(
	name: string,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	context.signal?.throwIfAborted();
	let definition = findEnabledEvalPrelude(context.session, name);
	if (!definition) throw new Error(`Eval prelude "${name}" is not enabled in the current session.`);

	await approvePreludeInvocation(definition, parameters, context);
	context.signal?.throwIfAborted();
	const current = findEnabledEvalPrelude(context.session, name);
	if (!current) throw new Error(`Eval prelude "${name}" is not enabled in the current session.`);
	if (current !== definition) {
		definition = current;
		await approvePreludeInvocation(definition, parameters, context);
		context.signal?.throwIfAborted();
		if (findEnabledEvalPrelude(context.session, name) !== definition) {
			throw new Error(`Eval prelude "${name}" changed while authorizing the call.`);
		}
	}
	return definition.invoke(parameters, context);
}
