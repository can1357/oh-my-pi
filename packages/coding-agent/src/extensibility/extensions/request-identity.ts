import { AsyncLocalStorage } from "node:async_hooks";

export interface ExtensionRequestIdentity {
	readonly identity?: string;
	run<T>(action: () => T): T;
}

interface RuntimeIdentityState {
	readonly storage: AsyncLocalStorage<ExtensionRequestIdentity | undefined>;
	readonly core: ExtensionRequestIdentity;
}

const runtimeIdentities = new WeakMap<object, RuntimeIdentityState>();
const extensionIdentities = new WeakMap<object, { runtime: object; identity: ExtensionRequestIdentity }>();
const EXTENSION_ID_PREFIX = "ext:v1:sha256:";

function identityState(runtime: object): RuntimeIdentityState {
	let state = runtimeIdentities.get(runtime);
	if (state) return state;
	const storage = new AsyncLocalStorage<ExtensionRequestIdentity | undefined>();
	const core: ExtensionRequestIdentity = Object.freeze({
		run<T>(action: () => T): T {
			return storage.run(undefined, action);
		},
	});
	state = { storage, core };
	runtimeIdentities.set(runtime, state);
	return state;
}

/** Bind one host-private extension object to its canonical source identity. */
export function registerExtensionRequestIdentity(runtime: object, extension: object, canonicalPath: string): void {
	const state = identityState(runtime);
	const identity: ExtensionRequestIdentity = Object.freeze({
		identity: `${EXTENSION_ID_PREFIX}${new Bun.CryptoHasher("sha256").update(canonicalPath).digest("hex")}`,
		run<T>(action: () => T): T {
			return state.storage.run(identity, action);
		},
	});
	extensionIdentities.set(extension, { runtime, identity });
}

/** Run host work as one registered extension, or clear attribution for native/core work. */
export function runWithExtensionRequestIdentity<T>(runtime: object, extension: object | undefined, action: () => T): T {
	const registered = extension === undefined ? undefined : extensionIdentities.get(extension);
	if (registered?.runtime === runtime) return registered.identity.run(action);
	return identityState(runtime).core.run(action);
}

/** Capture the current immutable owner for asynchronous host continuations. */
export function captureExtensionRequestIdentity(runtime: object): ExtensionRequestIdentity {
	const state = identityState(runtime);
	return state.storage.getStore() ?? state.core;
}
