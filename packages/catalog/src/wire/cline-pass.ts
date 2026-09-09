/**
 * Cline API base shared by ClinePass subscription inference, free-tier models,
 * roster discovery, login validation, and usage reporting. One constant so a
 * host migration touches a single module.
 */
export const CLINEPASS_API_BASE_URL = "https://api.cline.bot/api/v1";

/**
 * Client-identity headers mirroring the official Cline CLI's request layer
 * (sdk/packages/llms/src/providers/request-headers.ts). Cline's gateway gates
 * some roster entries — certain free-tier models — to Cline product surfaces,
 * and this is the contract that identifies a Cline client. Mirrored with Cline's
 * blessing for a native integration.
 *
 * The gate accepted an arbitrary version string when probed (0.0.1 passed on
 * 2026-08-13), so the pinned versions are mirror fidelity, not a minimum — but
 * the full set is sent deliberately: partial mirrors are one gateway change
 * away from a 403. `X-Task-ID` carries OMP's stable prompt-cache/session key
 * when available; account and discovery calls omit it rather than inventing a
 * per-request identity.
 */
export function clinePassClientHeaders(taskId?: string): Record<string, string> {
	return {
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE": "cline-sdk",
		"User-Agent": "Cline/3.0.58",
		"X-CLIENT-VERSION": "3.0.58",
		"X-PLATFORM": process.platform,
		"X-PLATFORM-VERSION": "3.0.54",
		"X-CORE-VERSION": "0.0.79",
		...(taskId ? { "X-Task-ID": taskId } : {}),
	};
}
