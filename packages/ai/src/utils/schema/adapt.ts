import { $flag } from "@oh-my-pi/pi-utils";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { tryEnforceStrictSchema } from "./normalize";

/**
 * Set when callers want to globally bypass OpenAI strict-mode enforcement
 * (e.g. for debugging a provider that misreports strict support, or when
 * comparing strict vs non-strict outputs).
 *
 * Honored by every provider that emits `strict: true` on its function tools —
 * see `openai-completions`, `openai-responses`, `openai-codex-responses`, and
 * the strict candidate selection in `anthropic`.
 */
export const NO_STRICT = $flag("PI_NO_STRICT");

/**
 * Consolidated helper for OpenAI-style strict schema enforcement.
 *
 * Each provider computes its own `strict` boolean (logic differs), then calls
 * this to handle the tryEnforceStrictSchema dance uniformly:
 * - Draft-07-shaped inputs are upgraded to draft 2020-12 first.
 * - If `strict` is false, passes the upgraded schema through unchanged.
 * - If `strict` is true, attempts to enforce strict mode; falls back to
 *   non-strict if the schema isn't representable.
 */
export function adaptSchemaForStrict(
	schema: Record<string, unknown>,
	strict: boolean,
): { schema: Record<string, unknown>; strict: boolean } {
	const upgraded = upgradeJsonSchemaTo202012(schema) as Record<string, unknown>;
	if (!strict) {
		return { schema: upgraded, strict: false };
	}

	return tryEnforceStrictSchema(upgraded);
}
