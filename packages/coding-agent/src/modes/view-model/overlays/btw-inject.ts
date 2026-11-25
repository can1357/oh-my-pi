/** Labels a steering prompt that has not been sent yet. */
export const BTW_INJECT_LABEL = "Inject into main session";

/** Labels a sent steering prompt. */
export const BTW_INJECTED_LABEL = "Injected into main session";

/** A displayed `<inject>` block: still sendable, or sent. Blocks in neither state render as plain text. */
export type BtwInjectState = "pending" | "sent";
