import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { LoadExtensionsResult } from "./types";
import { getCodingAgentI18n } from "../../i18n";

/** Formats extension load failures for user-visible startup diagnostics. */
export function formatExtensionLoadNotifications(errors: LoadExtensionsResult["errors"]): string[] {
	const messages: string[] = [];
	for (const { path, error } of errors) {
		const displayPath = truncateToWidth(replaceTabs(shortenPath(path)), TRUNCATE_LENGTHS.CONTENT);
		const displayError = truncateToWidth(replaceTabs(error.replace(/\s+/g, " ").trim()), TRUNCATE_LENGTHS.LONG);
		messages.push(
			getCodingAgentI18n().t("codingAgent.extensionLoadFailed", { path: displayPath, error: displayError }),
		);
	}
	return messages;
}
