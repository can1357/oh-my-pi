export function extractGoogleValidationUrl(errorBody: string): string | undefined {
	if (!errorBody.includes("VALIDATION_REQUIRED")) return undefined;
	const start = errorBody.indexOf("{");
	if (start === -1) return undefined;
	try {
		const parsed = JSON.parse(errorBody.slice(start)) as {
			error?: { details?: Array<{ reason?: string; metadata?: { validation_url?: string } }> };
		};
		const detail = parsed.error?.details?.find(
			d => d.reason === "VALIDATION_REQUIRED" && typeof d.metadata?.validation_url === "string",
		);
		return detail?.metadata?.validation_url;
	} catch {
		return undefined;
	}
}

export function formatGoogleValidationRequiredMessage(
	validationUrl: string,
	nextAction: string,
	email?: string,
): string {
	const account = email ? ` for ${email}` : "";
	return `Account verification required${account}. Visit ${validationUrl} to continue, then ${nextAction}.`;
}
