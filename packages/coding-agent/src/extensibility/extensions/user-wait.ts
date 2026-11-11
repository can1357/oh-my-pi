import { firstFieldQuestion } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { BlockedKind } from "../../utils/run-status";
import type { ExtensionApprovalPrompt, ExtensionAskDialogQuestion, ExtensionUIContext } from "./types";

/** What an open dialog asks of the user: a permission or an answer, with `msg` naming it in a line. */
export interface UserPrompt {
	kind: BlockedKind;
	msg?: string;
}

/**
 * Runs a dialog that waits for the user's answer, so its session can treat the time as the user's, not the agent's.
 * `describe` says what the dialog asks; it is read only when the wait is reported.
 */
export type UserWaitTracker = <T>(dialog: () => Promise<T>, describe?: () => UserPrompt) => Promise<T>;

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
 * `ui` with each dialog run through `track`, unless its options give it a deadline (`ask.timeout`): such a dialog
 * settles on its own and the agent goes on, possibly with nobody at the machine, so its time stays the agent's. Every
 * other member passes through. Members are read from `ui` on every access, so one it replaces later is the one called.
 */
export function trackUserWaits(ui: ExtensionUIContext, track: UserWaitTracker): ExtensionUIContext {
	// Wrappers keep their identity while the member they wrap does.
	const methods = new Map<PropertyKey, { value: Method; method: Method }>();
	return new Proxy(ui, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const cached = methods.get(property);
			if (cached?.value === value) return cached.method;
			const describe =
				typeof property === "string" && Object.hasOwn(DIALOGS, property) ? DIALOGS[property] : undefined;
			const method: Method = describe
				? (...args) =>
						args.some(arg => isRecord(arg) && typeof arg.timeout === "number" && arg.timeout > 0)
							? value.apply(target, args)
							: track(
									() => value.apply(target, args),
									() => describe(args),
								)
				: value.bind(target);
			methods.set(property, { value: value as Method, method });
			return method;
		},
	});
}
