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
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import dateCwdReminderTemplate from "../prompts/system/date-cwd-reminder.md" with { type: "text" };
import nowReminderTemplate from "../prompts/system/now-reminder.md" with { type: "text" };
import { formatLocalClockAndOffset, formatLocalTimeZoneShortName } from "../utils/local-date";

/** Renders the reminder text for the given local calendar date and cwd. */
export function renderDateCwdReminder(date: string, cwd: string): string {
	return prompt.render(dateCwdReminderTemplate, { date, cwd }).trim();
}

function messageStartsWithReminder(message: UserMessage, reminder: string): boolean {
	if (typeof message.content === "string") return message.content.startsWith(reminder);
	return message.content[0]?.type === "text" && message.content[0].text === reminder;
}

function injectReminder(message: UserMessage, reminder: string): UserMessage {
	const content: UserMessage["content"] =
		typeof message.content === "string"
			? `${reminder}\n\n${message.content}`
			: [{ type: "text", text: reminder }, ...message.content];
	return { ...message, content };
}

/**
 * Keeps volatile date/cwd reminders append-only across provider requests.
 *
 * The first value is attached to the first user turn. A changed value attaches
 * to a newly appended user turn or a persistent developer turn, leaving every
 * previously sent message byte-identical.
 */
export class DateCwdReminderInjector {
	#root: UserMessage | undefined;
	#currentReminder: string | undefined;
	#injections = new Map<Message, Message>();
	#controls: Array<{ anchor: Message; message: Message }> = [];
	#seen = new WeakSet<object>();

	/** Apply the current reminder while preserving all earlier injected bytes. */
	transform(context: Context, date: string, cwd: string): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		const reminder = renderDateCwdReminder(date, cwd);
		const messages = this.#inject(context.messages, reminder);
		return messages === context.messages ? context : { ...context, messages };
	}

	#inject(messages: Message[], reminder: string): Message[] {
		const firstUser = messages.find((message): message is UserMessage => message.role === "user");
		if (!firstUser) return messages;
		if (this.#root !== firstUser) {
			this.#root = firstUser;
			this.#currentReminder = reminder;
			this.#injections.clear();
			this.#controls = [];
			this.#seen = new WeakSet();
			if (!messageStartsWithReminder(firstUser, reminder)) {
				this.#injections.set(firstUser, injectReminder(firstUser, reminder));
			}
		} else if (this.#currentReminder !== reminder) {
			let newUser: UserMessage | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				const candidate = messages[index]!;
				if (candidate.role === "user" && !this.#seen.has(candidate)) {
					newUser = candidate;
					break;
				}
			}
			if (newUser) {
				this.#injections.set(newUser, injectReminder(newUser, reminder));
			} else {
				const anchor = messages.at(-1)!;
				this.#controls.push({
					anchor,
					message: {
						role: "developer",
						content: reminder,
						synthetic: true,
						timestamp: Date.now(),
					},
				});
			}
			this.#currentReminder = reminder;
		}

		const controlsByAnchor = new Map<Message, Message[]>();
		for (const control of this.#controls) {
			const controls = controlsByAnchor.get(control.anchor);
			if (controls) controls.push(control.message);
			else controlsByAnchor.set(control.anchor, [control.message]);
		}

		let changed = false;
		const out: Message[] = [];
		for (const message of messages) {
			const injected = this.#injections.get(message);
			out.push(injected ?? message);
			if (injected) changed = true;
			const controls = controlsByAnchor.get(message);
			if (controls) {
				out.push(...controls);
				changed = true;
			}
			this.#seen.add(message);
		}
		return changed ? out : messages;
	}
}

// ---------------------------------------------------------------------------
// Per-turn Now stamp
// ---------------------------------------------------------------------------

/** Matches a rendered Now stamp at the tail of a message's final text. */
const nowStampTail = /Now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \([^()]*\)\n<\/system-reminder>$/;

/** Renders the per-turn stamp payload, e.g. `2026-08-30T02:51:16Z (20:51 CST, UTC-06:00)`. */
export function renderNowStamp(now: Date = new Date()): string {
	const { clock, offset } = formatLocalClockAndOffset(now);
	const zone = formatLocalTimeZoneShortName(now);
	const zoneClock = [clock, zone].filter(part => part.length > 0).join(" ");
	const local = [zoneClock, `UTC${offset}`].filter(part => part.length > 0).join(", ");
	const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
	return prompt.render(nowReminderTemplate, { now: `${iso} (${local})` }).trim();
}

/**
 * Appends each user message's own-turn `Now:` stamp to `messages`,
 * returning a new array. The input is never mutated.
 *
 * The stamp is a pure function of the message's persisted identity — its
 * own `timestamp` — so re-stamps are byte-identical across requests and
 * across session resumes: a resumed process rehydrates history as fresh
 * objects with the persisted content and timestamp, and re-derives the
 * exact wire bytes the original process sent, given the same host timezone
 * and locale (the parenthesized local part of the stamp renders host-locally).
 * Only the genuinely-new last turn adds bytes, at the tail, so the
 * prompt-cache prefix stays stable.
 * Idempotent per user message: a message already carrying a stamp keeps
 * it — a fresh stamp would duplicate and invalidate the prompt cache from message 0.
 *
 * The stamp value is computed, never held in a process-global structure:
 * two distinct turns in the same second share the correct instant rather
 * than a value leaked from another turn's request. The only memo is the
 * object-identity WeakMap (mirroring `DateCwdReminderInjector`'s
 * injection memo), which keeps stamped objects stable within a live
 * session and is collected with its key message objects when the session
 * is discarded.
 */
const nowStampCache = new WeakMap<Message, Message>();

/**
 * The deterministic stamp for a user message: its own-turn instant
 * rendered as a `Now:` system reminder. Messages without a finite
 * timestamp are left unstamped rather than fabricated.
 */
function nowStampFor(message: Message): string | undefined {
	if (!Number.isFinite(message.timestamp)) return undefined;
	return renderNowStamp(new Date(message.timestamp));
}

/** Final text of a message: its string content, or the last text part. */
function finalMessageText(content: Message["content"]): string | undefined {
	if (typeof content === "string") return content;
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i]!;
		if (part.type === "text") return part.text;
	}
	return undefined;
}

export function injectNowStamp(messages: Message[]): Message[] {
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role !== "user") continue;
		const tail = finalMessageText(message.content);
		if (tail !== undefined && nowStampTail.test(tail)) continue;
		const stamp = nowStampFor(message);
		if (stamp === undefined) continue;
		const cached = nowStampCache.get(message);
		if (cached !== undefined) {
			(out ??= messages.slice())[i] = cached;
			continue;
		}
		const content =
			typeof message.content === "string"
				? `${message.content}\n\n${stamp}`
				: ([...message.content, { type: "text", text: stamp }] as Message["content"]);
		const stamped = { ...message, content } as Message;
		nowStampCache.set(message, stamped);
		(out ??= messages.slice())[i] = stamped;
	}
	return out ?? messages;
}

/**
 * Appends the per-turn `Now:` stamp to a provider `Context`, keeping the
 * system prompt byte-stable for prompt caching. Skips NULL_PROMPT-style
 * contexts (empty system prompt) and no-message contexts so such requests
 * stay byte-for-byte unchanged; mirrors the guards of
 * {@link DateCwdReminderInjector.transform}.
 */
export function applyNowStamp(context: Context): Context {
	if (!context.systemPrompt || context.systemPrompt.length === 0) return context;
	if (context.messages.length === 0) return context;
	const messages = injectNowStamp(context.messages);
	return messages === context.messages ? context : { ...context, messages };
}
