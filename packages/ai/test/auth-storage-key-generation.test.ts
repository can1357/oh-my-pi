import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

/**
 * `keys.generation(provider)` tells a caller that resolved a key whether the
 * overrides deciding it changed since. It must move on every real change,
 * including one undone again, and stay put for writes that change nothing,
 * or the model registry would refuse discoveries it has no reason to.
 */
describe("AuthStorage key generation", () => {
	let storage: AuthStorage;

	beforeEach(async () => {
		storage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	it("counts each change to a provider's runtime key, config key and fallback, and only that provider's", () => {
		const start = storage.keys.generation("alpha");
		const other = storage.keys.generation("beta");
		storage.keys.setRuntime("alpha", "runtime-key");
		storage.keys.removeRuntime("alpha");
		storage.keys.setConfig("alpha", "config-key");
		storage.keys.setConfig("alpha", "config-key", { fallback: true });
		storage.keys.removeConfig("alpha");
		// A change and its undo are two changes: the counter never returns to a value it held.
		expect(storage.keys.generation("alpha")).toBe(start + 5);
		expect(storage.keys.generation("beta")).toBe(other);
	});

	it("does not count a write that leaves the provider's overrides as they were", () => {
		storage.keys.setRuntime("alpha", "runtime-key");
		storage.keys.setConfig("alpha", "config-key");
		const before = storage.keys.generation("alpha");
		storage.keys.setRuntime("alpha", "runtime-key");
		storage.keys.setConfig("alpha", "config-key");
		storage.keys.removeRuntime("beta");
		storage.keys.removeConfig("beta");
		expect(storage.keys.generation("alpha")).toBe(before);
		expect(storage.keys.generation("beta")).toBe(0);
	});

	it("counts a batch once per provider it changed and not at all for one it restored", () => {
		storage.keys.setConfig("alpha", "alpha-key");
		storage.keys.setConfig("beta", "beta-key");
		const alpha = storage.keys.generation("alpha");
		const beta = storage.keys.generation("beta");
		storage.keys.batch(() => {
			storage.keys.clearConfig();
			storage.keys.setConfig("alpha", "alpha-key");
			storage.keys.setConfig("beta", "beta-key-2");
			storage.keys.setRuntime("beta", "beta-runtime");
		});
		expect(storage.keys.generation("alpha")).toBe(alpha);
		expect(storage.keys.generation("beta")).toBe(beta + 1);
	});

	it("counts a config-value resolver swap for every provider, and a reinstall of the same resolver for none", () => {
		const resolver = async (config: string) => config;
		storage.keys.setResolver(resolver);
		const alpha = storage.keys.generation("alpha");
		const unseen = storage.keys.generation("never-configured");
		storage.keys.setResolver(resolver);
		expect(storage.keys.generation("alpha")).toBe(alpha);
		storage.keys.setResolver(async config => `${config}-resolved`);
		expect(storage.keys.generation("alpha")).toBe(alpha + 1);
		expect(storage.keys.generation("never-configured")).toBe(unseen + 1);
	});
});
