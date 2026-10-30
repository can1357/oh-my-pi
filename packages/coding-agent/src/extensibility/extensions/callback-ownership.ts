import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import type { ExtensionCallbackOwner } from "./types";

/**
 * Which session registered a provider configuration.
 *
 * The configuration an extension passes to `pi.registerProvider` travels from the runtime's queue
 * to `ModelRegistry` through whichever drain the host happens to use, and ownership has to arrive
 * with it. It cannot be carried ON the object: a provider is whatever its author wrote — frozen,
 * callable, built from getters, a class instance with private fields — and four rounds of review
 * each broke a different one of those shapes by wrapping, copying or extending it. A getter
 * evaluated merely to find a callback had already run the author's code before any wrapper
 * existed.
 *
 * So the object is left exactly as it was handed over and the association is kept beside it. The
 * registry looks the owner up here when its caller did not pass one, builds a {@link ProviderCallGate}
 * from it, and the places that actually CALL a provider ask that gate first.
 */
const providerConfigOwners = new WeakMap<object, ExtensionCallbackOwner>();

/** Records the session a provider configuration was registered by. */
export function rememberProviderConfigOwner(config: object, owner: ExtensionCallbackOwner): void {
	providerConfigOwners.set(config, owner);
}

/** The session a provider configuration was registered by, if an extension registered it. */
export function providerConfigOwner(config: object): ExtensionCallbackOwner | undefined {
	return providerConfigOwners.get(config);
}

const gatesByOwner = new WeakMap<ExtensionCallbackOwner, ProviderCallGate>();

/** The lifetime a registry hands to the provider entries this session registered. Reads the
 *  owner's state live rather than a snapshot — retirement happens between registration and call
 *  — and is the SAME object every time for one session, because the registries use it to tell
 *  one session's entries from another's when a registration is replaced or withdrawn. */
export function providerCallGate(owner: ExtensionCallbackOwner): ProviderCallGate {
	const existing = gatesByOwner.get(owner);
	if (existing) return existing;
	const gate: ProviderCallGate = {
		get retired(): boolean {
			return owner.isRetired;
		},
		run: <R>(call: () => R): R => owner.runOwned(call),
	};
	gatesByOwner.set(owner, gate);
	return gate;
}
