/**
 * Codex cyber access programs ("Daybreak") for ChatGPT-authenticated requests.
 *
 * A request asks for `access_programs.cyber = "daybreak_blue"` whenever
 * multi-account discovery reported that the selected ChatGPT account may use
 * it on the model ({@link Model.accountAccess}). The backend rejects an
 * ineligible selection outright (400 `invalid_access_program`, 403
 * `access_program_not_enabled`, or a 403 `{"detail": …}` for models such as
 * Astra) instead of downgrading it, so a rejection drops the program for that
 * (account, model) pair for the rest of the process and the caller replays
 * the request without it. A request's `codexAccessPrograms` option switches
 * the automatic request off; unset falls back to the process-wide default
 * from {@link configureCodexAccessPrograms}.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Model } from "../../types";
import type { RequestBody } from "./request-transformer";

const DAYBREAK_BLUE = "daybreak_blue";
const REJECTION_CODES: Readonly<Record<string, true>> = {
	access_program_not_enabled: true,
	invalid_access_program: true,
};
/** `…Cyber access program is not authorized…` and Astra's `Reduced refusals aren't available…`. */
const REJECTION_PATTERN = /\baccess[ _]programs?\b|\breduced refusals\b/i;

/** `${accountId}\0${modelId}` pairs whose program the backend rejected this process. */
const droppedPrograms = new Set<string>();

/** Process-wide default for requests without `codexAccessPrograms`; see {@link configureCodexAccessPrograms}. */
let accessProgramsDefault = true;

/**
 * Set the process-wide default for requests that leave `codexAccessPrograms`
 * unset. Hosts call this from their settings so side calls that bypass a
 * session stream function still follow it; session requests pass their own
 * value, so concurrent sessions with different settings stay independent.
 */
export function configureCodexAccessPrograms(enabled: boolean): void {
	accessProgramsDefault = enabled;
}

/**
 * Request Daybreak Blue on `body` when `requested` (else the process default)
 * allows it, `accountId` may use it on `model`, and no earlier rejection
 * dropped it.
 */
export function applyCodexAccessPrograms(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
	requested: boolean | undefined,
): void {
	if (!(requested ?? accessProgramsDefault) || !accountId) return;
	if (!model.accountAccess?.[accountId]?.cyberPrograms?.includes(DAYBREAK_BLUE)) return;
	if (droppedPrograms.has(`${accountId}\0${model.id}`)) return;
	body.access_programs = { cyber: DAYBREAK_BLUE };
}

/**
 * Strip `access_programs` from `body` when `error` is the backend rejecting it,
 * remembering the drop for (account, model). Returns `true` when the caller
 * should replay the request; at most once per body, since the field is gone.
 */
export function dropRejectedCodexAccessPrograms(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
	error: unknown,
): boolean {
	if (body.access_programs === undefined || !isAccessProgramRejection(error)) return false;
	delete body.access_programs;
	if (accountId) droppedPrograms.add(`${accountId}\0${model.id}`);
	logger.warn("Codex rejected the requested access program; retrying without it", {
		model: model.id,
		accountId,
		error: error instanceof Error ? error.message : String(error),
	});
	return true;
}

function isAccessProgramRejection(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	// HTTP parsing promotes generic error.type to code; only specific codes rule out message fallback.
	if (code !== undefined && code !== "invalid_request_error") return Object.hasOwn(REJECTION_CODES, code);
	return REJECTION_PATTERN.test(error.message);
}
