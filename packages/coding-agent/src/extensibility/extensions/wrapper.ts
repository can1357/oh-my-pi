/**
 * Tool wrappers for extensions.
 */
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	isNonBlankContext,
	type ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import type { ComputerSafetyCheck, ImageContent, Static, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import { AdmittedSignal } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { prompt, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import nativeDelegationTemplate from "../../prompts/tools/native-delegation.md" with { type: "text" };
import {
	approvalRestrictions,
	denyError,
	recordApprovalGrant,
	requestApproval,
	resolveApproval,
	resolveApprovalFromContext,
	sessionApprovalScope,
	truncateForPrompt,
} from "../../tools/approval";
import { getApprovalGrants } from "../../tools/approval-cache";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { withFileMutationSession } from "../../tools/file-write-fallback";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import { pinInputScope, type ToolRendererScope } from "@oh-my-pi/pi-tui/tools/renderer-scope";
import { copyHostData, copyToolResult, copyToolView, registeredToolOwner } from "./boundary-data";
import { providerCallGate } from "./callback-ownership";
import { handTheme } from "./context-surfaces";
import type { ExtensionRunner } from "./runner";
import type { ExtensionAgentIdentity, ExtensionCallbackOwner, RegisteredTool, ToolCallEventResult } from "./types";

/**
 * Second `renderCall` argument that satisfies both the omp and the upstream-pi
 * renderer contracts.
 *
 * omp invokes renderers as `renderCall(args, options, theme)` (see
 * `packages/tui/src/tools/renderer.ts`), while pi-era renderers — including
 * every third-party plugin written against pi's published example — are
 * declared `renderCall(args, theme, context)`. Both shapes take three
 * parameters, so arity cannot discriminate them. The returned value carries
 * both instead: own keys stay the render options, every other property
 * resolves against the live theme. `Theme` keeps its state in `#private`
 * fields, so delegated methods are bound to the theme instance rather than to
 * the proxy.
 */
function renderOptionsWithTheme<T extends object>(options: T, theme: Theme): T & Theme {
	const delegates = new Map<PropertyKey, unknown>();
	return new Proxy(options, {
		get(target, prop, receiver) {
			if (Object.hasOwn(target, prop)) return Reflect.get(target, prop, receiver);
			const delegate = delegates.get(prop);
			if (delegate !== undefined) return delegate;
			const value = Reflect.get(theme, prop, theme);
			if (typeof value !== "function") return value;
			const bound = value.bind(theme);
			delegates.set(prop, bound);
			return bound;
		},
	}) as T & Theme;
}

/**
 * The scope a tool another owner registered draws in, as a host mounting what it returns uses it
 * (`SafeToolRendererComponent`): live while both the executing runner's scope and the tool's owner
 * are, and running in the owner's admission inside the runner's. Pinned, it is the pair of the
 * runner's current session and the owner's (`forSession`), so a component the tool returned in one
 * of its owner's sessions draws nothing once that session has gone, whatever the runner serves.
 */
function ownedRendererScope(runnerScope: ToolRendererScope, owner: ExtensionCallbackOwner): ToolRendererScope {
	const pair = (outer: ToolRendererScope, inner: ExtensionCallbackOwner): ToolRendererScope => ({
		get live() {
			return outer.live && !inner.isRetired;
		},
		run<T>(call: () => T): T {
			if (inner.isRetired) throw new Error("Extension session retired; its renderers are no longer callable");
			return outer.run(() => inner.runOwned(call));
		},
	});
	const scope = pair(runnerScope, owner);
	return Object.assign(scope, {
		pin: () => pair(pinInputScope(runnerScope), owner.forSession?.() ?? owner),
	});
}

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool<any, any, any> {
	declare name: string;
	get description(): string {
		const description = this.registeredTool.definition.description;
		const guidance = this.runner.getNativeDelegationGuidance(this.name);
		return guidance
			? prompt.render(nativeDelegationTemplate, { description, name: this.name, guidance })
			: description;
	}
	declare parameters: any;
	declare label: string;
	declare strict: boolean;

	renderCall?: (args: any, options: any, theme: any) => any;
	renderResult?: (result: any, options: any, theme: any, args?: any) => any;
	describeCall?: RegisteredTool["definition"]["describeCall"];
	describeResult?: RegisteredTool["definition"]["describeResult"];
	/** The scope a host runs the components this tool's renderers return in: the session's
	 *  admission, which the TUI cannot import (`@oh-my-pi/pi-tui/tools/renderer-scope`). */
	readonly rendererScope: ToolRendererScope;
	readonly loadMode: ToolLoadMode;

	/**
	 * The renderers are the boundary too, in both directions. Each runs inside this session's
	 * admission ({@link ExtensionRunner.runScoped}) and not at all once the session has gone, on
	 * copies of what the host hands it: the call's arguments and render options, the result. What
	 * a describe hook answers is data and is copied there (`copyToolView`). What a render hook
	 * answers is a component, the extension's live code: it is handed back as it is, and every
	 * host that mounts it runs it through {@link rendererScope} (`SafeToolRendererComponent`).
	 */
	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);
		const { definition, extensionPath } = registeredTool;
		const name = definition.name;
		this.loadMode = defaultLoadModeForToolName(name, definition.loadMode);
		// A tool belongs to whoever registered it — a session, or the runtime whose factory loaded
		// it — and this runner may be another runtime's, executing it for its own session. What the
		// tool does is its owner's work, then: run, cancelled and drawn in its owner's admission,
		// inside this runner's, so nothing of it outlives either, and its abort listener and the
		// components it returns answer to its owner's lifetime, not to the executing session's.
		const owner = registeredToolOwner(definition);
		this.#owner = owner !== undefined && owner !== runner.callbackOwner ? owner : undefined;
		this.rendererScope = this.#owner ? ownedRendererScope(runner.rendererScope, this.#owner) : runner.rendererScope;
		const scoped = <T>(call: () => T): T | undefined => this.#scoped(call);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		const { renderCall, renderResult, describeCall, describeResult } = definition;
		if (renderCall) {
			this.renderCall = (args: any, options: any, theme: any) =>
				scoped(() =>
					renderCall(
						copyHostData(args),
						renderOptionsWithTheme(copyHostData(options), handTheme(theme)),
						handTheme(theme),
					),
				);
		}
		if (renderResult) {
			this.renderResult = (result: any, options: any, theme: any, args?: any) =>
				scoped(() =>
					renderResult(
						copyHostData(result),
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						handTheme(theme),
						copyHostData(args),
					),
				);
		}
		if (describeCall) {
			this.describeCall = (args, options) =>
				scoped(() =>
					copyToolView(
						describeCall(copyHostData(args), copyHostData(options)),
						name,
						extensionPath,
						"describeCall() view",
					),
				);
		}
		if (describeResult) {
			this.describeResult = (result, options, args) =>
				scoped(() =>
					copyToolView(
						describeResult(copyHostData(result), copyHostData(options), copyHostData(args)),
						name,
						extensionPath,
						"describeResult() view",
					),
				);
		}
	}

	/** The tool's owner when it is not this runner's own runtime ({@link registeredToolOwner}). */
	readonly #owner: ExtensionCallbackOwner | undefined;

	/** Runs `call` in this runner's admission and, for a tool another owner registered, in that
	 *  owner's inside it; nothing once either has gone. */
	#scoped<T>(call: () => T): T | undefined {
		const owner = this.#owner;
		if (!owner) return this.runner.runScoped(call);
		return this.runner.runScoped(() => (owner.isRetired ? undefined : owner.runOwned(call)));
	}

	/**
	 * Run the extension's `execute` — the boundary between an extension tool and the host. It runs
	 * inside the admission {@link ExtensionToolWrapper} opens around every tool, so the copies taken
	 * here are taken inside it: `execute` is handed a copy of the params (the host's are the model's
	 * call, persisted and handed to `tool_result` afterwards), and the partial results it streams
	 * through `onUpdate` and the result it resolves with are copied by their schema before the host
	 * reads them. Its signal is the one this admission aborts (`AdmittedSignal`), with the caller's
	 * reason and in the same turn, and it stops following the caller's when `execute` settles: a
	 * listener the tool installs runs as the session's work and never after the call. Built-in,
	 * MCP-manager and RPC host tools reach the wrapper without this adapter; their results are the
	 * host's data and are not copied.
	 */
	async execute(
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
		context?: AgentToolContext,
	) {
		const { definition, extensionPath } = this.registeredTool;
		const name = definition.name;
		const owner = this.#owner;
		const call = async () => {
			// Admitted inside the owner's admission, so the abort the caller's signal carries in runs
			// as the owner's work: a listener the tool installs answers to the session that
			// registered it, never to the one executing it or to the session after.
			const handedSignal = new AdmittedSignal(owner ? providerCallGate(owner) : this.runner.callbackGate, signal);
			try {
				// Bind the extension context to this tool's own name so `ctx.invokeTool` delegates to the
				// native built-in of the same name (present only when this tool re-registers a built-in).
				// The wrapper's own context, abort signal, and progress callback are inherited by the
				// delegated call, so a bare `ctx.invokeTool(params)` keeps the caller's
				// `toolCall`/provider metadata (write/edit LSP batching, computer safety acknowledgement),
				// stops when the outer call is aborted, and still streams native progress. Those are host
				// calls, so they follow the caller's own signal.
				const result = await definition.execute(
					toolCallId,
					copyHostData(params),
					handedSignal.admit(),
					onUpdate &&
						(partial => onUpdate(copyToolResult(partial, name, extensionPath, "onUpdate() partial result"))),
					this.runner.createContext(undefined, {
						toolName: name,
						context,
						signal,
						onUpdate,
					}),
				);
				return copyToolResult(result, name, extensionPath, "execute() result");
			} finally {
				handedSignal.release();
			}
		};
		// An owner that has gone refuses through the definition itself, which says why.
		return owner && !owner.isRetired ? await owner.runOwned(call) : await call();
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

const LOOP_DISPATCH_CONTEXT = Symbol("omp.loop-dispatch");
type LoopAwareToolContext = AgentToolContext & { [LOOP_DISPATCH_CONTEXT]?: true };

function computerSafetyChecks(context: AgentToolContext | undefined): ComputerSafetyCheck[] {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? metadata.pendingSafetyChecks : [];
}

function approvalArgs(params: unknown, context: AgentToolContext | undefined): unknown {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? { actions: metadata.actions } : params;
}

function toolEventArgs(params: unknown, context: AgentToolContext | undefined): Record<string, unknown> {
	const metadata = context?.toolCall?.providerMetadata;
	if (metadata?.type === "computer") {
		return {
			actions: metadata.actions,
			pendingSafetyChecks: metadata.pendingSafetyChecks,
		};
	}
	return params as Record<string, unknown>;
}

function approvalData(value: string): string {
	const sanitized = sanitizeText(value)
		.replace(/[\r\n\t]+/g, " ")
		.trim();
	const truncated = truncateForPrompt(sanitized, 500);
	return truncated.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

function safetyCheckLines(checks: readonly ComputerSafetyCheck[]): string[] {
	return checks.map((check, index) => {
		const value = check.message || check.code || check.id;
		return `${index + 1}. ${approvalData(value)}`;
	});
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 *
 * `agent` overrides the runner's own `ctx.agent` for those events when the tool
 * runs on behalf of a different agent than the runner's session — the advisor's
 * toolset shares the primary session's runner (for approval enforcement) but
 * must not be reported as the primary agent.
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown> implements AgentTool<
	TParameters,
	TDetails
> {
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;
	readonly #agent: ExtensionAgentIdentity | undefined;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
		agent?: ExtensionAgentIdentity,
	) {
		this.#agent = agent;
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		// The agent loop emits `tool_call` at arg-prep time (session
		// `beforeToolCall` wiring) so a handler revision lands before concurrency
		// scheduling and `tool_execution_start`. Consume the marker
		// unconditionally so it cannot go stale; emit here only for dispatches
		// the loop never saw — nested xd:// device dispatches and direct
		// (non-loop) execution such as Cursor exec handlers.
		const inheritedLoopDispatch = (context as LoopAwareToolContext | undefined)?.[LOOP_DISPATCH_CONTEXT] === true;
		const loopDispatchedToolCall =
			(this.runner.consumeLoopToolCall?.(toolCallId, this.tool.name) ?? false) || inheritedLoopDispatch;
		if (loopDispatchedToolCall && context && !inheritedLoopDispatch) {
			(context as LoopAwareToolContext)[LOOP_DISPATCH_CONTEXT] = true;
		}
		const loopEmittedToolCall = this.runner.consumeToolCallEmitted(toolCallId, this.tool.name);
		// Resolve approval settings up front. A `deny` on the original input short-circuits before the
		// runner is touched — an already-denied tool never emits `tool_call` — while the full gate below
		// re-resolves against the (possibly revised) input so a handler cannot rewrite into a denied or
		// newly prompt-gated command and have it run unapproved.
		const approvalSettings = context?.settings ?? this.runner.sessionSettings;
		const { approvalMode, userPolicies } = resolveApprovalFromContext(
			context ?? (approvalSettings ? { settings: approvalSettings } : undefined),
		);
		// `always-ask-cached` grants for this conversation, shared by the pre-check, the full gate,
		// and the record after an approval.
		const approvalGrants =
			approvalMode === "always-ask-cached"
				? getApprovalGrants(approvalSettings?.getAgentDir(), this.runner.sessionId)
				: undefined;
		const restrictions = approvalRestrictions(approvalSettings, this.runner.cwd);
		const preResolved = resolveApproval(
			this.tool,
			approvalArgs(params, context),
			approvalMode,
			userPolicies,
			approvalGrants,
			restrictions,
		);
		if (preResolved.policy === "deny") {
			throw denyError(preResolved, this.tool.name);
		}

		// 1. Emit tool_call event first - extensions can block execution or revise the input the tool
		// runs with. Doing this BEFORE the approval gate means approval (below) resolves against the
		// input that actually executes, closing the "approve one thing, run another" gap: the prompt
		// text, policy resolution, and provider safety checks all see `effectiveParams`.
		// Passive context collected here is forwarded only once the call has run
		// and produced a non-error result: a block, deny, user reject, fail-closed
		// safety refusal, or failed execution never injects instructions. This
		// matches the loop's rule for context prepared at arg-prep time.
		let pendingAdditionalContext: string | undefined;
		let effectiveParams = params;
		const cancelPreflight = (): void => {
			if (!loopDispatchedToolCall) this.runner.cancelToolCallPreflight?.(toolCallId);
		};
		if (!loopEmittedToolCall && this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall(
					{
						type: "tool_call",
						toolName: this.tool.name,
						toolCallId,
						input: normalizeToolEventInput(
							this.tool.name,
							resolveToolEventInput(this.tool, toolEventArgs(params, context)),
						),
					},
					signal,
					this.#agent,
				)) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by an extension";
					throw new Error(reason);
				}
				if (isNonBlankContext(callResult?.additionalContext)) {
					pendingAdditionalContext = callResult.additionalContext;
				}
				// A non-blocking handler may replace the execution input. The returned object is the raw
				// input passed to `execute` (handler-owned; not re-normalized). Skipped for `computer`
				// tool calls, whose event input is a synthetic {actions,pendingSafetyChecks} view
				// (see toolEventArgs) rather than the real execution params.
				if (callResult?.input !== undefined && context?.toolCall?.providerMetadata?.type !== "computer") {
					effectiveParams = callResult.input as typeof params;
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}
		if (!loopDispatchedToolCall) {
			const preflight = await this.runner.runToolCallPreflightBefore?.(
				toolCallId,
				this.tool,
				effectiveParams,
				context,
			);
			if (preflight?.block) {
				throw new Error(preflight.reason || "Tool execution was blocked by a preflight rule");
			}
		}

		// 2. Full approval gate against the (possibly revised) input that will actually run — resolves
		// policy and prompts on `effectiveParams`, so the user approves exactly what executes. A revised
		// input that newly resolves to `deny` is caught here even though the original passed the
		// short-circuit above.
		const resolvedArgs = approvalArgs(effectiveParams, context);
		const resolved = resolveApproval(
			this.tool,
			resolvedArgs,
			approvalMode,
			userPolicies,
			approvalGrants,
			restrictions,
		);
		context?.xdevTierResolved?.(resolved.tier);
		if (resolved.policy === "deny") {
			cancelPreflight();
			throw denyError(resolved, this.tool.name);
		}
		const pendingSafetyChecks = computerSafetyChecks(context);
		// Outer approvals only cover the original input. `xd://` approval skips
		// tier-only prompts, and an explicit prompt under the policy key the outer
		// gate already asked about, while the same object flows through; ACP
		// approval also satisfies explicit prompts, but compares against a deep
		// snapshot because handlers can mutate the original argument object in
		// place. Denies were enforced above, and provider safety checks remain
		// independently required.
		const policyKey = resolved.policyKey ?? this.tool.name;
		const explicitPrompt =
			resolved.override || (Object.hasOwn(userPolicies, policyKey) && policyKey !== context?.xdevPolicyKey);
		const xdevBypass = context?.xdevPolicyKey !== undefined && effectiveParams === params;
		const acpBypass =
			context !== undefined &&
			Object.hasOwn(context, "acpApprovedArgs") &&
			Bun.deepEquals(effectiveParams, context.acpApprovedArgs);
		// Only a prompt `always-ask-cached` itself raised can be remembered by target; provider safety
		// checks are per-call, so they never offer a grant of any kind.
		const grantable =
			approvalGrants !== undefined &&
			resolved.policy === "prompt" &&
			resolved.source === "mode" &&
			pendingSafetyChecks.length === 0;
		const cacheTargets = grantable ? (this.tool.approvalCacheTargets?.(resolvedArgs)?.length ?? 0) > 0 : false;
		// A prompt the approval mode raised can be approved for the rest of the session — unless the call
		// can be remembered by target instead, which keeps the grant to what it touches.
		const sessionScope =
			pendingSafetyChecks.length === 0 && !cacheTargets ? sessionApprovalScope(resolved, this.tool.name) : undefined;
		const sessionApproved = sessionScope !== undefined && this.runner.hasSessionApproval(sessionScope.key);
		const approvalCheck = {
			required:
				pendingSafetyChecks.length > 0 ||
				(resolved.policy === "prompt" && !acpBypass && !sessionApproved && (explicitPrompt || !xdevBypass)),
			reason: resolved.reason,
		};

		if (approvalCheck.required) {
			const scheduledCall = context?.toolCall?.toolCalls[context.toolCall.index];
			if (
				scheduledCall?.id === toolCallId &&
				(scheduledCall.name === this.tool.name || scheduledCall.name === this.tool.customWireName)
			) {
				await untilAborted(signal, () => this.runner.waitForToolApprovalPreview(toolCallId));
			}

			const hasApprovalHandlers =
				this.runner.hasHandlers("tool_approval_requested") || this.runner.hasHandlers("tool_approval_resolved");
			const sessionId = context?.sessionManager?.getSessionId() ?? "";
			if (hasApprovalHandlers) {
				await this.runner.emit({
					type: "tool_approval_requested",
					sessionId,
					toolName: this.tool.name,
					toolCallId,
					...(approvalCheck.reason ? { reason: approvalCheck.reason } : {}),
					approvalMode,
				});
			}

			const emitApprovalResolved = async (approved: boolean, reason?: string) => {
				if (!hasApprovalHandlers) return;
				await this.runner.emit({
					type: "tool_approval_resolved",
					sessionId,
					toolName: this.tool.name,
					toolCallId,
					approved,
					...(reason ? { reason } : {}),
				});
			};

			// Provider safety checks fail closed without an interactive prompt. Unlike
			// ordinary tier approval, no setting or yolo mode may bypass this gate.
			if (!this.runner.hasUI()) {
				const reason = "no interactive UI available";
				await emitApprovalResolved(false, reason);
				cancelPreflight();
				if (pendingSafetyChecks.length > 0) {
					throw new Error(
						`Tool "${this.tool.name}" has pending provider safety checks but no interactive UI is available.`,
					);
				}
				if (resolved.source === "restriction") {
					throw new Error(
						`Tool "${this.tool.name}" requires approval but no interactive UI available.\n` +
							`Reason: ${resolved.reason}\n` +
							`A restricted folder (tools.restrictedFolders) asks in every approval mode.`,
					);
				}
				throw new Error(
					`Tool "${this.tool.name}" requires approval but no interactive UI available.\n` +
						`Options:\n` +
						`  1. Set tools.approvalMode: yolo in /settings\n` +
						`  2. Add tools.approval.${this.tool.name}: allow to config\n` +
						`  3. Use an interactive UI to approve the tool call`,
				);
			}

			const uiContext = this.runner.getUIContext();
			const safetyAppendix =
				pendingSafetyChecks.length > 0 ? ["Provider safety checks:", ...safetyCheckLines(pendingSafetyChecks)] : [];
			let approved: boolean;
			try {
				const answer = await requestApproval(uiContext, this.tool, resolvedArgs, {
					reason: approvalCheck.reason,
					appendix: safetyAppendix,
					sessionSubject: sessionScope?.subject,
					grants: cacheTargets,
				});
				approved = answer !== "deny";
				if (answer === "session" && sessionScope) this.runner.grantSessionApproval(sessionScope.key);
				if (typeof answer === "object" && approvalGrants) {
					recordApprovalGrant(this.tool, resolvedArgs, approvalGrants, resolved.tier, answer);
				}
			} catch (err) {
				await emitApprovalResolved(false, err instanceof Error ? err.message : "approval aborted");
				cancelPreflight();
				throw err;
			}
			await emitApprovalResolved(approved, approved ? undefined : "denied by user");
			if (!approved) {
				cancelPreflight();
				throw new Error(`Tool call denied by user: ${this.tool.name}`);
			}
			if (pendingSafetyChecks.length > 0) {
				if (!context) {
					cancelPreflight();
					throw new Error("Provider safety approval context is unavailable");
				}
				context.providerSafetyApproved = true;
			}
		}

		// Execute the actual tool
		let result: AgentToolResult<TDetails, TParameters>;
		let executionError: Error | undefined;

		try {
			// Name the owning session for process-wide file-mutation fallbacks and
			// expose its settings to registered tools and any fallback handlers they
			// trigger. `sdk.ts` wraps the whole tool registry with this class whenever
			// a runner exists.
			const executed = await this.runner.runScoped(() =>
				withFileMutationSession(this.runner.sessionId, () =>
					this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context),
				),
			);
			// `runScoped` refuses once the session is retired: its extensions must not run after
			// disposal, and a tool call arriving then has no session left to act on.
			if (executed === undefined) throw new Error("Session disposed; extension tool was not executed");
			result = executed;
		} catch (err) {
			executionError = err instanceof Error ? err : new Error(String(err));
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}
		if (!loopDispatchedToolCall) {
			const postflight = await this.runner.runToolCallPreflightAfter?.(toolCallId, result, context);
			if (postflight) result = postflight as AgentToolResult<TDetails, TParameters>;
		}

		// Emit tool_result event - extensions can modify the result and error status
		if (this.runner.hasHandlers("tool_result")) {
			const resultResult = await this.runner.emitToolResult(
				{
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, toolEventArgs(effectiveParams, context)),
					),
					content: result.content,
					details: result.details,
					isError: !!executionError || result.isError === true,
				},
				this.#agent,
			);

			// Handler context reports into this call's sink like tool-authored
			// context: it is delivered even for a failed call (the handler saw
			// `isError`), and precedes any pending `tool_call` context.
			if (resultResult?.additionalContext !== undefined) {
				context?.addAdditionalContext?.(resultResult.additionalContext);
			}

			// `content` is present only when a handler modified the result.
			if (resultResult?.content !== undefined) {
				const modifiedContent: (TextContent | ImageContent)[] = resultResult.content;
				const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

				// Effective error state: an explicit handler override wins; otherwise the
				// original execution outcome stands. This lets a handler rewrite a failed
				// call's model-visible content/details while keeping it an error, flip a
				// failure to success, or flag a success as an error.
				const effectiveError = resultResult.isError ?? !!executionError;
				if (!effectiveError && pendingAdditionalContext !== undefined) {
					context?.addAdditionalContext?.(pendingAdditionalContext);
				}

				// Return the (possibly modified) result carrying the error flag rather than
				// rethrowing the original exception. The agent loop honors
				// `AgentToolResult.isError` and surfaces it as a tool error on the wire (see
				// `coerceToolResult` in agent-loop), so replacement failure content reaches
				// the model while the call remains an error — the original exception text is
				// no longer forced through, which previously discarded the replacement.
				return {
					content: modifiedContent,
					details: modifiedDetails,
					providerMetadata: result.providerMetadata,
					...(effectiveError ? { isError: true } : {}),
				};
			}
		}

		// No extension modification
		if (executionError) {
			throw executionError;
		}
		if (result.isError !== true && pendingAdditionalContext !== undefined) {
			context?.addAdditionalContext?.(pendingAdditionalContext);
		}
		return result;
	}
}
