import { isRecord } from "@oh-my-pi/pi-utils";
import type { UserWaitFrame } from "../../session/agent-session-events";
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

type Method = (...args: unknown[]) => unknown;

/**
 * What the dialog asks, read from the call itself, so the wait it opens names and classifies itself
 * instead of leaving every surface a label only this wrapper's method name explains. A surface that
 * attaches after the dialog opened (a focus rebuild, a reconnecting RPC client) has no other source:
 * the per-call approval record a live `tool_execution_start` builds is gone by then.
 *
 * `approve` is the tool-approval dialog, so it is a permission wait carrying the prompt's own
 * compact rendering (the one built for constrained surfaces). The rest ask a question: `askDialog`
 * carries its questions, and the dialogs whose first argument is their title carry that. A dialog
 * that fits none of these (a custom component) keeps the generic label.
 */
function describeDialog(method: string, args: readonly unknown[]): UserWaitFrame {
	const generic = `an extension ${method} dialog`;
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
		return { prompt: asked.length > 0 ? asked : generic, kind: "question" };
	}
	const title = args[0];
	return { prompt: typeof title === "string" && title.length > 0 ? title : generic, kind: "question" };
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
