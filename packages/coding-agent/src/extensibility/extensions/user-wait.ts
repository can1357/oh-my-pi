import { isRecord } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "./types";

/** Runs a dialog that waits for the user's answer, so its session can treat the time as the user's, not the agent's. */
export type UserWaitTracker = <T>(dialog: () => Promise<T>) => Promise<T>;

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

/** The host's UI behind each wrapper {@link trackUserWaits} made. */
const hostUIs = new WeakMap<object, ExtensionUIContext>();

/**
 * The host's own UI `ui` stands for: `ui` itself, or — for a wrapper {@link trackUserWaits} made, one
 * per runner — the UI it wraps. Two runners over one host UI hold it through two wrappers, and what
 * one session set on it must be recognized as set on the same UI the other session writes to.
 */
export function hostUIOf(ui: ExtensionUIContext): ExtensionUIContext {
	return hostUIs.get(ui) ?? ui;
}

/**
 * `ui` with each dialog run through `track`, unless its options give it a deadline (`ask.timeout`): such a dialog
 * settles on its own and the agent goes on, possibly with nobody at the machine, so its time stays the agent's. Every
 * other member passes through. Members are read from `ui` on every access, so one it replaces later is the one called.
 */
export function trackUserWaits(ui: ExtensionUIContext, track: UserWaitTracker): ExtensionUIContext {
	// Wrappers keep their identity while the member they wrap does.
	const methods = new Map<PropertyKey, { value: Method; method: Method }>();
	const wrapper = new Proxy(ui, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const cached = methods.get(property);
			if (cached?.value === value) return cached.method;
			const method: Method = Object.hasOwn(DIALOGS, property)
				? (...args) =>
						args.some(arg => isRecord(arg) && typeof arg.timeout === "number" && arg.timeout > 0)
							? value.apply(target, args)
							: track(() => value.apply(target, args))
				: value.bind(target);
			methods.set(property, { value: value as Method, method });
			return method;
		},
	});
	hostUIs.set(wrapper, hostUIOf(ui));
	return wrapper;
}
