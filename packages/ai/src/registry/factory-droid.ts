import type { ProviderTransport } from "./build";

/**
 * Factory Droid (Droid Core subscription).
 *
 * Single credential path: `/login factory-droid` runs the WorkOS device-code
 * flow over the public Droid client (the `custom` login/refresh hooks in
 * `rules/auth/factory-droid.kdl`), stored in OMP's auth storage and refreshed
 * through WorkOS.
 */
export const factoryDroidTransport = {
	mapSimpleOptions: options => ({ reasoning: options.reasoning, cwd: options.cwd }),
} as const satisfies ProviderTransport;
