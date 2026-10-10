import { types as utilTypes } from "node:util";
import { classify, Flag, is, ModelSelectionError } from "../error";
import type { StreamOptions } from "../types";

type SelectionOptions = Pick<StreamOptions, "preserveModelSelection" | "preserveThinkingEffort">;

/** Do not assimilate governed synchronous payloads before their encoding guard can inspect them. */
export function shouldAwaitPayloadHookResult(value: unknown, governed: boolean): boolean {
	return !governed || utilTypes.isPromise(value);
}

function assertInertRequestData(value: unknown, protobuf: boolean): void {
	if (!protobuf) {
		for (const owner of [Object.prototype, Array.prototype]) {
			const serializer = Object.getOwnPropertyDescriptor(owner, "toJSON");
			if (serializer && (!Object.hasOwn(serializer, "value") || serializer.value !== undefined)) {
				throw new ModelSelectionError("Governed provider requests cannot inherit a custom JSON serializer.");
			}
		}
	}
	const visited = new WeakSet<object>();
	const active = new WeakSet<object>();
	const visit = (current: unknown): void => {
		if (current === null || current === undefined) return;
		if (typeof current !== "object") {
			if (
				typeof current === "function" ||
				typeof current === "symbol" ||
				(typeof current === "bigint" && !protobuf)
			) {
				throw new ModelSelectionError("Governed provider requests require inert encoded values.");
			}
			return;
		}
		if (utilTypes.isProxy(current)) {
			throw new ModelSelectionError("Governed provider requests cannot use proxy-controlled encoding.");
		}
		if (active.has(current)) throw new ModelSelectionError("Governed provider requests cannot contain cyclic JSON.");
		if (visited.has(current)) return;
		const prototype = Object.getPrototypeOf(current);
		if (protobuf && current instanceof Uint8Array) {
			if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) {
				throw new ModelSelectionError("Governed protobuf requests require native byte arrays.");
			}
			for (const key of Reflect.ownKeys(current)) {
				const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
				const index = typeof key === "string" ? Number(key) : -1;
				if (
					typeof key !== "string" ||
					!Number.isInteger(index) ||
					index < 0 ||
					String(index) !== key ||
					!Object.hasOwn(descriptor, "value") ||
					typeof descriptor.value !== "number"
				) {
					throw new ModelSelectionError("Governed protobuf bytes cannot override native accessors or methods.");
				}
			}
			visited.add(current);
			return;
		}
		if (
			prototype !== Object.prototype &&
			prototype !== null &&
			!(Array.isArray(current) && prototype === Array.prototype)
		) {
			throw new ModelSelectionError("Governed provider requests cannot use custom JSON serializers or prototypes.");
		}
		active.add(current);
		for (const key of Object.getOwnPropertyNames(current)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
			if (!Object.hasOwn(descriptor, "value")) {
				throw new ModelSelectionError("Governed provider requests cannot use stateful JSON accessors.");
			}
			if (key === "toJSON" && descriptor.value !== undefined) {
				throw new ModelSelectionError("Governed provider requests cannot replace their encoded JSON.");
			}
			if (
				protobuf &&
				key === "$unknown" &&
				descriptor.value !== undefined &&
				(!Array.isArray(descriptor.value) || descriptor.value.length !== 0)
			) {
				throw new ModelSelectionError("Governed protobuf requests cannot inject unknown wire fields.");
			}
			if (descriptor.enumerable) visit(descriptor.value);
		}
		active.delete(current);
		visited.add(current);
	};
	visit(value);
}

function rejectEncoding(message: string, cause: unknown): never {
	if (is(classify(cause), Flag.HostAdmission)) throw cause;
	throw new ModelSelectionError(message, { cause });
}

/** Governed JSON must not execute user code while its protected controls are captured. */
export function assertSafeGovernedJson(value: unknown): void {
	try {
		assertInertRequestData(value, false);
	} catch (cause) {
		rejectEncoding("The governed JSON request cannot be safely encoded.", cause);
	}
}

/** Protobuf has inert native byte/bigint scalars, but unknown fields can override known controls. */
export function assertSafeGovernedProtobuf(value: unknown): void {
	try {
		assertInertRequestData(value, true);
	} catch (cause) {
		rejectEncoding("The governed protobuf request cannot be safely encoded.", cause);
	}
}

/** The provider owns the model/effort dialect projected from its request. */
export function createRequestSelectionGuard<T>(
	options: SelectionOptions | undefined,
	payload: T,
	project: (payload: T) => unknown,
): ((serialized: string) => void) | undefined {
	if (!options?.preserveModelSelection && !options?.preserveThinkingEffort) return undefined;
	assertSafeGovernedJson(payload);
	let expected: string | undefined;
	try {
		const selected = project(payload);
		assertSafeGovernedJson(selected);
		expected = JSON.stringify(selected);
	} catch (cause) {
		rejectEncoding("The provider cannot project its governed request controls.", cause);
	}
	return serialized => {
		try {
			const encoded = JSON.parse(serialized) as T;
			const selected = project(encoded);
			assertSafeGovernedJson(selected);
			if (JSON.stringify(selected) !== expected) {
				throw new ModelSelectionError(
					"The encoded provider request changed the approved model or fixed thinking effort.",
				);
			}
		} catch (cause) {
			rejectEncoding("The encoded provider request has invalid governed controls.", cause);
		}
	};
}

/** Capture once, check that capture, and give the transport those exact bytes. */
export function serializeRequestBody(
	payload: unknown,
	options?: SelectionOptions,
	guard?: (serialized: string) => void,
): string {
	const governed = !!guard || options?.preserveModelSelection === true || options?.preserveThinkingEffort === true;
	try {
		if (governed) assertSafeGovernedJson(payload);
		const serialized = JSON.stringify(payload);
		if (serialized === undefined) {
			if (governed) throw new ModelSelectionError("The governed provider request has no JSON envelope.");
			throw new TypeError("The provider request has no JSON envelope.");
		}
		guard?.(serialized);
		return serialized;
	} catch (cause) {
		if (governed) rejectEncoding("The governed provider request cannot be encoded.", cause);
		throw cause;
	}
}

/** A trusted admission callback may reject a send, never become a provider retry. */
export async function invokeBeforeRequest(callback: StreamOptions["onBeforeRequest"] | undefined): Promise<void> {
	if (!callback) return;
	try {
		await callback();
	} catch (cause) {
		const errorId = classify(cause);
		if (is(errorId, Flag.HostAdmission) || is(errorId, Flag.Abort) || is(errorId, Flag.UserInterrupt)) throw cause;
		throw new ModelSelectionError("The host rejected the inference attempt during re-admission.", { cause });
	}
}
