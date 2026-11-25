import { afterEach, describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const OAUTH_HOST_ENV = [
	"KIMI_CODE_OAUTH_HOST",
	"KIMI_OAUTH_HOST",
	"KIMI_GLOBAL_OAUTH_HOST",
	"KIMI_GLOBAL_AUTH_HOST",
] as const;
const ORIGINAL_OAUTH_HOST_ENV = Object.fromEntries(OAUTH_HOST_ENV.map(name => [name, Bun.env[name]]));

function restoreOAuthHostEnv(): void {
	for (const name of OAUTH_HOST_ENV) {
		const value = ORIGINAL_OAUTH_HOST_ENV[name];
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
}

function clearOAuthHostEnv(): void {
	for (const name of OAUTH_HOST_ENV) delete Bun.env[name];
}

async function firstDeviceAuthorizationUrl(provider: "kimi-code" | "kimi-code-global"): Promise<string> {
	const login = getProviderDefinition(provider)?.login;
	if (!login) throw new Error(`${provider} has no built-in device OAuth login`);

	const requests: string[] = [];
	const fetch: FetchImpl = async input => {
		requests.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
		// One failing device response stops before polling; the request URL is the
		// registry-resolved authorization host under test.
		return new Response("{}", { status: 500 });
	};
	await login({ fetch }).catch(() => undefined);
	if (requests.length !== 1) throw new Error(`${provider} made ${requests.length} device authorization requests`);
	return requests[0]!;
}

afterEach(restoreOAuthHostEnv);

describe("Kimi Code regional OAuth registry", () => {
	it("uses the built-in mainland and global device authorization hosts by default", async () => {
		clearOAuthHostEnv();
		expect(await firstDeviceAuthorizationUrl("kimi-code")).toBe(
			"https://auth.kimi.com/api/oauth/device_authorization",
		);
		expect(await firstDeviceAuthorizationUrl("kimi-code-global")).toBe(
			"https://auth.kimi.ai/api/oauth/device_authorization",
		);
	});

	it("lets the global provider honor shared and global-specific OAuth host aliases in order", async () => {
		clearOAuthHostEnv();
		Bun.env.KIMI_CODE_OAUTH_HOST = "https://shared-code-override.example";
		Bun.env.KIMI_OAUTH_HOST = "https://shared-legacy-override.example";
		Bun.env.KIMI_GLOBAL_OAUTH_HOST = "https://global-override.example";
		Bun.env.KIMI_GLOBAL_AUTH_HOST = "https://global-auth-override.example";
		expect(await firstDeviceAuthorizationUrl("kimi-code-global")).toBe(
			"https://shared-code-override.example/api/oauth/device_authorization",
		);

		clearOAuthHostEnv();
		Bun.env.KIMI_OAUTH_HOST = "https://shared-legacy-override.example";
		expect(await firstDeviceAuthorizationUrl("kimi-code-global")).toBe(
			"https://shared-legacy-override.example/api/oauth/device_authorization",
		);

		clearOAuthHostEnv();
		Bun.env.KIMI_GLOBAL_OAUTH_HOST = "https://global-override.example";
		Bun.env.KIMI_GLOBAL_AUTH_HOST = "https://global-auth-override.example";
		expect(await firstDeviceAuthorizationUrl("kimi-code-global")).toBe(
			"https://global-override.example/api/oauth/device_authorization",
		);

		clearOAuthHostEnv();
		Bun.env.KIMI_GLOBAL_AUTH_HOST = "https://global-auth-override.example";
		expect(await firstDeviceAuthorizationUrl("kimi-code-global")).toBe(
			"https://global-auth-override.example/api/oauth/device_authorization",
		);
	});

	it("keeps mainland OAuth overrides independent from global-only aliases", async () => {
		clearOAuthHostEnv();
		Bun.env.KIMI_GLOBAL_OAUTH_HOST = "https://global-override.example";
		Bun.env.KIMI_GLOBAL_AUTH_HOST = "https://global-auth-override.example";
		expect(await firstDeviceAuthorizationUrl("kimi-code")).toBe(
			"https://auth.kimi.com/api/oauth/device_authorization",
		);

		Bun.env.KIMI_OAUTH_HOST = "https://mainland-legacy-override.example";
		expect(await firstDeviceAuthorizationUrl("kimi-code")).toBe(
			"https://mainland-legacy-override.example/api/oauth/device_authorization",
		);
	});
});
