const CLINEPASS_WIRE_PREFIX = "cline-pass/";

/** Convert a public ClinePass catalog id to the gateway's wire id. */
export function toClinePassWireModelId(modelId: string): string {
	return modelId.startsWith(CLINEPASS_WIRE_PREFIX) ? modelId : `${CLINEPASS_WIRE_PREFIX}${modelId}`;
}

/** Convert a gateway ClinePass wire id to the public catalog id. */
export function toClinePassPublicModelId(modelId: string): string {
	return modelId.startsWith(CLINEPASS_WIRE_PREFIX) ? modelId.slice(CLINEPASS_WIRE_PREFIX.length) : modelId;
}
