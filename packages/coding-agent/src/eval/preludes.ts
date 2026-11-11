import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolApproval } from "@oh-my-pi/pi-agent-core";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import firstCallGuidePrompt from "../prompts/tools/eval-prelude-first-call.md" with { type: "text" };
import {
	approvalRestrictions,
	denyError,
	requestApproval,
	resolveApproval,
	resolveApprovalFromContext,
} from "../tools/approval";
import { isBareBridgeResult } from "./tool-result";

/** Host context supplied when an eval prelude calls back out of its language VM. */
export interface EvalPreludeContext {
	/** Live owning session; authorization is always resolved against its current preludes. */
	session: ToolSession;
	/** Tool-call-shaped identifier assigned to this individual host invocation. */
	toolCallId: string;
	/** Cancellation signal for the active eval cell. */
	signal?: AbortSignal;
	/**
	 * The eval cell's `timeout` in ms, which the cell's watchdog suspends while this call runs; a call that sets
	 * no budget of its own takes this one. 0 when the cell has no timeout; absent when the call comes from no cell.
	 */
	cellTimeoutMs?: number;
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
	/**
	 * Short guide appended to the printed output of this prelude's first call
	 * in a conversation that returns one (a thrown call or a bare-string result
	 * leaves it for the next), so the model can start without reading the
	 * `xd://eval/<name>` topic (which keeps `documentation`) while the always-on
	 * tool description keeps one line. Delivered once per conversation.
	 */
	firstCallDocumentation?: string;
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

async function approvePreludeInvocation(
	definition: EvalPreludeDefinition,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<void> {
	context.signal?.throwIfAborted();
	// Fourth execute-time site: same helper as wrapper/cursor/mcp so a missing
	// context cannot silently yolo. Empty `context.context` fail-closes;
	// omitting it inherits the live session settings (schema default yolo).
	const settings = context.context?.settings ?? context.session.settings;
	const { approvalMode: mode, userPolicies: policies } = resolveApprovalFromContext(
		context.context ?? (settings ? { settings } : undefined),
	);
	const subject: { name: string; approval?: ToolApproval } = { name: definition.name };
	if (definition.approval !== undefined) subject.approval = definition.approval;
	// A prelude names no path of its own, so a restricted folder matches it by the session's directory.
	const resolved = resolveApproval(
		subject,
		parameters,
		mode,
		policies,
		undefined,
		approvalRestrictions(settings, context.session.cwd),
	);
	if (resolved.policy === "deny") throw denyError(resolved, definition.name);
	if (resolved.policy !== "prompt") return;

	const ui = context.context?.ui;
	if (!ui || context.context?.hasUI === false) {
		throw new Error(
			`Eval prelude "${definition.name}" requires approval but no interactive UI is available.\n` +
				`Set tools.approval.${definition.name}: allow or use an interactive UI to approve the call.`,
		);
	}
	const answer = await untilAborted(context.signal, () =>
		requestApproval(ui, subject, parameters, { reason: resolved.reason }),
	);
	if (answer === "deny") throw new Error(`Eval prelude call denied by user: ${definition.name}`);
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
	const result = await definition.invoke(parameters, context);
	// The bridge hands a result with no details or images to the VM as a bare string, which the facades
	// return rather than print, so the guide waits for a call whose text reaches the cell output.
	if (isBareBridgeResult(result)) return result;
	const guide = takeFirstCallGuide(definition, context.session);
	if (!guide) return result;
	const lead = result.content.some(part => part.type === "text" && part.text.length > 0) ? "\n\n" : "";
	return { ...result, content: [...result.content, { type: "text", text: `${lead}${guide}\n` }] };
}

/** Keep first-call control text outside transforms that shorten ordinary cell output. */
export async function preserveEvalGuides<T extends AgentToolResult>(
	result: T,
	process: (result: T) => Promise<T>,
): Promise<T> {
	const guides: string[] = [];
	const content = result.content.map(part => {
		if (part.type !== "text") return part;
		const text = part.text.replace(/(?:^|\n)<eval-guide name="[^"]+">[\s\S]*?<\/eval-guide>(?:\n|$)/g, guide => {
			guides.push(guide.trim());
			return "\n";
		});
		return text === part.text ? part : { ...part, text };
	});
	const processed = await process(guides.length > 0 ? { ...result, content } : result);
	return guides.length > 0
		? { ...processed, content: [...processed.content, { type: "text", text: guides.join("\n\n") }] }
		: processed;
}

/** Prelude names whose first-call guide each tool session has delivered, for its current conversation and context. */
const firstCallDeliveries = new WeakMap<
	ToolSession,
	{ conversation: string | null; revision: number; preludes: Set<string> }
>();

/** Structural marker shared with the static first-call prompt, independent of its prose. */
const FIRST_CALL_GUIDE_PATTERN = /(?:^|\n)<eval-guide name="([^"]+)">/g;

/**
 * The prelude's first-call guide, headed, if this is its first call in the
 * session's conversation; marks it delivered. The guide rides the call's
 * output, so the cached prompt prefix is never edited. Sessions without
 * `read` already carry every topic in full in the eval description.
 * What counts as delivered is re-read from the context on the first call and
 * whenever the context lost or replaced messages since, so a compaction or
 * rewind that drops the guide sends it again and a resumed session whose
 * history holds it does not.
 */
function takeFirstCallGuide(definition: EvalPreludeDefinition, session: ToolSession): string | undefined {
	const guide = definition.firstCallDocumentation?.trim();
	if (!guide || session.isToolActive?.("read") === false) return undefined;
	const conversation = session.getSessionId?.() ?? null;
	const revision = session.getContextRevision?.() ?? 0;
	let delivered = firstCallDeliveries.get(session);
	if (!delivered || delivered.conversation !== conversation || delivered.revision !== revision) {
		delivered = { conversation, revision, preludes: guidesInContext(session) };
		firstCallDeliveries.set(session, delivered);
	}
	if (delivered.preludes.has(definition.name)) return undefined;
	delivered.preludes.add(definition.name);
	return prompt.render(firstCallGuidePrompt, { name: definition.name, guide }).trimEnd();
}

/** Names of the preludes whose first-call guide a tool result in the session's context still carries. */
function guidesInContext(session: ToolSession): Set<string> {
	const names = new Set<string>();
	for (const message of session.getContextMessages?.() ?? []) {
		if (message.role !== "toolResult") continue;
		for (const part of message.content) {
			if (part.type !== "text") continue;
			for (const [, name] of part.text.matchAll(FIRST_CALL_GUIDE_PATTERN)) names.add(name);
		}
	}
	return names;
}
