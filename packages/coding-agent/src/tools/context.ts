import { currentToolExecution, type AgentToolContext, type ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { trackUserWaits, type UserWaitOwner, type UserWaitTracker } from "../extensibility/extensions/user-wait";

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
	/** The host's own `ui`, before tracking: a per-call wrapper is built from this. */
	#rawUiContext: ExtensionUIContext | undefined;
	/** The last per-call wrapper handed out, with the run it bound to, so one run shares it. */
	#callUiContext: { owner: UserWaitOwner; ui: ExtensionUIContext } | undefined;
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
			ui: this.#uiFor(toolCall),
			hasUI: this.#hasUI,
			toolNames: this.#toolNames,
			toolCall,
			// Loop-dispatched calls carry the loop's passive-context sink; direct
			// (non-loop) executors such as the Cursor bridge install their own.
			addAdditionalContext: toolCall?.addAdditionalContext,
		};
	}

	/**
	 * The `ui` this call gets: dialogs it raises name the run this context was built for, so the
	 * wait each one opens says whose it is and a surface tracking that call learns when its own
	 * dialog settles rather than when the last unrelated one does. A holder that keeps the `ui`
	 * past that run names nothing with it — not even when a later run of the same call is the one
	 * executing — and a context built for no call keeps the shared wrapper, which names none.
	 */
	#uiFor(toolCall?: ToolCallContext): ExtensionUIContext | undefined {
		const raw = this.#rawUiContext;
		const toolCallId = toolCall?.toolCalls[toolCall.index]?.id;
		if (!raw || !this.trackUserWait || toolCallId === undefined) return this.#uiContext;
		const execution = toolCall?.execution ?? currentToolExecution();
		const cached = this.#callUiContext;
		if (cached && cached.owner.toolCallId === toolCallId && cached.owner.execution === execution) return cached.ui;
		const owner: UserWaitOwner = { toolCallId, execution, settled: execution !== undefined };
		const ui = trackUserWaits(raw, this.trackUserWait, owner);
		this.#callUiContext = { owner, ui };
		return ui;
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#rawUiContext = uiContext;
		this.#callUiContext = undefined;
		this.#uiContext = this.trackUserWait ? trackUserWaits(uiContext, this.trackUserWait) : uiContext;
		this.#hasUI = hasUI;
	}

	setToolNames(names: string[]): void {
		this.#toolNames = names;
	}
}
