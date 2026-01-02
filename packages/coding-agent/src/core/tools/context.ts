import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { CustomToolContext } from "../custom-tools/types.js";
import type { HookUIContext } from "../hooks/types.js";

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext extends CustomToolContext {
		ui?: HookUIContext;
		hasUI?: boolean;
	}
}

export interface ToolContextStore {
	getContext(): AgentToolContext;
	setUIContext(uiContext: HookUIContext, hasUI: boolean): void;
}

export function createToolContextStore(getBaseContext: () => CustomToolContext): ToolContextStore {
	let uiContext: HookUIContext | undefined;
	let hasUI = false;

	return {
		getContext: () => ({
			...getBaseContext(),
			ui: uiContext,
			hasUI,
		}),
		setUIContext: (context, uiAvailable) => {
			uiContext = context;
			hasUI = uiAvailable;
		},
	};
}
