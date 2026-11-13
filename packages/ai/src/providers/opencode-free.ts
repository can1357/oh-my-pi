/**
 * OpenCode Zen's free tier is gated on the OpenCode client itself. Free
 * (`*-free`) Zen models answer `FreeUsageLimitError` (HTTP 429) unless the
 * request carries that client's `User-Agent`, a `ses_`-shaped session id and
 * its title-generator prompt ahead of the system prompt.
 *
 * The lane is opted in by KDL (`opencode-client-identity` on `*-free` in
 * `opencode-zen.kdl`) and read from `model.compat`; the wire literals live in
 * `@oh-my-pi/pi-catalog/wire/opencode`. Jev's free SKU stays out of it: it is
 * seeded on the typesafe judge wire, which sends none of these.
 */

import type { Context } from "../types";
import opencodeFreePrompt from "./opencode-free-prompt.md" with { type: "text" };

/** True when the model's resolved compat opts into the client identity. */
export function usesOpenCodeClientIdentity(compat: object | undefined): boolean {
	return compat !== undefined && "opencodeClientIdentity" in compat && compat.opencodeClientIdentity === true;
}

/** The client's title-generator prompt, verbatim; the gateway matches its opening. */
export const OPENCODE_FREE_SYSTEM_PROMPT = opencodeFreePrompt.trimEnd();

/**
 * Prepend the client's prompt. Applied to the first entry rather than as an
 * extra block so every provider's joiner keeps it in front; a context that
 * already carries it is returned untouched, which is what the retry paths see.
 */
export function withOpenCodeFreeSystemPrompt(context: Context): Context {
	const prompts = context.systemPrompt;
	if (!prompts || prompts.length === 0) return { ...context, systemPrompt: [OPENCODE_FREE_SYSTEM_PROMPT] };
	const [first, ...rest] = prompts;
	if (first.startsWith(OPENCODE_FREE_SYSTEM_PROMPT)) return context;
	return { ...context, systemPrompt: [`${OPENCODE_FREE_SYSTEM_PROMPT}\n\n${first}`, ...rest] };
}
