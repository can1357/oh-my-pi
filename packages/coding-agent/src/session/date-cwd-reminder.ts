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

/** Developer turns the injector inserted; every other output message maps to an input one. */
const reminderControls = new WeakSet<Message>();

/** Whether `message` is a developer turn a {@link DateCwdReminderInjector} inserted. */
export function isDateCwdReminderControl(message: Message): boolean {
	return reminderControls.has(message);
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
	/**
	 * Bumped whenever `#injections`/`#controls` change shape, so the replay
	 * memo below can't validate against state it has already outlived (an
	 * in-place `push` into a shared array would otherwise look unchanged).
	 */
	#stateVersion = 0;
	/**
	 * Last output built, tagged with the inputs that produced it. A repeat of
	 * that exact (message set, root, reminder, state) tuple — a provider retry
	 * replaying the same request, or a chain step that keeps the array identity
	 * — hands back the same array instead of re-copying the whole transcript.
	 * `refs` is a snapshot, never the caller's live array: element identity is
	 * what makes an in-place push/splice a miss, and the array reference alone
	 * would survive it.
	 */
	#memo:
		| {
				refs: Message[];
				root: UserMessage;
				reminder: string;
				version: number;
				output: Message[];
		  }
		| undefined;

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
		// Replay: identical message set, root, reminder and injector state as
		// the last build — hand back the same array and skip the per-message
		// work entirely.
		const memo = this.#memo;
		if (
			memo !== undefined &&
			memo.root === firstUser &&
			memo.root === this.#root &&
			memo.reminder === reminder &&
			memo.reminder === this.#currentReminder &&
			memo.version === this.#stateVersion &&
			memo.refs.length === messages.length &&
			memo.refs.every((message, index) => message === messages[index])
		) {
			return memo.output;
		}
		if (this.#root !== firstUser) {
			// A new first user turn: a compaction summary or a different conversation.
			// Turns kept from the earlier history must keep the reminders they were
			// sent with, or their bytes change under signed thinking; reminders on
			// turns that are gone are dropped. The new root gets the current reminder.
			const present = new Set<Message>(messages);
			for (const message of this.#injections.keys()) {
				if (!present.has(message)) this.#injections.delete(message);
			}
			this.#controls = this.#controls.filter(control => present.has(control.anchor));
			this.#root = firstUser;
			this.#currentReminder = reminder;
			this.#stateVersion++;
			if (!this.#injections.has(firstUser) && !messageStartsWithReminder(firstUser, reminder)) {
				this.#injections.set(firstUser, injectReminder(firstUser, reminder));
				this.#stateVersion++;
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
				this.#stateVersion++;
			} else {
				const anchor = messages.at(-1)!;
				const control: Message = {
					role: "developer",
					content: reminder,
					synthetic: true,
					timestamp: Date.now(),
				};
				reminderControls.add(control);
				this.#controls.push({ anchor, message: control });
				this.#stateVersion++;
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
			// Only user turns are ever scanned for un-seen ones, so the rest
			// never needed a WeakSet entry — check before paying the add.
			if (message.role === "user" && !this.#seen.has(message)) this.#seen.add(message);
		}
		const output = changed ? out : messages;
		// `refs` snapshots the caller's array by reference; `#root` is the live
		// root (equals `firstUser` on every path that reaches here) and
		// `#currentReminder` the reminder this output was built with.
		const root = this.#root;
		const currentReminder = this.#currentReminder;
		if (root !== undefined && currentReminder !== undefined) {
			this.#memo = {
				refs: messages.slice(),
				root,
				reminder: currentReminder,
				version: this.#stateVersion,
				output,
			};
		}
		return output;
	}
}
