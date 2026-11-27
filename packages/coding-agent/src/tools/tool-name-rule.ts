/**
 * Longest tool name strict validators accept. OpenAI Responses/Completions and
 * Meta Responses enforce `^[a-zA-Z0-9_-]{1,64}$`; names over 64 chars are
 * rejected with HTTP 400 `name must be at most 64 characters` (#9130).
 */
export const MAX_TOOL_NAME_LENGTH = 64;

const PROVIDER_TOOL_NAME = new RegExp(`^[a-zA-Z0-9_-]{1,${MAX_TOOL_NAME_LENGTH}}$`);

/** Whether `name` passes the tool name rule of strict validators ({@link MAX_TOOL_NAME_LENGTH}). */
export function isProviderToolName(name: string): boolean {
	return PROVIDER_TOOL_NAME.test(name);
}
