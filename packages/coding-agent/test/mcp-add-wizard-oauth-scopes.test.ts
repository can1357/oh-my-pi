import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPAddWizard, type MCPAddWizardOAuthResult } from "@oh-my-pi/pi-coding-agent/modes/components/mcp-add-wizard";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

/**
 * Scopes discovery resolves to: RFC 9728 gives the resource's own
 * `scopes_supported` precedence over the authorization server's catalogue.
 */
const DISCOVERED_SCOPES = "https://gateway.example.com/mcp/mcp.invoke";
/** Scopes the user substitutes for them. */
const CHOSEN_SCOPES = "https://gateway.example.com/mcp/mcp.admin openid";

let server: Bun.Server<undefined> | null = null;

beforeEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

afterEach(() => {
	server?.stop(true);
	server = null;
});

/**
 * Serve a metadata pair that gives discovery a definite answer to prefill: the
 * resource advertises one resource-bound scope while its authorization server
 * advertises a tenant-wide list, and discovery resolves to the former. What the
 * wizard must not do is treat that answer as the user's own override.
 */
function startMetadataServer(): string {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const { pathname, origin } = new URL(request.url);
			if (pathname === "/.well-known/oauth-protected-resource") {
				return Response.json({
					resource: `${origin}/mcp`,
					authorization_servers: [origin],
					scopes_supported: ["https://gateway.example.com/mcp/mcp.invoke"],
				});
			}
			if (pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					client_id: "discovered-client",
					scopes_supported: ["openid", "email", "phone", "profile"],
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	return server.url.origin;
}

/**
 * Drive `/mcp add` to the point where the user replaces the scopes discovery
 * chose, then authorizes again.
 *
 * Two things are observable, and losing either one returns the user to the
 * scopes they rejected: the second authorization must carry their scopes as an
 * override (so it also outranks a `scope` embedded in the authorization URL),
 * and the saved config must record them so a later `/mcp reauth` does not fall
 * back to discovery.
 */
test("scopes chosen in the wizard reach the retry and the saved config", async () => {
	const origin = startMetadataServer();

	const oauthCalls: Array<{ scopes: string; scopeOverride: string | undefined }> = [];
	let probeCount = 0;
	let savedConfig: MCPServerConfig | null = null;

	const wizard = new MCPAddWizard(
		(_name, config) => {
			savedConfig = config;
		},
		() => {},
		async (_authUrl, _tokenUrl, _clientId, _clientSecret, scopes, options): Promise<MCPAddWizardOAuthResult> => {
			oauthCalls.push({ scopes, scopeOverride: options?.scopeOverride });
			return { credentialId: "cred-1" };
		},
		async () => {
			// The first probe is the pre-auth connection test; answering it with a
			// resource-metadata challenge is what starts OAuth discovery.
			if (++probeCount === 1) {
				throw new Error(
					`HTTP 401: Unauthorized (WWW-Authenticate: Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource")`,
				);
			}
		},
		() => {},
		"gateway",
	);

	// Transport selector: stdio, http, sse.
	wizard.handleInput(DOWN);
	wizard.handleInput(ENTER);

	for (const char of `${origin}/mcp`) wizard.handleInput(char);
	wizard.handleInput(ENTER);

	await waitFor(() => oauthCalls.length === 1, "the first authorization");
	await waitFor(() => probeCount === 2, "the post-authorization health check");
	// The health check is followed by a pause before the scope step renders.
	await Bun.sleep(1200);

	// Step back from the scope step to the scope-entry field and replace the
	// discovered value, which the wizard prefilled there.
	wizard.handleInput(ESCAPE);
	for (let i = 0; i < DISCOVERED_SCOPES.length; i++) wizard.handleInput(BACKSPACE);
	for (const char of CHOSEN_SCOPES) wizard.handleInput(char);
	wizard.handleInput(ENTER);

	await waitFor(() => oauthCalls.length === 2, "the second authorization");
	await Bun.sleep(1200);

	// Scope selector ("user"), then the confirmation step.
	wizard.handleInput(ENTER);
	wizard.handleInput(ENTER);
	await waitFor(() => savedConfig !== null, "the wizard to save the server");

	// Discovery's own answer is not an override: persisting it would freeze a
	// discovery result into the config file and shadow the server later.
	expect(oauthCalls[0]).toEqual({ scopes: DISCOVERED_SCOPES, scopeOverride: undefined });
	expect(oauthCalls[1]).toEqual({ scopes: CHOSEN_SCOPES, scopeOverride: CHOSEN_SCOPES });
	expect((savedConfig as unknown as MCPServerConfig).oauth?.scopes).toBe(CHOSEN_SCOPES);
	// The wizard paces itself with health-check and confirmation delays, so the
	// full journey outruns the default per-test timeout.
}, 30_000);

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}
