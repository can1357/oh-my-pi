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
		{ providerId: "litellm", baseUrl: "http://litellm.example:4100/v1" },
		{ providerId: "ollama", baseUrl: "http://ollama.example:11434/v1/" },
		{ providerId: "muse-code", baseUrl: "https://api.meta.example/subscriber/v1" },
		{ providerId: "grokbot", baseUrl: "https://sand.example/api/" },
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

test("Muse Code cache scope changes with subscription credentials and endpoints", () => {
	const accountA = resolveModelCacheProviderId("muse-code", {
		apiKey: "account-a-key",
		baseUrl: "https://api.meta.ai/v1",
	});
	expect(accountA).not.toBe(
		resolveModelCacheProviderId("muse-code", {
			apiKey: "account-b-key",
			baseUrl: "https://api.meta.ai/v1",
		}),
	);
	expect(accountA).not.toBe(
		resolveModelCacheProviderId("muse-code", {
			apiKey: "account-a-key",
			baseUrl: "https://proxy.example/meta/v1",
		}),
	);
});

test("Grok Bot cache scope isolates structured OAuth credentials and effective endpoints", () => {
	const accountA = JSON.stringify({ renewal: "renewal-a", machineId: "machine-a" });
	const accountB = JSON.stringify({ renewal: "renewal-b", machineId: "machine-b" });
	const endpoint = "https://sand.example/api";
	const scoped = resolveModelCacheProviderId("grokbot", { apiKey: accountA, baseUrl: `${endpoint}/` });

	expect(isCredentialScopedModelCacheProvider("grokbot")).toBe(true);
	expect(scoped).toBe(resolveModelCacheProviderId("grokbot", { apiKey: accountA, baseUrl: endpoint }));
	expect(scoped).not.toBe(resolveModelCacheProviderId("grokbot", { apiKey: accountB, baseUrl: endpoint }));
	expect(scoped).not.toBe(
		resolveModelCacheProviderId("grokbot", { apiKey: accountA, baseUrl: "https://other.example/api" }),
	);

	const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === "grokbot");
	if (!descriptor) throw new Error("Missing Grok Bot descriptor");
	expect(descriptor.createModelManagerOptions({ apiKey: accountA, baseUrl: `${endpoint}/` }).cacheProviderId).toBe(
		scoped,
	);
});

test("canonical-reference consumers invalidate pre-isolation cache rows", () => {
	for (const providerId of ["gmi-cloud", "siliconflow", "siliconflow-cn"]) {
		expect(resolveModelCacheProviderId(providerId)).toBe(`${providerId}:models-v1`);
	}
});

test("ollama cache scope preserves reverse-proxy path prefixes", () => {
	const teamA = resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a/v1/" });
	expect(teamA).toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a" }));
	expect(teamA).toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a/" }));
	expect(teamA).not.toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-b/v1" }));
});
