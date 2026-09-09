/** React binding for {@link GuestClient} via `useSyncExternalStore`. */
import { useSyncExternalStore } from "react";
import type { GuestClient, GuestSnapshot } from "./client";

export function useGuestSnapshot(client: GuestClient): GuestSnapshot {
	return useSyncExternalStore(
		listener => client.subscribe(listener),
		() => client.getSnapshot(),
		() => client.getSnapshot(),
	);
}
