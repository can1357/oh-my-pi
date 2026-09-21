import type { AuthStorage } from "../session/auth-storage";
import { raceAbortSignal, withTimeout } from "./action-utils";
import { discoverOAuthEndpoints, type OAuthEndpoints } from "./oauth-discovery";
import { MCPOAuthFlow, mcpOAuthCredentialId, type MCPStoredOAuthCredential } from "./oauth-flow";

export interface MCPInteractiveOAuthInteraction {
	onAuthorization(info: { url: string; launchUrl?: string; instructions?: string }): void;
	onProgress(message: string): void;
	requestManualInput(signal: AbortSignal): Promise<string>;
	onComplete(): void;
}

export interface MCPInteractiveOAuthOptions {
	serverName: string;
	serverUrl?: string;
	configured: {
		clientId?: string;
		clientSecret?: string;
		scope?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		prompt?: string;
	};
	oauthEndpoints?: OAuthEndpoints;
	resource?: string;
	stripSameOriginResource?: boolean;
	authStorage: AuthStorage;
	interaction: MCPInteractiveOAuthInteraction;
	owner: object;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface MCPInteractiveOAuthResult {
	credentials: MCPStoredOAuthCredential;
	credentialId: string;
}

export class MCPOAuthCancelledError extends Error {
	constructor(message = "MCP OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

interface ActiveMCPOAuthFlow {
	cancel(reason: string): void;
	completion: Promise<void>;
	complete(): void;
}

interface MCPOAuthFlowCoordinator {
	active?: ActiveMCPOAuthFlow;
	transition: Promise<void>;
}

const mcpOAuthCoordinators = new WeakMap<object, MCPOAuthFlowCoordinator>();

async function claimMcpOAuthFlow(owner: object, cancel: (reason: string) => void): Promise<() => void> {
	let coordinator = mcpOAuthCoordinators.get(owner);
	if (!coordinator) {
		coordinator = { transition: Promise.resolve() };
		mcpOAuthCoordinators.set(owner, coordinator);
	}
	const precedingTransition = coordinator.transition;
	const transition = Promise.withResolvers<void>();
	coordinator.transition = transition.promise;
	await precedingTransition;
	try {
		if (coordinator.active) {
			coordinator.active.cancel("MCP OAuth flow superseded by a new request");
			await coordinator.active.completion;
		}
		const completion = Promise.withResolvers<void>();
		const active: ActiveMCPOAuthFlow = {
			cancel,
			completion: completion.promise,
			complete: completion.resolve,
		};
		coordinator.active = active;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (coordinator.active === active) coordinator.active = undefined;
			active.complete();
		};
	} finally {
		transition.resolve();
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "MCPOAuthCancelledError");
}

export async function runMCPInteractiveOAuth(options: MCPInteractiveOAuthOptions): Promise<MCPInteractiveOAuthResult> {
	const {
		serverName,
		serverUrl,
		configured,
		oauthEndpoints,
		resource,
		stripSameOriginResource,
		authStorage,
		interaction,
		owner,
		signal,
		timeoutMs = 5 * 60 * 1000,
	} = options;
	if (signal?.aborted) throw new MCPOAuthCancelledError();

	const endpoints =
		oauthEndpoints ?? (serverUrl ? await raceAbortSignal(discoverOAuthEndpoints(serverUrl), signal) : undefined);
	if (!endpoints) throw new Error(`Could not discover OAuth endpoints for ${serverName}`);
	const flowAbort = new AbortController();
	let cancellationRequested = false;
	const abortFlow = (reason: string): void => {
		if (flowAbort.signal.aborted) return;
		cancellationRequested = true;
		flowAbort.abort(new MCPOAuthCancelledError(reason));
	};
	const releaseFlow = await claimMcpOAuthFlow(owner, abortFlow);
	const onExternalAbort = () => abortFlow("MCP OAuth flow cancelled");
	if (signal?.aborted) onExternalAbort();
	else signal?.addEventListener("abort", onExternalAbort, { once: true });

	const flow = new MCPOAuthFlow(
		{
			authorizationUrl: endpoints.authorizationUrl,
			tokenUrl: endpoints.tokenUrl,
			issuerUrl: endpoints.issuerUrl,
			registrationUrl: endpoints.registrationUrl,
			clientId: configured.clientId ?? endpoints.clientId,
			clientSecret: configured.clientSecret,
			scopes: configured.scope ?? endpoints.scopes,
			prompt: configured.prompt,
			redirectUri: configured.redirectUri,
			callbackPort: configured.callbackPort,
			callbackPath: configured.callbackPath,
			resource: resource ?? endpoints.resource,
			stripSameOriginResource,
		},
		{
			onAuth: info => interaction.onAuthorization(info),
			onProgress: message => interaction.onProgress(message),
			onManualCodeInput: () => interaction.requestManualInput(flowAbort.signal),
			signal: flowAbort.signal,
		},
	);

	try {
		const credentials = await withTimeout(
			raceAbortSignal(flow.login(), flowAbort.signal),
			timeoutMs,
			"OAuth flow timed out after 5 minutes",
			() => flowAbort.abort(new Error("OAuth flow timed out after 5 minutes")),
		);
		const credentialId = serverUrl
			? mcpOAuthCredentialId(serverUrl)
			: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
		const storedCredential: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl: endpoints.tokenUrl,
			clientId: flow.resolvedClientId?.trim() || configured.clientId || endpoints.clientId,
			clientSecret: flow.registeredClientSecret ?? configured.clientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};
		await authStorage.set(credentialId, storedCredential);
		return { credentials: storedCredential, credentialId };
	} catch (error) {
		if (cancellationRequested || signal?.aborted || isAbortError(error)) throw new MCPOAuthCancelledError();
		throw error;
	} finally {
		signal?.removeEventListener("abort", onExternalAbort);
		releaseFlow();
		interaction.onComplete();
	}
}
