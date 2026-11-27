/**
 * Process-wide per-provider in-flight request limits and cross-process slot broker.
 *
 * Kept in a zero-dependency leaf module so settings registration can configure
 * limits and install a broker without importing `@oh-my-pi/pi-ai/stream`.
 */

/**
 * Admits a request to a provider against the requests of other processes
 * that share its limit (`maxInFlightRequests`). pi-ai bounds each process on
 * its own; a host running several processes installs one with
 * {@link configureProviderSlotBroker} (coding-agent: through its daemon).
 */
export interface ProviderSlotBroker {
	/**
	 * Resolve with the slot's release once fewer than `limit` requests to
	 * `provider` run across processes. Rejects with the abort reason when
	 * `signal` aborts first. The release never throws.
	 */
	acquire(provider: string, limit: number, signal?: AbortSignal): Promise<() => void>;
}

let configuredProviderMaxInFlightRequests: Record<string, number> = {};
let providerSlotBroker: ProviderSlotBroker | undefined;

export function configureProviderMaxInFlightRequests(limits: Record<string, number> | undefined): void {
	configuredProviderMaxInFlightRequests = limits ?? {};
}

/** Share in-flight limits across processes through `broker`; `undefined` keeps them per process. */
export function configureProviderSlotBroker(broker: ProviderSlotBroker | undefined): void {
	providerSlotBroker = broker;
}

/** @internal */
export function getConfiguredProviderMaxInFlightRequests(): Record<string, number> {
	return configuredProviderMaxInFlightRequests;
}

/** @internal */
export function getProviderSlotBroker(): ProviderSlotBroker | undefined {
	return providerSlotBroker;
}
