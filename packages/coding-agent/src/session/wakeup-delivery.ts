import { prompt } from "@oh-my-pi/pi-utils";
import type { WakeupDelivery } from "../async/wakeup-manager";
import wakeupResult from "../prompts/tools/wakeup-result.md" with { type: "text" };
import { escapeHarnessTags } from "./harness-tags";
import type { CustomMessage } from "./messages";

/** Build saved checkback data without granting it harness/system authority. */
export function buildWakeupMessage(entries: WakeupDelivery[]): CustomMessage | null {
	if (entries.length === 0) return null;
	return {
		role: "custom",
		customType: "wakeup",
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
		content: entries
			.map(entry =>
				prompt.render(wakeupResult, {
					id: entry.record.id,
					reason: entry.reason,
					savedPrompt: escapeHarnessTags(entry.record.prompt).replace(/<(?=\/?saved-wakeup\b)/gi, "&lt;"),
				}),
			)
			.join("\n\n"),
	};
}
