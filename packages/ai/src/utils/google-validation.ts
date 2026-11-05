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

/**
 * Cloud Code Assist's geographic refusal: Google rejects the request because
 * the *egress* region ("User location") is not supported, regardless of the
 * account's own eligibility. It is an HTTP 400 FAILED_PRECONDITION, not a
 * local socket failure, so it takes no retry or credential rotation; the only
 * fix is a different proxy/VPN exit.
 *
 * A structured Google error envelope is validated strictly (status
 * `FAILED_PRECONDITION` and the phrase in `error.message`), so a coincidental
 * `location` field — or the phrase inside an unrelated JSON body — cannot
 * trigger the egress hint. A plain-text/truncated body falls back to the exact
 * phrase, which is Google's own wording and never a prose mismatch.
 */
const GOOGLE_REGION_REFUSAL_PHRASE = "User location is not supported for the API use";

/** Whether a Google error body is the egress-region refusal. */
export function isGoogleRegionRefusal(errorBody: string): boolean {
	if (!errorBody.includes(GOOGLE_REGION_REFUSAL_PHRASE)) return false;
	const jsonStart = errorBody.indexOf("{");
	if (jsonStart === -1) return true;
	try {
		const parsed = JSON.parse(errorBody.slice(jsonStart)) as {
			error?: { status?: unknown; message?: unknown };
		};
		return (
			parsed.error?.status === "FAILED_PRECONDITION" &&
			typeof parsed.error.message === "string" &&
			parsed.error.message.includes(GOOGLE_REGION_REFUSAL_PHRASE)
		);
	} catch {
		// Not a complete JSON envelope (plain text, proxy truncation): the exact
		// phrase is the only evidence available.
		return true;
	}
}

/** Actionable user-facing sentence for {@link isGoogleRegionRefusal}. */
export function formatGoogleRegionRefusalMessage(): string {
	return "Cloud Code Assist refused this request: User location is not supported for the API use (HTTP 400 FAILED_PRECONDITION). Change the exit region of your proxy/VPN (PI_PROXY_GOOGLE_ANTIGRAVITY for google-antigravity) and retry; switching accounts does not change the egress region.";
}
