/**
 * Date/cwd reminder injection.
 *
 * The system prompt must stay byte-stable so open-weight chat templates that
 * render tool schemas *after* the system content keep their prefix cache
 * (#7404). Date/cwd values instead ride on user/developer messages. The first
 * value is attached to the first plain user turn; later values are append-only.
 * Reminder ownership follows the messages in each request, so an ephemeral
 * side request cannot consume the reminder needed by the main history.
 */
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import dateCwdReminderTemplate from "../prompts/system/date-cwd-reminder.md" with { type: "text" };

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

interface ReminderEntry {
	reminder: string;
	message: Message;
}

interface ReminderHistory {
	injections: WeakMap<Message, ReminderEntry>;
	controls: WeakMap<Message, ReminderEntry[]>;
	seen: WeakSet<Message>;
}

/**
 * Keeps volatile date/cwd reminders append-only across provider requests.
 *
 * Plain user turns can carry reminders in their content. Opaque provider payloads
 * may bypass that content entirely, so they stay untouched and use a later plain
 * user or a tail-anchored developer turn, after any retained assistant/tool tail.
 * Previously sent messages remain byte-identical.
 */
export class DateCwdReminderInjector {
	// Independent side/advisor histories must not discard a still-live main
	// history's ownership. Neither roots nor removed carriers are held strongly.
	#histories = new WeakMap<UserMessage, ReminderHistory>();

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
		let history = this.#histories.get(firstUser);
		if (!history) {
			history = { injections: new WeakMap(), controls: new WeakMap(), seen: new WeakSet() };
			this.#histories.set(firstUser, history);
			if (firstUser.providerPayload === undefined) {
				history.injections.set(firstUser, {
					reminder,
					message: messageStartsWithReminder(firstUser, reminder)
						? firstUser
						: injectReminder(firstUser, reminder),
				});
			}
		}

		// Derive the effective reminder from this request, not the last request:
		// a side request or a trimmed tail may have taken its carrier with it.
		let currentReminder: string | undefined;
		let newUserIndex: number | undefined;
		let changed = false;
		const out: Message[] = [];
		for (const message of messages) {
			if (message.role === "user" && message.providerPayload === undefined && !history.seen.has(message)) {
				newUserIndex = out.length;
			}
			const injected = history.injections.get(message);
			out.push(injected?.message ?? message);
			if (injected) {
				currentReminder = injected.reminder;
				newUserIndex = undefined;
				if (injected.message !== message) changed = true;
			}
			const controls = history.controls.get(message);
			if (controls) {
				for (const control of controls) {
					out.push(control.message);
					currentReminder = control.reminder;
				}
				newUserIndex = undefined;
				changed = true;
			}
			history.seen.add(message);
		}

		if (currentReminder !== reminder) {
			if (newUserIndex !== undefined) {
				// Only an unseen user after the last reminder can carry a new value
				// without rewriting history or being superseded by an older control.
				const user = out[newUserIndex] as UserMessage;
				const injected = injectReminder(user, reminder);
				history.injections.set(user, { reminder, message: injected });
				out[newUserIndex] = injected;
			} else {
				const anchor = messages.at(-1)!;
				const control: ReminderEntry = {
					reminder,
					message: { role: "developer", content: reminder, synthetic: true, timestamp: Date.now() },
				};
				const controls = history.controls.get(anchor);
				if (controls) controls.push(control);
				else history.controls.set(anchor, [control]);
				out.push(control.message);
			}
			changed = true;
		}
		return changed ? out : messages;
	}
}
