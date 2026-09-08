/** Item identity exposed to a workpool worker's incremental `yield` tool. */
export interface WorkPoolYieldItem {
	id: string;
	index: number;
}

/** Build the per-batch output schema used to assemble one yield per item. */
export function buildWorkPoolOutputSchema(items: WorkPoolYieldItem[]): Record<string, unknown> {
	return {
		type: "object",
		properties: Object.fromEntries(items.map(item => [item.id, {}])),
		required: items.map(item => item.id),
		additionalProperties: false,
	};
}
