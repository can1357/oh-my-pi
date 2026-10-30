import type { AgentToolContext, ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { trackUserWaits, type UserWaitTracker } from "../extensibility/extensions/user-wait";

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext extends CustomToolContext {
		ui?: ExtensionUIContext;
		hasUI?: boolean;
		toolNames?: string[];
		toolCall?: ToolCallContext;
		/** Set after the write tool's outer gate approves an `xd://` device call:
		 *  the `tools.approval` key that gate resolved (the device name). While the
		 *  input flows through unchanged, the inner wrapper skips its tier-only
		 *  prompt and an explicit prompt policy under this same key; overrides and
		 *  policies under other keys still apply. */
		xdevPolicyKey?: string;
		/** Immutable snapshot of the arguments an ACP client approved. The inner
		 *  wrapper skips tier and explicit prompts only while the effective input
		 *  remains equal; deny policies and provider safety checks still apply. */
		acpApprovedArgs?: unknown;
		/** Reports the approval tier resolved after an extension rewrites an
		 *  xd:// device call, so dispatch metadata describes the input that ran. */
		xdevTierResolved?(tier: "read" | "write" | "exec"): void;
		/** Set only after an interactive prompt approves provider computer safety checks. */
		providerSafetyApproved?: boolean;
		/** Set by the Cursor exec bridge, whose read frames compose `:raw` only to
		 *  drop line gutters. `read` then still returns image files as images
		 *  instead of their bytes decoded as text, which Cursor rejects (#15630). */
		rawImages?: boolean;
	}
}

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;
	#toolNames: string[] = [];

	constructor(
		private readonly getBaseContext: () => CustomToolContext,
		/** Runs each dialog a tool opens (`ask`, eval prelude approvals, computer control) as a wait for the user. */
		private readonly trackUserWait?: UserWaitTracker,
	) {}

	getContext(toolCall?: ToolCallContext): AgentToolContext {
		return {
			...this.getBaseContext(),
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			toolNames: this.#toolNames,
			toolCall,
			// Loop-dispatched calls carry the loop's passive-context sink; direct
			// (non-loop) executors such as the Cursor bridge install their own.
			addAdditionalContext: toolCall?.addAdditionalContext,
		};
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#uiContext = this.trackUserWait ? trackUserWaits(uiContext, this.trackUserWait) : uiContext;
		this.#hasUI = hasUI;
	}

	setToolNames(names: string[]): void {
		this.#toolNames = names;
	}
}
