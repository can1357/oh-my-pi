/** React binding for {@link GuestClient} via `useSyncExternalStore`. */
import { useCallback, useSyncExternalStore } from "react";
import type { GuestClient, GuestSnapshot } from "./client";

export function useGuestSnapshot(client: GuestClient): GuestSnapshot {
	// Stable per client: an inline subscribe makes React unsubscribe and
	// resubscribe on every render.
	const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
	const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
