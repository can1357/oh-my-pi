import type { ServerSentEvent } from "@oh-my-pi/pi-utils";
import type { RawSseEvent } from "../types";

type RawSseObserver = (event: RawSseEvent) => void;

export function notifyRawSseEvent(observer: RawSseObserver | undefined, event: ServerSentEvent | RawSseEvent): void {
	if (!observer) return;
	try {
		// Pass the event through without cloning `raw`. The only wired observer
		// (`RawSseDebugBuffer.recordEvent`) treats `raw` as owned and never
		// mutates it; new observers must adhere to the same contract.
		// `ServerSentEvent` and `RawSseEvent` are structurally identical
		// (`event: string | null`, `data: string`, `raw: string[]`).
		observer(event as RawSseEvent);
	} catch {
		// Raw stream observers are diagnostic only and must not affect generation.
	}
}
