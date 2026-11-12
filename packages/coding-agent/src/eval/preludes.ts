import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolApproval } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import {
	approvalRestrictions,
	type ApprovalSubject,
	denyError,
	requestApproval,
	resolveApproval,
	resolveApprovalFromContext,
	type ResolvedApproval,
} from "../tools/approval";

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
	/**
	 * Render `documentation` in the eval tool description instead of linking it
	 * as an `xd://eval/<name>` topic, so the first call needs no `read`.
	 */
	inlineDocumentation?: boolean;
	/** JavaScript source installed into an ordinary JavaScript eval realm. */
	javascript: string;
	/** Python source installed into a Python eval kernel. */
	python: string;
	/** Globals owned by the snippets and removed when the prelude is replaced or disabled. */
	exports: readonly string[];
	/**
	 * Model-facing policy appended as its own system-prompt block while this
	 * prelude is advertised. Replayed by the hidden prelude notice when enabled
	 * mid-session, since the cached system prompt is not rebuilt for the toggle.
	 */
	guidance?: string;
	/** Approval tier or argument-dependent approval decision for host calls. */
	approval?: ToolApproval;
	/** Live availability predicate. Omission means enabled. */
	enabled?: () => boolean;
	/** Execute a host call outside the language VM. */
	invoke(parameters: unknown, context: EvalPreludeContext): Promise<AgentToolResult<unknown>>;
	/**
	 * One-line description of a successful host call for the eval status tree
	 * (`main.goto("https://…")`). `undefined` records nothing; omit the hook
	 * when the call has nothing worth showing. Failures are recorded by the
	 * bridge regardless.
	 */
	status?(parameters: unknown, result: AgentToolResult<unknown>): string | undefined;
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

/** First documentation line, advertised as the prelude's one-line summary; undefined when undocumented. */
export function evalPreludeSummary(definition: Pick<EvalPreludeDefinition, "documentation">): string | undefined {
	const doc = definition.documentation.trim();
	return doc ? doc.split("\n", 1)[0] : undefined;
}

/** Resolve a prelude from the session's live enabled set. Captured stale VM functions therefore fail closed. */
export function findEnabledEvalPrelude(session: ToolSession, name: string): EvalPreludeDefinition | undefined {
	const definition = session.getEvalPreludes?.().find(candidate => candidate.name === name);
	return definition?.enabled?.() === false ? undefined : definition;
}

/** Authorize one eval host call through the existing tool policy and approval UI. */
export async function approveEvalHostCall(
	subject: ApprovalSubject,
	parameters: unknown,
	context: Pick<EvalPreludeContext, "session" | "signal" | "context">,
): Promise<void> {
	context.signal?.throwIfAborted();
	const cwd = context.session.cwd;
	const resolveCurrentApproval = (toolContext = context.context): ResolvedApproval => {
		// An omitted context inherits session policy; an explicitly empty context fails closed.
		const settings = toolContext?.settings ?? context.session.settings;
		const { approvalMode: mode, userPolicies: policies } = resolveApprovalFromContext(
			toolContext ?? (settings ? { settings } : undefined),
		);
		return resolveApproval(
			subject,
			parameters,
			mode,
			policies,
			undefined,
			approvalRestrictions(settings, cwd),
			toolContext,
		);
	};
	const resolved = resolveCurrentApproval();
	if (resolved.policy === "deny") throw denyError(resolved, subject.name);
	if (resolved.policy !== "prompt") return;

	const ui = context.context?.ui;
	if (!ui || context.context?.hasUI === false) {
		const reason = resolved.reason ? `\nReason: ${resolved.reason}` : "";
		throw new Error(
			`Eval host call "${subject.name}" requires approval but no interactive UI is available.${reason}\n` +
				"Use an interactive session to approve this call.",
		);
	}
	const answer = await untilAborted(context.signal, () =>
		requestApproval(ui, subject, parameters, { reason: resolved.reason }),
	);
	if (answer === "deny") throw new Error(`Eval host call denied by user: ${subject.name}`);
	const current = resolveCurrentApproval(context.session.getToolContext?.() ?? context.context);
	if (current.policy === "deny") throw denyError(current, subject.name);
	if (
		current.policy === "prompt" &&
		(current.reason !== resolved.reason ||
			current.source !== resolved.source ||
			current.tier !== resolved.tier ||
			current.override !== resolved.override ||
			current.policyKey !== resolved.policyKey)
	) {
		throw new Error(`Eval host call "${subject.name}" authorization changed; retry the call.`);
	}
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

	await approveEvalHostCall(definition, parameters, context);
	context.signal?.throwIfAborted();
	const current = findEnabledEvalPrelude(context.session, name);
	if (!current) throw new Error(`Eval prelude "${name}" is not enabled in the current session.`);
	if (current !== definition) {
		definition = current;
		await approveEvalHostCall(definition, parameters, context);
		context.signal?.throwIfAborted();
		if (findEnabledEvalPrelude(context.session, name) !== definition) {
			throw new Error(`Eval prelude "${name}" changed while authorizing the call.`);
		}
	}
	return definition.invoke(parameters, context);
}
