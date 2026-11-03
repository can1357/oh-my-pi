import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";

/**
 * The global lifecycle as the local manager it is on the main thread, where tests run, for the
 * calls only that manager has (`owesRelease`, `dispose` past its deadline).
 */
export function localLifecycle(): AgentLifecycleManager {
	const lifecycle = AgentLifecycleManager.global();
	if (!(lifecycle instanceof AgentLifecycleManager)) throw new Error("expected the main thread's local lifecycle");
	return lifecycle;
}
