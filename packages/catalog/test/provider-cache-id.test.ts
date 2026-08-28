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
		{ providerId: "command-code", baseUrl: "https://command-code.example/provider/v1/" },
		{ providerId: "litellm", baseUrl: "http://litellm.example:4100/v1" },
		{ providerId: "ollama", baseUrl: "http://ollama.example:11434/v1/" },
		{ providerId: "opencode-go", baseUrl: "https://opencode.example/go" },
		{ providerId: "opencode-zen", baseUrl: "https://opencode.example/zen/v1/" },
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

test("command-code cache scope follows the normalized discovery endpoint", () => {
	const teamA = resolveModelCacheProviderId("command-code", {
		apiKey: "team-a-key",
		baseUrl: "https://proxy.example/team-a/provider/v1/",
	});
	expect(teamA).toBe(
		resolveModelCacheProviderId("command-code", {
			apiKey: "team-a-key",
			baseUrl: "https://proxy.example/team-a/provider",
		}),
	);
	expect(teamA).not.toBe(
		resolveModelCacheProviderId("command-code", {
			apiKey: "team-a-key",
			baseUrl: "https://proxy.example/team-b/provider/v1",
		}),
	);
	expect(teamA).not.toBe(
		resolveModelCacheProviderId("command-code", {
			apiKey: "team-b-key",
			baseUrl: "https://proxy.example/team-a/provider/v1",
		}),
	);
	expect(isCredentialScopedModelCacheProvider("command-code")).toBe(true);
});
