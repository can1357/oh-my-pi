/**
 * Structured status payload emitted by helpers (`read`, `write`, `env`, etc.) and the
 * tool-call bridge. Surfaces to the model as part of `displays` so it has machine-readable
 * context about what side effects happened.
 */
export interface JsStatusEvent {
	op: string;
	[key: string]: unknown;
}

/**
 * One unit of structured output from a JS eval cell. `text` chunks flow through a separate
 * channel.
 */
export type JsDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "status"; event: JsStatusEvent };
