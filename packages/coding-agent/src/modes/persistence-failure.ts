import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { SessionContinuation } from "../session/session-listing";
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
	return __ompTranslate(
		"Session persistence failed: {0}. Writes are retried; unsaved entries stay in memory until the store accepts them again.",
		`${detail}`,
	);
}

/**
 * Teardown-time durability claim, emitted only while the store failure is
 * still latched at dispose: the retry never landed, so the transcript is not
 * durable and the in-memory entries are gone with the process.
 */
export function formatPersistenceDurabilityFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return __ompTranslate(
		"Session persistence is still failing at shutdown: {0}. The session transcript is not durable; unsaved entries are lost.",
		`${detail}`,
	);
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
			message = __ompTranslate(
				"Session {0} is open for writing in another omp process, so this session now saves to {1} instead of mixing its entries into that file.",
				`${from}`,
				`${to}`,
			);
			break;
		case "replaced":
			message = __ompTranslate(
				"Session {0} changed on disk and no longer reads as this session; it is left untouched and this session now saves to {1}.",
				`${from}`,
				`${to}`,
			);
			break;
		case "contested":
			message = __ompTranslate(
				"Another program kept writing to session {0}; it is left to that writer and this session now saves to {1}.",
				`${from}`,
				`${to}`,
			);
			break;
	}
	return replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " ");
}

/**
 * Resume of a session file whose conversation went on in another file (see
 * {@link SessionContinuation}). Names both files, so the user sees that the
 * file they asked for was not the one opened.
 */
export function formatSessionContinuationNotice(continuation: SessionContinuation): string {
	const from = shortenPath(continuation.from);
	const to = shortenPath(continuation.session.path);
	// A session moves off its file for every SessionPersistenceNotice reason, not only another process's hold.
	let message: string;
	if (continuation.relation === "earlier") {
		message = `Session ${to}, which ${from} continues, has the newest turn of their conversation; resuming ${to}.`;
	} else if (continuation.relation === "other") {
		message = `Session ${to}, another copy of the conversation in ${from}, has its newest turn; resuming ${to}.`;
	} else if (continuation.copies > 2) {
		message = `Session ${from} went on in ${continuation.copies - 1} other files; resuming the one with the newest turn, ${to}.`;
	} else {
		message = `Session ${from} went on in ${to}; resuming ${to}.`;
	}
	return replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " ");
}
