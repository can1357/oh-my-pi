import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { cfgTaskCrossInstance } from "../task/settings";
import type * as MeshLink from "./mesh-link";

let mesh: MeshLink.AgentMesh | undefined;

/** The active mesh link, if the interactive session enabled cross-instance messaging. */
export function agentMesh(): MeshLink.AgentMesh | undefined {
	return mesh;
}

/** Join or leave the room as the interactive `session`'s cross-instance setting changes. */
export function bindAgentMesh(projectDir: string, settings: Settings, session: AgentSession): () => void {
	const apply = (enabled: boolean) => {
		if (enabled) {
			if (!mesh) {
				// An initially enabled mesh must be visible before bindAgentMesh returns.
				const { AgentMesh }: typeof MeshLink = require("./mesh-link");
				mesh = new AgentMesh(projectDir, session);
			}
		} else {
			const previous = mesh;
			mesh = undefined;
			previous?.stop();
		}
	};
	const unlisten = cfgTaskCrossInstance.listen(settings, apply);
	apply(cfgTaskCrossInstance.get(settings));
	return () => {
		unlisten();
		apply(false);
	};
}
