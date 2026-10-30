import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { dispatchWhenOpen } from "@oh-my-pi/pi-ai/utils/dispatch-hold";

/**
 * The fetch for a provider request whose client takes a `fetch` but no
 * `beforeDispatch` — speech synthesis and image generation. Each call waits
 * out `/pause` before it reaches `fetchImpl`, so a tool that was already
 * running when the gate closed sends nothing more until the resume. The call's
 * own signal ends that wait and fails the call with the signal's reason.
 *
 * The wait goes through {@link dispatchWhenOpen}, which reads the gate's probe
 * in the same synchronous step that calls `fetchImpl`. Awaiting the gate's
 * hold and calling `fetchImpl` once it settles is not enough: a resume answers
 * the hold, and a pause that returns in the microtasks before the call would
 * go unseen, putting the request on the wire while the gate is engaged.
 */
export function pauseHeldFetch(fetchImpl: FetchImpl): FetchImpl {
	return (input, init) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		return dispatchWhenOpen(agentPauseGate.dispatchHold(signal ?? undefined), signal, () => fetchImpl(input, init));
	};
}
