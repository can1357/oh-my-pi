/**
 * Guards for the dashboard's page-wide keys (`Shell`'s shortcuts,
 * `CloseButton`'s Esc and Ctrl+C): they stay out of fields being typed
 * in and out of open dialogs, which own their keys.
 */

/** Whether `target` takes typing (a field, a select, editable content). */
export function isTypingTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

/** Whether a modal dialog or drawer is open. */
export function isDialogOpen(): boolean {
	return document.querySelector('[aria-modal="true"]') !== null;
}
