import { toolExecutionOnChain } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { UserWaitFrame } from "../../session/agent-session-events";
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

/**
 * The tool call the caller declared on the dialog's options
 * ({@link ExtensionUIDialogOptions.toolCallId}), so the wait this dialog opens says which call it
 * belongs to and a surface tracking that call learns when its own wait ends. A dialog raised
 * outside any call declares nothing and owns nothing.
 */
function declaredToolCallId(args: readonly unknown[]): string | undefined {
	for (const arg of args) {
		if (isRecord(arg) && typeof arg.toolCallId === "string" && arg.toolCallId.length > 0) return arg.toolCallId;
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
 * keeps the generic label. Every frame carries the call the dialog was raised for: the one the
 * call itself declared, else the run of the call this `ui` was handed to, matched against the
 * executions this dialog is being raised inside. What travels is the run, never the bare id — the
 * holder keeps this `ui` after the call is over, and a later call can reuse the id.
 */
function describeDialog(method: string, args: readonly unknown[], ownerToolCallId?: string): UserWaitFrame {
	const generic = genericDialogLabel(method);
	const declared = declaredKind(args);
	const declaredCall = declaredToolCallId(args);
	const ownerExecution =
		declaredCall === undefined && ownerToolCallId !== undefined
			? toolExecutionOnChain(undefined, ownerToolCallId)
			: undefined;
	const call =
		declaredCall !== undefined
			? { toolCallId: declaredCall }
			: ownerExecution
				? { toolCallExecution: ownerExecution }
				: {};
	if (method === "approve") {
		const prompt = args[0];
		const compact = isRecord(prompt) ? prompt.compact : undefined;
		const full = isRecord(prompt) ? prompt.full : undefined;
		const text = typeof compact === "string" && compact.length > 0 ? compact : full;
		return {
			prompt: typeof text === "string" && text.length > 0 ? text : generic,
			kind: "permission",
			...call,
		};
	}
	if (method === "askDialog") {
		const questions = Array.isArray(args[0]) ? args[0] : [];
		const asked = questions
			.map(question => (isRecord(question) && typeof question.question === "string" ? question.question : ""))
			.filter(question => question.length > 0)
			.join(" ");
		return { prompt: asked.length > 0 ? asked : generic, kind: declared ?? "question", ...call };
	}
	const title = args[0];
	return {
		prompt: typeof title === "string" && title.length > 0 ? title : generic,
		kind: declared ?? "question",
		...call,
	};
}

/**
 * `ui` with each dialog run through `track`, unless its options give it a deadline (`ask.timeout`): such a dialog
 * settles on its own and the agent goes on, possibly with nobody at the machine, so its time stays the agent's. Every
 * other member passes through. Members are read from `ui` on every access, so one it replaces later is the one called.
 *
 * `toolCallId` is the call this `ui` was handed to, when it belongs to one: every dialog it raises names the run of
 * that call it is being raised inside, unless the call declares a call of its own, so a surface tracking the call
 * learns when its own dialog settles. A dialog raised with no such run on its chain — from a `ui` kept past the
 * call, or from a callback that lost the context — names nothing, and a `ui` shared by the whole session never
 * names a call at all.
 */
export function trackUserWaits(
	ui: ExtensionUIContext,
	track: UserWaitTracker,
	toolCallId?: string,
): ExtensionUIContext {
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
							: track(() => value.apply(target, args), describeDialog(String(property), args, toolCallId))
				: value.bind(target);
			methods.set(property, { value: value as Method, method });
			return method;
		},
	});
}
