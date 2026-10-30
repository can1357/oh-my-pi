import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { LoadExtensionsResult } from "./types";

/** Formats extension load failures for user-visible startup diagnostics. */
export function formatExtensionLoadNotifications(errors: LoadExtensionsResult["errors"]): string[] {
	const messages: string[] = [];
	for (const { path, error } of errors) {
		const displayPath = truncateToWidth(replaceTabs(shortenPath(path)), TRUNCATE_LENGTHS.CONTENT);
		const displayError = truncateToWidth(replaceTabs(error.replace(/\s+/g, " ").trim()), TRUNCATE_LENGTHS.LONG);
		messages.push(__ompTranslate("Failed to load extension {0}: {1}", `${displayPath}`, `${displayError}`));
	}
	return messages;
}
