import type { DispatchHold, FetchImpl } from "@oh-my-pi/pi-ai";
import { dispatchWhenOpen } from "@oh-my-pi/pi-ai/utils/dispatch-hold";

/**
 * `fetchImpl` behind an instance's dispatch hold: every attempt waits on it,
 * including each one a retry loop makes, and that attempt's own signal ends
 * the wait. The fetch call is the send itself, so it runs in the same step as
 * the hold's last check. Without a hold, `fetchImpl` is returned unchanged.
 */
export function fetchBehindHold(fetchImpl: FetchImpl, hold: DispatchHold | undefined): FetchImpl {
	if (!hold) return fetchImpl;
	return (input, init) => dispatchWhenOpen(hold, init?.signal, () => fetchImpl(input, init));
}
