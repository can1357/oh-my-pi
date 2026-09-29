import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { isRecord } from "../tool-render/util";

/** The TUI working label: execution intent first, then the streamed `i` field. Never substitute tool arguments for prose. */
export function toolIntent(args: unknown, explicitIntent?: unknown): string | undefined {
	const record = isRecord(args) ? args : undefined;
	for (const candidate of [explicitIntent, record?.[INTENT_FIELD], record?.intent]) {
		if (typeof candidate !== "string") continue;
		const label = candidate
			.replace(/\s+/g, " ")
			.replace(/[.\u2026\s]+$/, "")
			.trim();
		if (label) return label;
	}
	return undefined;
}
