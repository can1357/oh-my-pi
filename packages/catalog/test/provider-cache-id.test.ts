import { expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS, resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { openaiCodexModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";

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

test("cursor cache scope isolates account catalogs without exposing credentials", () => {
	const accountA = resolveModelCacheProviderId("cursor", {
		apiKey: "cursor-account-a",
		baseUrl: "https://api2.cursor.sh/",
	});
	expect(accountA).toBe(
		resolveModelCacheProviderId("cursor", {
			apiKey: "cursor-account-a",
			baseUrl: "https://api2.cursor.sh",
		}),
	);
	expect(accountA).not.toBe(
		resolveModelCacheProviderId("cursor", {
			apiKey: "cursor-account-b",
			baseUrl: "https://api2.cursor.sh",
		}),
	);
	expect(accountA).not.toBe(
		resolveModelCacheProviderId("cursor", {
			apiKey: "cursor-account-a",
			baseUrl: "https://cursor-proxy.example",
		}),
	);
	expect(accountA).not.toContain("cursor-account-a");
	expect(accountA).not.toContain("api2.cursor.sh");
});

test("cursor cache scope survives access-token refresh for the same account", () => {
	const jwt = (claims: Record<string, unknown>): string =>
		`${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
	const scope = (apiKey: string): string =>
		resolveModelCacheProviderId("cursor", { apiKey, baseUrl: "https://api2.cursor.sh" });
	const before = scope(jwt({ sub: "auth0|user_a", exp: 1_900_000_000, iat: 1_800_000_000 }));
	expect(scope(jwt({ sub: "auth0|user_a", exp: 1_900_086_400, iat: 1_800_086_400 }))).toBe(before);
	expect(scope(jwt({ sub: "auth0|user_b", exp: 1_900_000_000, iat: 1_800_000_000 }))).not.toBe(before);
});

test("Codex cache scope follows a gateway baseUrl but keeps the official namespace (#13830)", () => {
	const official = resolveModelCacheProviderId("openai-codex");
	// Pre-existing official caches stay readable whether or not the registry passes the bundled baseUrl.
	expect(resolveModelCacheProviderId("openai-codex", { baseUrl: "https://chatgpt.com/backend-api/" })).toBe(official);
	const gateway = openaiCodexModelManagerOptions({ baseUrl: "https://codex-proxy.example/backend-api" });
	expect(gateway.cacheProviderId).toBe(
		resolveModelCacheProviderId("openai-codex", { baseUrl: "https://codex-proxy.example/backend-api/" }),
	);
	expect(gateway.cacheProviderId).not.toBe(official);
});
