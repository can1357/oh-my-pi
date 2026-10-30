import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";

/**
 * The fetch for a provider request whose client takes a `fetch` but no
 * `beforeDispatch` — speech synthesis and image generation. Each call waits
 * out `/pause` before it reaches `fetchImpl`, ended by that call's own signal,
 * so a tool that was already running when the gate closed sends nothing more
 * until the resume. An open gate adds no await.
 */
export function pauseHeldFetch(fetchImpl: FetchImpl): FetchImpl {
	return (input, init) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const held = agentPauseGate.dispatchHold(signal ?? undefined)();
		return held ? held.then(() => fetchImpl(input, init)) : fetchImpl(input, init);
	};
}
