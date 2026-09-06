/**
 * Date/cwd reminder injection.
 *
 * The system prompt must stay byte-stable so open-weight chat templates that
 * render tool schemas *after* the system content keep their prefix cache
 * (#7404). The per-request date/cwd line used to live at the tail of the
 * system prompt (`project-prompt.md`), which invalidated the whole tool array
 * on every directory change or day rollover. It now rides on the first user
 * turn of each provider request instead: built at request time (never stored
 * in the session), deterministic per `(date, cwd)`, so the bytes are stable
 * for the lifetime of a session/day and refresh automatically at midnight.
 */
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import dateCwdReminderTemplate from "../prompts/system/date-cwd-reminder.md" with { type: "text" };

/** Renders the reminder text for the given local calendar date and cwd. */
export function renderDateCwdReminder(date: string, cwd: string): string {
	return prompt.render(dateCwdReminderTemplate, { date, cwd }).trim();
}

/**
 * Prepends `reminder` to the content of the first user message in `messages`,
 * returning a new array. The input is never mutated. Returns the input
 * unchanged when there is no user message to attach to, when the first user
 * message already carries the exact reminder, or when an identical input was
 * injected before with the same reminder.
 *
 * The memo is required by the append-only context path: it syncs the converted
 * message objects into its log and reuses them across requests, and callers
 * assert that identity is preserved for the stable prefix. Re-injecting the
 * same pristine first user message with the same reminder must hand back the
 * same injected message object, not a fresh clone. Keyed on the pristine
 * message object (the append-only log hands back fresh array copies every
 * turn, so array identity is not stable), with entries garbage-collected
 * alongside the messages they belong to.
 */
const injectCache = new WeakMap<Message, { reminder: string; injected: Message }>();

export function injectDateCwdReminder(messages: Message[], reminder: string): Message[] {
	const index = messages.findIndex(message => message.role === "user");
	if (index < 0) return messages;
	const first = messages[index]!;
	if (typeof first.content === "string") {
		if (first.content.startsWith(reminder)) return messages;
	} else if (first.content[0]?.type === "text" && first.content[0].text === reminder) {
		return messages;
	}
	const cached = injectCache.get(first);
	if (cached !== undefined && cached.reminder === reminder) {
		const out = messages.slice();
		out[index] = cached.injected;
		return out;
	}
	const content =
		typeof first.content === "string"
			? `${reminder}\n\n${first.content}`
			: ([{ type: "text", text: reminder }, ...first.content] as Message["content"]);
	const injected = { ...first, content } as Message;
	injectCache.set(first, { reminder, injected });
	const out = messages.slice();
	out[index] = injected;
	return out;
}

/**
 * Applies the date/cwd reminder to a provider `Context`, keeping the system
 * prompt byte-stable for prompt caching. Skips NULL_PROMPT-style contexts
 * (empty system prompt) so a no-prompt session stays byte-for-byte unchanged.
 */
export function withDateCwdReminder(context: Context, date: string, cwd: string): Context {
	if (!context.systemPrompt || context.systemPrompt.length === 0) return context;
	if (context.messages.length === 0) return context;
	const reminder = renderDateCwdReminder(date, cwd);
	const messages = injectDateCwdReminder(context.messages, reminder);
	return messages === context.messages ? context : { ...context, messages };
}
