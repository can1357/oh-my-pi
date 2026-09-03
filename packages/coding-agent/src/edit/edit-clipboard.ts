/**
 * Session-bound edit clipboard register.
 *
 * `CUT`/`PASTE` hashline ops share one {@link Clipboard} per session so
 * content captured by one edit call can be pasted by a later one (and across
 * files within one call). The executor works on a fork per batch and commits
 * it back only after every write lands — see `executeHashlineSingle`.
 */
import type { Clipboard } from "@oh-my-pi/hashline";

interface EditClipboardOwner {
	editClipboard?: Clipboard;
}

/**
 * Look up (or lazily create) the clipboard register attached to a session.
 * Storage lives on `session.editClipboard` so it ages out exactly with the
 * session itself.
 */
export function getEditClipboard(session: EditClipboardOwner): Clipboard {
	session.editClipboard ??= {};
	return session.editClipboard;
}
