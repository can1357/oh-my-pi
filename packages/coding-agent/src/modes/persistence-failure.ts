import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { SessionPersistenceNotice } from "../session/session-manager";

/**
 * First-failure notice. The store keeps the unlanded entries in memory and
 * retries the whole transcript on the next write, so this reports a retryable
 * condition and claims nothing about durability — the write may still land.
 * `sanitizeText` leaves tabs and newlines intact, so both are normalized here
 * to keep the result on one line.
 */
export function formatPersistenceFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return `Session persistence failed: ${detail}. Writes are retried; unsaved entries stay in memory until the store accepts them again.`;
}

/**
 * Teardown-time durability claim, emitted only while the store failure is
 * still latched at dispose: the retry never landed, so the transcript is not
 * durable and the in-memory entries are gone with the process.
 */
export function formatPersistenceDurabilityFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return `Session persistence is still failing at shutdown: ${detail}. The session transcript is not durable; unsaved entries are lost.`;
}

/**
 * A {@link SessionPersistenceNotice}: saving continues, so this claims no
 * failure. Not truncated, because the notice names the session files the user
 * may need to find.
 */
export function formatPersistenceNotice(notice: SessionPersistenceNotice): string {
	const from = shortenPath(notice.from);
	const to = shortenPath(notice.to);
	let message: string;
	switch (notice.reason) {
		case "open-elsewhere":
			message = `Session ${from} is open for writing in another omp process, so this session now saves to ${to} instead of mixing its entries into that file.`;
			break;
		case "replaced":
			message = `Session ${from} changed on disk and no longer reads as this session; it is left untouched and this session now saves to ${to}.`;
			break;
		case "contested":
			message = `Another program kept writing to session ${from}; it is left to that writer and this session now saves to ${to}.`;
			break;
	}
	return replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " ");
}
