/**
 * Wizard endpoint-edit contract: reaching the authorization-URL step again —
 * by any route, including Esc back through the OAuth fields after a successful
 * login or a failed one — invalidates issuer metadata discovered for the
 * previous endpoints. The next flow must not forward a stale `issuerUrl`, which
 * would reject a valid callback against the newly entered server.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { validateServerName } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import * as oauthDiscovery from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import type { AuthDetectionResult } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { MCPAddWizard } from "@oh-my-pi/pi-tui/overlays/mcp-add-wizard";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";
const ISSUER = "https://issuer.example.com";
const AUTH_URL = "https://auth.example.com/authorize";
const TOKEN_URL = "https://auth.example.com/token";
// The connection probe always reports an auth failure, so the post-login health
// check fails too and the wizard takes its 2000 ms scope-selection branch.
const HEALTH_DELAY_MS = 2000;

interface OAuthForwardedOptions {
	issuerUrl?: string;
	issParameterSupported?: boolean;
}

function detectedOAuth(): AuthDetectionResult {
	return {
		requiresAuth: true,
		authType: "oauth",
		oauth: {
			authorizationUrl: AUTH_URL,
			tokenUrl: TOKEN_URL,
			issuerUrl: ISSUER,
			issParameterSupported: true,
			scopes: "read",
		},
	};
}

function createWizard(calls: OAuthForwardedOptions[], fail = false): MCPAddWizard {
	return new MCPAddWizard(
		{
			validateServerName,
			analyzeAuthError: (error, serverUrl) => oauthDiscovery.analyzeAuthError(error, serverUrl),
			discoverOAuthEndpoints: (serverUrl, authServerUrl, resourceMetadataUrl, options) =>
				oauthDiscovery.discoverOAuthEndpoints(serverUrl, authServerUrl, resourceMetadataUrl, options),
			fetchResourceMetadataScopes: resourceMetadataUrl =>
				oauthDiscovery.fetchResourceMetadataScopes(resourceMetadataUrl),
		},
		() => {},
		() => {},
		async (_authUrl, _tokenUrl, _clientId, _clientSecret, _scopes, options) => {
			calls.push(options ?? {});
			if (fail) throw new Error("authorization denied");
			return { credentialId: "cred-1" };
		},
		async () => {
			throw new Error("HTTP 401 Unauthorized");
		},
		undefined,
		"srv",
	);
}

function press(wizard: MCPAddWizard, keys: string[]): void {
	for (const key of keys) wizard.handleInput(key);
}

function type(wizard: MCPAddWizard, text: string): void {
	for (const char of text) wizard.handleInput(char);
}

/** Drain the microtask chain behind the async connect/detect/flow steps. */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Enter the endpoint step and run the flow once, leaving discovery metadata set. */
async function discoverThenRunFlow(wizard: MCPAddWizard): Promise<void> {
	press(wizard, [DOWN, ENTER]);
	type(wizard, "https://mcp.example.com/mcp");
	press(wizard, [ENTER]);
	await settle();
}

/** Esc back to endpoint editing and walk forward to a second OAuth run. */
async function reenterEndpointsAndRerun(wizard: MCPAddWizard, backKeys: string[]): Promise<void> {
	press(wizard, backKeys);
	type(wizard, AUTH_URL);
	press(wizard, [ENTER]);
	type(wizard, TOKEN_URL);
	press(wizard, [ENTER]);
	type(wizard, "client-1");
	press(wizard, [ENTER, ENTER, ENTER]);
	await settle();
}

describe("MCP add wizard issuer metadata", () => {
	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.useFakeTimers();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.spyOn(oauthDiscovery, "analyzeAuthError").mockReturnValue(detectedOAuth());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("drops issuer metadata when Esc re-enters endpoints after a successful login", async () => {
		const calls: OAuthForwardedOptions[] = [];
		const wizard = createWizard(calls);

		await discoverThenRunFlow(wizard);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.issuerUrl).toBe(ISSUER);

		// Success advances to scope selection once the health delay elapses.
		vi.advanceTimersByTime(HEALTH_DELAY_MS);
		await settle();

		// scope -> oauth-scopes -> client-secret -> client-id -> token-url -> auth-url
		await reenterEndpointsAndRerun(wizard, [ESC, ESC, ESC, ESC, ESC]);

		expect(calls).toHaveLength(2);
		expect(calls[1]?.issuerUrl).toBeUndefined();
		expect(calls[1]?.issParameterSupported).toBeUndefined();
	});

	it("drops issuer metadata when Esc re-enters endpoints from the error screen", async () => {
		const calls: OAuthForwardedOptions[] = [];
		const wizard = createWizard(calls, true);

		await discoverThenRunFlow(wizard);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.issuerUrl).toBe(ISSUER);

		await reenterEndpointsAndRerun(wizard, [ESC]);

		expect(calls).toHaveLength(2);
		expect(calls[1]?.issuerUrl).toBeUndefined();
		expect(calls[1]?.issParameterSupported).toBeUndefined();
	});
});
