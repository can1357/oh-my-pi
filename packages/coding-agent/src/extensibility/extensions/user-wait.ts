import { AsyncLocalStorage } from "node:async_hooks";
import { firstFieldQuestion } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { BlockedKind } from "../../utils/run-status";
import type { ExtensionApprovalPrompt, ExtensionAskDialogQuestion, ExtensionUIContext } from "./types";

/** What an open dialog asks of the user: a permission, an answer, or a sign-in, with `msg` naming it in a line. */
export interface UserPrompt {
	kind: BlockedKind;
	msg?: string;
}

export interface UserWaitOptions {
	/**
	 * The dialog settles on its own once its deadline passes (`ask.timeout`) and the agent goes on, possibly with
	 * nobody at the machine: the wait is still reported, but its time stays the agent's.
	 */
	deadline?: boolean;
}

/**
 * Runs `dialog`, which waits for the user's answer, as one wait for the user asking `prompt`: its session reports
 * the wait and treats its time as the user's, not the agent's.
 */
export type UserWaitTracker = <T>(
	dialog: () => Promise<T>,
	prompt: UserPrompt,
	options?: UserWaitOptions,
) => Promise<T>;

/** Set while a wait's dialog runs: the dialogs it opens through a tracked UI are part of that wait. */
const openWait = new AsyncLocalStorage<true>();

/** Runs the dialog of a wait for the user; a wait it opens in turn is part of this one ({@link insideUserWait}). */
export function enterUserWait<T>(dialog: () => Promise<T>): Promise<T> {
	return openWait.run(true, dialog);
}

/** Whether the caller runs inside the dialog of a wait for the user, so a dialog it opens is part of that wait. */
export function insideUserWait(): boolean {
	return openWait.getStore() === true;
}

/** The tracker of each UI {@link trackUserWaits} returned. */
const trackers = new WeakMap<object, UserWaitTracker>();

/**
 * Runs `dialog` on `ui` as one wait for the user asking `prompt`, whatever dialogs it opens: an `ask` answered field
 * by field is one question, and a tool approval shown as a `select` is still a permission. A `ui` that
 * {@link trackUserWaits} did not return (or none) belongs to no session, so the dialog just runs.
 */
export function askUser<T>(
	ui: object | undefined,
	dialog: () => Promise<T>,
	prompt: UserPrompt,
	options?: UserWaitOptions,
): Promise<T> {
	const track = ui && trackers.get(ui);
	return track ? track(dialog, prompt, options) : dialog();
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The {@link ExtensionUIContext} methods that wait for the user's answer, each with what it asks given its arguments. */
const DIALOGS: Record<string, (args: unknown[]) => UserPrompt> = {
	select: args => ({ kind: "question", msg: text(args[0]) }),
	confirm: args => ({ kind: "permission", msg: text(args[0]) }),
	input: args => ({ kind: "question", msg: text(args[0]) }),
	editor: args => ({ kind: "question", msg: text(args[0]) }),
	custom: () => ({ kind: "question" }),
	askDialog: args => ({ kind: "question", msg: (args[0] as ExtensionAskDialogQuestion[] | undefined)?.[0]?.question }),
	formDialog: args => {
		const html = text(args[0]);
		return { kind: "question", msg: html === undefined ? undefined : firstFieldQuestion(parseHtmlForm(html)) };
	},
	approve: args => ({ kind: "permission", msg: (args[0] as ExtensionApprovalPrompt | undefined)?.compact }),
};

type Method = (...args: unknown[]) => unknown;

/**
 * `ui` with each dialog run through `track` as a wait for the user, described by the dialog and its arguments; one
 * whose options give it a deadline (`ask.timeout`) is a wait with a deadline. A dialog opened inside a wait already
 * running (see {@link askUser}) is part of it. Every other member passes through. Members are read from `ui` on every
 * access, so one it replaces later is the one called.
 */
export function trackUserWaits(ui: ExtensionUIContext, track: UserWaitTracker): ExtensionUIContext {
	// Wrappers keep their identity while the member they wrap does.
	const methods = new Map<PropertyKey, { value: Method; method: Method }>();
	const tracked = new Proxy(ui, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const cached = methods.get(property);
			if (cached?.value === value) return cached.method;
			const describe =
				typeof property === "string" && Object.hasOwn(DIALOGS, property) ? DIALOGS[property] : undefined;
			const method: Method = describe
				? (...args) =>
						track(() => value.apply(target, args), describe(args), {
							deadline: args.some(arg => isRecord(arg) && typeof arg.timeout === "number" && arg.timeout > 0),
						})
				: value.bind(target);
			methods.set(property, { value: value as Method, method });
			return method;
		},
	});
	trackers.set(tracked, track);
	return tracked;
}
