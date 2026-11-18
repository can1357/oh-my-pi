import type {
	SpeculativeAuthorization,
	SpeculativeExecutionHost,
	SpeculativeLaunchContext,
	SpeculativeOperationContext,
	SpeculativeToolExecutionConfig,
	SpeculativeToolReference,
} from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import { cfgTaskSpeculativeLaunch } from "../task/settings";
import type { ToolSession } from "../tools";
import { approvalRestrictions, resolveApproval } from "../tools/approval";
import { getApprovalGrants } from "../tools/approval-cache";
import {
	cfgToolInterceptorEnabled,
	cfgToolInterceptorRules,
	cfgToolsApproval,
	cfgToolsApprovalMode,
} from "../tools/settings";
import { hasApplicableToolInterceptorRules } from "../tools/tool-interceptor";


export interface SpeculationLifecycle {
	hasHandlers(eventType: string): boolean;
}

function hasLifecycleHandlers(runner: SpeculationLifecycle): boolean {
	return (
		runner.hasHandlers("tool_call") ||
		runner.hasHandlers("tool_result") ||
		runner.hasHandlers("tool_approval_requested") ||
		runner.hasHandlers("tool_approval_resolved")
	);
}

/**
 * Session-scoped policy boundary for speculative stream-session launches.
 *
 * Ordinary approval and extension lifecycle hooks remain authoritative. Every
 * speculative tool operation (reads, writes, completions, remote GETs) fails
 * closed; only stream-session launches such as `task` subagents are allowed.
 */
export class CodingAgentSpeculativeExecutionHost implements SpeculativeExecutionHost {
	constructor(
		private readonly settings: Settings,
		private readonly toolSession: ToolSession,
		private readonly extensionRunner: SpeculationLifecycle,
	) {}

	authorize(_context: SpeculativeOperationContext): SpeculativeAuthorization {
		return { allowed: false, reason: "tool and effect pair is not supported for speculative execution" };
	}

	/**
	 * Stream-session launches (e.g. `task` subagents started from streamed
	 * items) pass the lifecycle and approval gate: work that a handler could
	 * block or a user must approve never starts early.
	 */
	authorizeLaunch(context: SpeculativeLaunchContext): SpeculativeAuthorization {
		return this.#policyGate(context.tool, context.args);
	}

	/** Extension lifecycle handlers, tool interceptor rules, and non-auto-allow approval all veto early execution. */
	#policyGate(
		tool: SpeculativeToolReference,
		args: unknown,
		extraToolNames?: readonly string[],
	): SpeculativeAuthorization {
		if (hasLifecycleHandlers(this.extensionRunner)) {
			return { allowed: false, reason: "active extension lifecycle handler" };
		}
		const approval = resolveApproval(
			tool,
			args,
			cfgToolsApprovalMode.get(this.settings),
			cfgToolsApproval.get(this.settings),
			getApprovalGrants(this.settings.getAgentDir(), this.toolSession.sessionManager?.getSessionId?.()),
			approvalRestrictions(this.settings, this.toolSession.cwd),
		);
		if (approval.policy !== "allow") return { allowed: false, reason: "tool approval is not auto-allow" };
		if (cfgToolInterceptorEnabled.get(this.settings)) {
			const targetTools = extraToolNames ? [tool.name, ...extraToolNames] : [tool.name];
			if (
				hasApplicableToolInterceptorRules(targetTools, {
					rules: cfgToolInterceptorRules.get(this.settings),
					availableTools: this.toolSession.getToolContext?.()?.toolNames,
					policy: "allow",
				})
			) {
				return { allowed: false, reason: "active tool interceptor rule" };
			}
		}
		return { allowed: true };
	}
}

/**
 * Session-scoped speculative execution config with live settings reads.
 *
 * The Agent captures its config once at construction, so a one-shot
 * `{ enabled: true }` object would strand mid-session toggles: enabling
 * `task.speculativeLaunch` via the live settings UI would only persist the
 * setting until session recreate. The getter re-reads the current settings on
 * every access (the agent loop checks `enabled` per turn).
 */
export function createSpeculativeToolExecutionConfig(
	settings: Settings,
	toolSession: ToolSession,
	extensionRunner: SpeculationLifecycle,
): SpeculativeToolExecutionConfig {
	const host = new CodingAgentSpeculativeExecutionHost(settings, toolSession, extensionRunner);
	return {
		get enabled() {
			return cfgTaskSpeculativeLaunch.get(settings);
		},
		host,
	};
}
