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
 * the request without it.
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

/**
 * Request Daybreak Blue on `body` when `accountId` may use it on `model` and
 * no earlier rejection dropped it.
 */
export function applyCodexAccessPrograms(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
): void {
	if (!accountId) return;
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
	if (code !== undefined && Object.hasOwn(REJECTION_CODES, code)) return true;
	return REJECTION_PATTERN.test(error.message);
}
