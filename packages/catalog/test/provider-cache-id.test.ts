import { expect, test } from "bun:test";
import {
	isCredentialScopedModelCacheProvider,
	PROVIDER_DESCRIPTORS,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models";

test("lightweight cache resolver matches every descriptor default", () => {
	for (const descriptor of PROVIDER_DESCRIPTORS) {
		const options = descriptor.createModelManagerOptions({});
		expect(resolveModelCacheProviderId(descriptor.providerId)).toBe(options.cacheProviderId ?? descriptor.providerId);
	}
});

test("lightweight cache resolver matches scoped descriptor inputs", () => {
	const cases = [
		{ providerId: "aki-io", baseUrl: "https://aki.example/v1" },
		{ providerId: "cortecs", baseUrl: "https://cortecs.example/v1" },
		{ providerId: "eurouter", baseUrl: "https://eurouter.example/v1" },
		{ providerId: "litellm", baseUrl: "http://litellm.example:4100/v1" },
		{ providerId: "melious", baseUrl: "https://melious.example/v1" },
		{ providerId: "nebius", baseUrl: "https://nebius.example/v1" },
		{ providerId: "opper", baseUrl: "https://opper.example/v1" },
		{ providerId: "ovhcloud", baseUrl: "https://ovhcloud.example/v1" },
		{ providerId: "ollama", baseUrl: "http://ollama.example:11434/v1/" },
		{ providerId: "opencode-go", baseUrl: "https://opencode.example/go" },
		{ providerId: "opencode-zen", baseUrl: "https://opencode.example/zen/v1/" },
		{ providerId: "scaleway", baseUrl: "https://scaleway.example/v1" },
		{ providerId: "vllm", baseUrl: "http://vllm.example:8000/v1" },
	] as const;
	for (const { providerId, baseUrl } of cases) {
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === providerId);
		if (!descriptor) throw new Error(`Missing descriptor for ${providerId}`);
		const config = { apiKey: "cache-test-key", baseUrl };
		const options = descriptor.createModelManagerOptions(config);
		expect(resolveModelCacheProviderId(providerId, config)).toBe(options.cacheProviderId ?? providerId);
	}
});

test("ollama cache scope preserves reverse-proxy path prefixes", () => {
	const teamA = resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a/v1/" });
	expect(teamA).toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a" }));
	expect(teamA).toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a/" }));
	expect(teamA).not.toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-b/v1" }));
});

test("European gateway caches are scoped by credential and endpoint", () => {
	for (const providerId of ["aki-io", "cortecs", "eurouter", "melious", "nebius", "opper", "ovhcloud", "scaleway"]) {
		const accountA = resolveModelCacheProviderId(providerId, {
			apiKey: "account-a-key",
			baseUrl: "https://gateway.example/v1",
		});
		const accountB = resolveModelCacheProviderId(providerId, {
			apiKey: "account-b-key",
			baseUrl: "https://gateway.example/v1",
		});

		expect(isCredentialScopedModelCacheProvider(providerId)).toBe(true);
		expect(accountA).not.toBe(accountB);
	}
});
