/**
 * Settling: the frame provider marks finalized transcript blocks so the
 * native reconciler stops keeping their description (Tern SDK,
 * `protocol/operations.md`, "Settling"). A settled block stays editable: a
 * later change is sent as targeted ops by id, followed by a fresh `settle`
 * hint.
 */
import type { Component } from "../tui";

const kSettled = Symbol("native.settled");

interface SettleTagged {
	[kSettled]?: true;
}

/** Mark `component` (and everything it describes) as finalized. Idempotent; a no-op outside a TSP terminal. */
export function settleNative(component: Component): void {
	(component as SettleTagged)[kSettled] = true;
}

/** Whether {@link settleNative} was called for `component`. */
export function isNativeSettled(component: Component): boolean {
	return (component as SettleTagged)[kSettled] === true;
}
