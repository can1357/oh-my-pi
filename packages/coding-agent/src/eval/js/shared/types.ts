/**
 * Structured status payload emitted by helpers (`read`, `write`, `env`, etc.) and the
 * tool-call bridge. Surfaces to the model as part of `displays` so it has machine-readable
 * context about what side effects happened.
 */
export interface JsStatusEvent {
	op: string;
	[key: string]: unknown;
}
