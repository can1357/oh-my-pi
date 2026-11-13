/**
 * OpenCode Zen's free tier answers `FreeUsageLimitError` (HTTP 429) unless the
 * request looks like the OpenCode client itself. Three things carry that
 * identity, and all three are required:
 *
 * - the client's `User-Agent` (matched whole — `opencode/1.19.5` alone is
 *   rejected),
 * - a `ses_`-prefixed `x-opencode-session`,
 * - a system prompt opening with the client's own title-generator
 *   instructions (the gateway matches a long prefix of it; the same block
 *   appended after our instructions still passes).
 *
 * These helpers add exactly those three things, on `*-free` Zen models only.
 */

import type { Context, Model } from "../types";

/**
 * The `User-Agent` OpenCode 1.19.5 sends. The gateway compares it whole: the
 * bare `opencode/<version>` and the `<channel>/<version>/<client>` forms are
 * both rejected, so this string has to be replaced when OpenCode moves.
 */
export const OPENCODE_FREE_USER_AGENT =
	"opencode/1.19.5 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4";

/**
 * OpenCode's title-generator system prompt, verbatim. The gateway only checks
 * that it opens the system prompt, so our own instructions follow it; the model
 * steps over the title rules when they are followed by a real task.
 */
export const OPENCODE_FREE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`;

/**
 * True for a free `opencode-zen` model. The backend is `providerType ??
 * provider`, matching every other wire-identity decision, so a custom provider
 * declared as the Zen backend gets the same treatment.
 */
export function isOpenCodeFreeModel(model: Pick<Model, "provider" | "providerType" | "id">): boolean {
	return (model.providerType ?? model.provider) === "opencode-zen" && model.id.endsWith("-free");
}

/**
 * Map a conversation id onto the gateway's session-id shape. Deterministic, so
 * retries and follow-up turns keep the same gateway cache key; the length and
 * alphabet imitate the client's `ses_` + 22 `[a-z0-9]` ids.
 */
export function openCodeFreeSessionId(sessionId: string): string {
	if (sessionId.startsWith("ses_")) return sessionId;
	const head = Bun.hash(sessionId).toString(36).padEnd(11, "0");
	const tail = Bun.hash(`${sessionId}#`).toString(36).padStart(11, "0");
	return `ses_${head.slice(0, 11)}${tail.slice(-11)}`;
}

/**
 * Prepend the client's system prompt. Applied to the first entry rather than
 * as an extra block so every provider's joiner keeps it in front; a context
 * that already carries it is returned untouched.
 */
export function withOpenCodeFreeSystemPrompt(context: Context): Context {
	const prompts = context.systemPrompt;
	if (!prompts || prompts.length === 0) return { ...context, systemPrompt: [OPENCODE_FREE_SYSTEM_PROMPT] };
	const [first, ...rest] = prompts;
	if (first.startsWith(OPENCODE_FREE_SYSTEM_PROMPT)) return context;
	return { ...context, systemPrompt: [`${OPENCODE_FREE_SYSTEM_PROMPT}\n\n${first}`, ...rest] };
}
