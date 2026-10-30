import { isRecord } from "@oh-my-pi/pi-utils";
import { UNNAMED_USER_WAIT_PROMPT, type UserWaitFrame } from "../../session/agent-session-events";
import type { BlockedKind } from "../../utils/run-status";
import type { ExtensionUIContext } from "./types";

/**
 * Runs a dialog that waits for the user's answer, so its session can treat the time as the user's, not the agent's.
 * `frame` is what the dialog asks and how a surface reporting run state classifies it.
 */
export type UserWaitTracker = <T>(dialog: () => Promise<T>, frame: UserWaitFrame) => Promise<T>;

/** The {@link ExtensionUIContext} methods that wait for the user's answer. */
const DIALOGS: Record<string, true> = {
	select: true,
	confirm: true,
	input: true,
	editor: true,
	custom: true,
	askDialog: true,
	approve: true,
};

/** The label a dialog that named nothing of its own is published under. */
function genericDialogLabel(method: string): string {
	return `an extension ${method} dialog`;
}

/**
 * Every prompt that stands in for a dialog which named nothing: the wrapper's method name, and the
 * session's own placeholder for a caller that passed no prompt. A surface holding a better name for
 * what waits — the approval record a tool call still being asked about carries — reports that
 * instead; any other prompt is the dialog's own words and outranks it.
 */
export const UNNAMED_DIALOG_PROMPTS: ReadonlySet<string> = new Set([
	UNNAMED_USER_WAIT_PROMPT,
	...Object.keys(DIALOGS).map(genericDialogLabel),
]);

/**
 * The classification the caller declared on the dialog's options
 * ({@link ExtensionUIDialogOptions.waitKind}), which outranks what the method name implies: an
 * approval a host without an approval dialog answers through `select` is still a permission.
 */
function declaredKind(args: readonly unknown[]): BlockedKind | undefined {
	for (const arg of args) {
		if (!isRecord(arg)) continue;
		if (arg.waitKind === "permission" || arg.waitKind === "question") return arg.waitKind;
	}
	return undefined;
}

type Method = (...args: unknown[]) => unknown;

/**
 * What the dialog asks, read from the call itself, so the wait it opens names and classifies itself
 * instead of leaving every surface a label only this wrapper's method name explains. A surface that
 * attaches after the dialog opened (a focus rebuild, a reconnecting RPC client) has no other source:
 * the per-call approval record a live `tool_execution_start` builds is gone by then.
 *
 * `approve` is the tool-approval dialog, so it is a permission wait carrying the prompt's own
 * compact rendering (the one built for constrained surfaces). The rest ask a question unless the
 * call declares otherwise through {@link declaredKind} — an approval a host without an approval
 * dialog raises as a `select` is one such: `askDialog` carries its questions, and the dialogs whose
 * first argument is their title carry that. A dialog that fits none of these (a custom component)
 * keeps the generic label.
 */
function describeDialog(method: string, args: readonly unknown[]): UserWaitFrame {
	const generic = genericDialogLabel(method);
	const declared = declaredKind(args);
	if (method === "approve") {
		const prompt = args[0];
		const compact = isRecord(prompt) ? prompt.compact : undefined;
		const full = isRecord(prompt) ? prompt.full : undefined;
		const text = typeof compact === "string" && compact.length > 0 ? compact : full;
		return { prompt: typeof text === "string" && text.length > 0 ? text : generic, kind: "permission" };
	}
	if (method === "askDialog") {
		const questions = Array.isArray(args[0]) ? args[0] : [];
		const asked = questions
			.map(question => (isRecord(question) && typeof question.question === "string" ? question.question : ""))
			.filter(question => question.length > 0)
			.join(" ");
		return { prompt: asked.length > 0 ? asked : generic, kind: declared ?? "question" };
	}
	const title = args[0];
	return {
		prompt: typeof title === "string" && title.length > 0 ? title : generic,
		kind: declared ?? "question",
	};
}

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
			const method: Method = Object.hasOwn(DIALOGS, property)
				? (...args) =>
						args.some(arg => isRecord(arg) && typeof arg.timeout === "number" && arg.timeout > 0)
							? value.apply(target, args)
							: track(() => value.apply(target, args), describeDialog(String(property), args))
				: value.bind(target);
			methods.set(property, { value: value as Method, method });
			return method;
		},
	});
}
