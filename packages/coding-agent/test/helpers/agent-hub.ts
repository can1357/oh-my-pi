/**
 * The Agent Hub mounted on a scripted terminal the way `/hub` opens it: a
 * fullscreen layer with the picker focused.
 */
import type { AgentRecordLike } from "../../src/registry/agent-hub-types";
import { SessionObserverRegistry } from "../../src/task/session-observer-registry";
import { AgentHub, type AgentHubHandle, type AgentHubProps } from "../../src/ui/overlays/pickers/agent-hub";
import { type LayerTerminal, mountLayer } from "./layer-terminal";

export type HubProps<T extends AgentRecordLike> = Omit<AgentHubProps<T>, "observers" | "hubKeys" | "rows" | "onDone"> &
	Partial<Pick<AgentHubProps<T>, "observers" | "hubKeys" | "onDone">>;

export interface MountedHub extends LayerTerminal {
	readonly handle: AgentHubHandle;
}

export function mountAgentHub<T extends AgentRecordLike>(
	props: HubProps<T>,
	size: { columns?: number; rows?: number } = {},
): MountedHub {
	const rows = size.rows ?? 40;
	let handle: AgentHubHandle | undefined;
	const layer = mountLayer(
		() =>
			AgentHub<T>({
				observers: new SessionObserverRegistry(),
				hubKeys: [],
				onDone: () => {},
				...props,
				rows: () => rows,
				ref: hub => {
					handle = hub;
				},
			}),
		{ columns: size.columns, rows },
	);
	if (!handle) throw new Error("Agent Hub did not hand out its handle");
	return { ...layer, handle };
}
