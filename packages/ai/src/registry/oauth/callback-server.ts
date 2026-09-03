/**
 * Abstract base class for OAuth flows with local callback servers.
 *
 * Handles:
 * - Port allocation (tries expected port, falls back to random)
 * - Callback server setup and request handling
 * - Common OAuth flow logic
 *
 * Providers extend this and implement:
 * - generateAuthUrl(): Build provider-specific authorization URL
 * - exchangeToken(): Exchange authorization code for tokens
 */
import * as os from "node:os";
import * as AIError from "../../error";
import templateHtml from "./oauth.html" with { type: "text" };
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_HOSTNAME = "localhost";
const CALLBACK_PATH = "/callback";
const IPV4_LOOPBACK = "127.0.0.1";
const IPV6_LOOPBACK = "::1";
/**
 * How many times a random-port bind may be redrawn when the ephemeral port it
 * landed on is already held on {@link IPV6_LOOPBACK} by that exact address.
 * Small on purpose: each redraw picks a fresh port, so a repeat collision is
 * vanishingly unlikely.
 */
const IPV6_COMPANION_ATTEMPTS = 4;
/**
 * Path served by {@link OAuthCallbackFlow} that 302-redirects to the pending
 * authorization URL. Kept out of {@link OAuthCallbackFlowOptions} because it
 * lives on the loopback callback server alongside {@link CALLBACK_PATH} and
 * must never clash with a provider-registered redirect URI (all known
 * providers register `/callback`-shaped paths).
 */
const LAUNCH_PATH = "/launch";

export type CallbackResult = { code: string; state: string };

/**
 * Subset of {@link Bun.Server} this flow depends on, so a `localhost` flow can
 * hand back one listener per loopback address family while still looking like a
 * single server to callers.
 */
interface CallbackServer {
	readonly port: Bun.Server<unknown>["port"];
	stop: Bun.Server<unknown>["stop"];
}

/**
 * Whether a failed bind means "another process already holds this port".
 * Bun surfaces `EADDRINUSE` on the error's `code` where the platform reports
 * it, and otherwise only in the message, so both are checked.
 */
function isAddressInUse(error: unknown): boolean {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	if (typeof code === "string") return code === "EADDRINUSE";
	return error instanceof Error && /EADDRINUSE|in use/i.test(error.message);
}

/**
 * Whether this host exposes an IPv6 loopback (`::1`) the companion listener can
 * bind. A kernel with IPv6 disabled (`ipv6.disable=1`) lists no internal IPv6
 * address, and the `::1` companion bind there fails with a generic Bun error
 * {@link isAddressInUse} cannot distinguish from a real collision — Bun reuses
 * its "Is port X in use?" message for every listen failure (oven-sh/bun#7187) —
 * so the dual-bind path must be skipped up front rather than misread as a
 * conflict (issue #8814).
 */
function ipv6LoopbackAvailable(): boolean {
	const interfaces = os.networkInterfaces();
	for (const name in interfaces) {
		const addresses = interfaces[name];
		if (!addresses) continue;
		for (const address of addresses) {
			if (address.internal && address.family === "IPv6") return true;
		}
	}
	return false;
}

export interface OAuthCallbackFlowOptions {
	preferredPort: number;
	callbackPath?: string;
	callbackHostname?: string;
	/** Exact redirect URI advertised to the provider; disables port fallback. */
	redirectUri?: string;
	/**
	 * Whether the flow may bind to a random port when {@link preferredPort} is
	 * unavailable. Defaults to `true` so historical AI-provider flows (which
	 * pick uncommon ports and tolerate any loopback callback) keep working.
	 *
	 * Set to `false` for providers that validate the redirect URI against a
	 * registered callback — silently advertising a random-port URI would be
	 * rejected by the authorization server, leaving the browser on an opaque
	 * 500 page and the local callback waiting until the 5-minute timeout fires.
	 * With fallback disabled, {@link OAuthCallbackFlow.login} throws a
	 * {@link AIError.ConfigurationError} immediately so the caller can surface
	 * an actionable message before opening the browser.
	 */
	allowPortFallback?: boolean;
	/** Skip the local callback server entirely; the user pastes the code or redirect URL back. */
	manualInputOnly?: boolean;
}

/**
 * Abstract base class for OAuth flows with local callback servers.
 */
export abstract class OAuthCallbackFlow {
	ctrl: OAuthController;
	preferredPort: number;
	callbackPath: string;
	callbackHostname: string;
	redirectUri?: string;
	allowPortFallback: boolean;
	#manualInputOnly: boolean;
	#callbackResolve?: (result: CallbackResult) => void;
	#callbackReject?: (error: Error) => void;
	/**
	 * Authorization URL the `/launch` route currently redirects to. Set by
	 * {@link login} after {@link generateAuthUrl} and before {@link OAuthController.onAuth}
	 * fires, cleared when the server stops. `undefined` before the flow reaches
	 * that point and after it finishes, so `/launch` returns 503 rather than
	 * a stale URL.
	 */
	#pendingAuthUrl?: string;

	constructor(
		ctrl: OAuthController,
		preferredPortOrOptions: number | OAuthCallbackFlowOptions,
		callbackPath: string = CALLBACK_PATH,
	) {
		this.ctrl = ctrl;
		if (typeof preferredPortOrOptions === "number") {
			this.preferredPort = preferredPortOrOptions;
			this.callbackPath = callbackPath;
			this.callbackHostname = DEFAULT_HOSTNAME;
			this.allowPortFallback = true;
			this.#manualInputOnly = false;
			return;
		}

		this.preferredPort = preferredPortOrOptions.preferredPort;
		this.callbackPath = preferredPortOrOptions.callbackPath ?? CALLBACK_PATH;
		this.callbackHostname = preferredPortOrOptions.callbackHostname ?? DEFAULT_HOSTNAME;
		this.redirectUri = preferredPortOrOptions.redirectUri;
		this.allowPortFallback = preferredPortOrOptions.allowPortFallback ?? true;
		this.#manualInputOnly = preferredPortOrOptions.manualInputOnly ?? false;
	}

	/**
	 * Generate provider-specific authorization URL.
	 * @param state - CSRF state token
	 * @param redirectUri - The actual redirect URI to use (may differ from expected if port fallback occurred)
	 * @returns Authorization URL and optional instructions
	 */
	abstract generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }>;

	/**
	 * Exchange authorization code for OAuth tokens.
	 * @param code - Authorization code from callback
	 * @param state - CSRF state token
	 * @param redirectUri - The actual redirect URI used (must match authorization request)
	 * @returns OAuth credentials
	 */
	abstract exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials>;

	/**
	 * Generate CSRF state token. Override if provider needs custom state generation.
	 */
	generateState(): string {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes)
			.map(value => value.toString(16).padStart(2, "0"))
			.join("");
	}

	#loginCancelledError(): AIError.LoginCancelledError {
		return new AIError.LoginCancelledError(`OAuth callback cancelled: ${this.ctrl.signal?.reason}`);
	}

	#throwIfCancelled(): void {
		if (this.ctrl.signal?.aborted) throw this.#loginCancelledError();
	}

	/**
	 * Execute the OAuth login flow.
	 */
	async login(): Promise<OAuthCredentials> {
		const state = this.generateState();
		this.#throwIfCancelled();

		// Start callback server first to get actual redirect URI. Manual-only
		// flows never bind a server — the advertised redirect URI is fixed and
		// the user pastes the code/redirect URL back instead.
		const { server, redirectUri, launchUrl } = this.#manualInputOnly
			? { server: undefined, redirectUri: this.#buildRedirectUri(), launchUrl: undefined }
			: await this.#startCallbackServer(state);

		try {
			this.#throwIfCancelled();
			// Generate auth URL with the ACTUAL redirect URI (may differ from expected if port was busy)
			const { url: authUrl, instructions } = await this.generateAuthUrl(state, redirectUri);
			this.#throwIfCancelled();

			// Publish the auth URL to the `/launch` route BEFORE handing it to
			// callers. `onAuth` immediately renders a UI that advertises the
			// launch URL as a copy target, so `/launch` must already resolve if
			// the user clicks/pastes it during the same render pass.
			this.#pendingAuthUrl = authUrl;

			// Notify controller that auth is ready
			this.ctrl.onAuth?.({ url: authUrl, launchUrl, instructions });
			this.ctrl.onProgress?.(
				this.#manualInputOnly
					? "Waiting for pasted authorization code..."
					: "Waiting for browser authentication...",
			);

			const { code } = await this.#waitForCallback(state);
			this.#throwIfCancelled();

			this.ctrl.onProgress?.("Exchanging authorization code for tokens...");

			return await this.exchangeToken(code, state, redirectUri);
		} finally {
			this.#pendingAuthUrl = undefined;
			server?.stop();
		}
	}

	#buildRedirectUri(): string {
		return this.redirectUri ?? `http://${this.callbackHostname}:${this.preferredPort}${this.callbackPath}`;
	}

	/**
	 * Start callback server, trying preferred port first, falling back to random.
	 * `launchUrl` is `undefined` when the caller configured `callbackPath` to
	 * collide with {@link LAUNCH_PATH} — the callback handler resolves the real
	 * callback in that case, so advertising a self-redirecting URL would be
	 * incorrect.
	 */
	async #startCallbackServer(
		expectedState: string,
	): Promise<{ server: CallbackServer; redirectUri: string; launchUrl: string | undefined }> {
		try {
			const server = this.#createServer(this.preferredPort, expectedState);
			// `preferredPort: 0` opts into a random port — read the actual bound
			// port from the server so both the redirect URI and launch URL point at
			// a reachable socket, not the sentinel.
			const actualPort = this.#resolveServerPort(server);
			const launchUrl = this.#launchUrlIfSafe(actualPort);
			if (this.redirectUri) {
				return { server, redirectUri: this.redirectUri, launchUrl };
			}
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			return { server, redirectUri, launchUrl };
		} catch (cause) {
			if (this.redirectUri) {
				throw new AIError.ConfigurationError(
					`OAuth callback port ${this.preferredPort} is in use, but oauth.redirectUri (${this.redirectUri}) requires this exact port. Free port ${this.preferredPort} (e.g. stop the process bound to it) and retry, or change oauth.redirectUri to point at an available port.`,
					{ cause },
				);
			}
			if (!this.allowPortFallback) {
				throw new AIError.ConfigurationError(
					`OAuth callback port ${this.preferredPort} is in use. The OAuth provider validates redirect URIs against its registered callback, so falling back to a random port would be rejected. Free port ${this.preferredPort} (e.g. stop the process bound to it) and retry, or set oauth.callbackPort/oauth.redirectUri to a port the provider has registered.`,
					{ cause },
				);
			}
			const server = this.#createServer(0, expectedState);
			const actualPort = this.#resolveServerPort(server);
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			const launchUrl = this.#launchUrlIfSafe(actualPort);
			this.ctrl.onProgress?.(`Preferred port ${this.preferredPort} unavailable, using port ${actualPort}`);
			return { server, redirectUri, launchUrl };
		}
	}

	/**
	 * Read the numeric port a callback server bound to. `Bun.Server.port` is
	 * declared `number | undefined` because Unix-socket servers have no port,
	 * but every callback flow uses TCP; a missing port here indicates a
	 * configuration error rather than a fallback case.
	 */
	#resolveServerPort(server: CallbackServer): number {
		const port = server.port;
		if (typeof port !== "number") {
			throw new AIError.ConfigurationError(
				"OAuth callback server bound to a non-TCP endpoint; expected a numeric port. Check `oauth.callbackPort`/`oauth.redirectUri`.",
			);
		}
		return port;
	}

	/**
	 * Build the `/launch` URL served by the callback server bound to `port`, or
	 * `undefined` when it must not be advertised:
	 * - the configured `callbackPath` (or a `redirectUri` whose pathname
	 *   resolves to {@link LAUNCH_PATH}) would collide with the launch route;
	 * - the flow's `redirectUri` never returns to this loopback server: fixed
	 *   non-loopback hosts, or custom schemes like GitLab Duo's `vscode://`
	 *   URI — which `new URL` parses without complaint, so a scheme/host check
	 *   is required, not just the parse failure path. Advertising a localhost
	 *   `/launch` target for such flows misrepresents the callback endpoint
	 *   and hands remote users a URL that resolves nowhere.
	 * Kept short (~30 chars) so UIs can advertise it as a
	 * viewport-truncation-safe copy target for the full authorization URL.
	 */
	#launchUrlIfSafe(port: number): string | undefined {
		if (this.callbackPath === LAUNCH_PATH) return undefined;
		if (this.redirectUri) {
			try {
				const parsed = new URL(this.redirectUri);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
				if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
					return undefined;
				}
				if (parsed.pathname === LAUNCH_PATH) return undefined;
			} catch {
				// A redirectUri even WHATWG URL cannot parse certainly does not
				// return to this server — never advertise a launch URL for it.
				return undefined;
			}
		}
		return `http://${this.callbackHostname}:${port}${LAUNCH_PATH}`;
	}

	/**
	 * Create the HTTP listener(s) for the OAuth callback.
	 *
	 * `localhost` is not a single endpoint: it resolves to both
	 * {@link IPV4_LOOPBACK} and {@link IPV6_LOOPBACK}, and clients commonly try
	 * `::1` first. Binding only the IPv4 literal hands the authorization code to
	 * whatever holds the IPv6 loopback on the same port — a dev server on
	 * `*:3000` is the common case — which answers from its own routes while this
	 * flow waits out the full {@link DEFAULT_TIMEOUT}. Nothing detects it either:
	 * a specific-address bind coexists with another process's wildcard bind, so
	 * `Bun.serve` reports the port as free and the random-port fallback in
	 * {@link #startCallbackServer} never runs.
	 *
	 * Binding both loopback literals fixes the delivery rather than dodging it:
	 * the kernel routes a connection to the most specific matching bind, so our
	 * `::1` listener receives `localhost` traffic that would otherwise reach a
	 * process bound to the `::` wildcard. Both listeners answer the same routes,
	 * so which family the client resolves stops mattering.
	 *
	 * A genuine collision — another process on exactly this loopback address and
	 * port — still raises EADDRINUSE and reaches the caller's in-use policy. A
	 * host that cannot bind `::1` at all (IPv6 disabled, address unavailable) is
	 * not a collision: the IPv4 listener is the only reachable endpoint there, so
	 * it serves alone.
	 */
	#createServer(port: number, expectedState: string): CallbackServer {
		if (this.callbackHostname !== DEFAULT_HOSTNAME) {
			return this.#serve(this.callbackHostname, port, expectedState);
		}
		// A host with IPv6 disabled at the kernel exposes no `::1`, so the
		// companion bind cannot succeed there. Bun reports that failure with the
		// same generic "Is port X in use?" message it uses for a real collision
		// (oven-sh/bun#7187), which the catch below would misread — tearing down
		// the healthy IPv4 listener and, for a pinned port, throwing a bogus
		// "port in use" ConfigurationError. Detecting the missing stack up front
		// lets the IPv4 listener serve alone (issue #8814).
		const dualStack = ipv6LoopbackAvailable();
		for (let attempt = 0; ; attempt++) {
			const primary = this.#serve(IPV4_LOOPBACK, port, expectedState);
			const boundPort = primary.port;
			// A non-TCP endpoint has no port for the companion to target;
			// #resolveServerPort reports that case precisely.
			if (typeof boundPort !== "number") return primary;
			if (!dualStack) return primary;
			let companion: Bun.Server<unknown>;
			try {
				companion = this.#serve(IPV6_LOOPBACK, boundPort, expectedState);
			} catch (cause) {
				if (!isAddressInUse(cause)) return primary;
				void primary.stop(true);
				// A pinned port has no alternative, so surface it as in use and let
				// the caller apply its fallback or diagnostic policy. A random port
				// can just be redrawn, since only that one number clashed.
				if (port !== 0 || attempt >= IPV6_COMPANION_ATTEMPTS) throw cause;
				continue;
			}
			// One server to callers. The IPv4 listener stays authoritative for
			// `port` because the companion was bound to the port it resolved.
			return {
				get port() {
					return primary.port;
				},
				stop: (closeActiveConnections?: boolean) => {
					void companion.stop(closeActiveConnections);
					return primary.stop(closeActiveConnections);
				},
			};
		}
	}

	/** Bind one loopback listener serving the callback and launch routes. */
	#serve(hostname: string, port: number, expectedState: string): Bun.Server<unknown> {
		return Bun.serve({
			hostname,
			port,
			reusePort: false,
			fetch: req => this.#handleCallback(req, expectedState),
		});
	}

	/**
	 * Handle OAuth callback HTTP request. Two routes on the same loopback server:
	 * - `callbackPath` (default `/callback`) — the provider redirect target.
	 * - {@link LAUNCH_PATH} (`/launch`) — 302 to the pending authorization URL so
	 *   viewport-safe copy targets can survive TUI truncation.
	 *
	 * `callbackPath` wins any collision: an OMP config that pins the provider
	 * redirect at `/launch` (via `oauth.callbackPath` or a loopback
	 * `oauth.redirectUri`) must resolve the callback normally rather than
	 * self-redirect. `#startCallbackServer` also suppresses `launchUrl` in that
	 * case, so the launch route is never advertised when it would collide.
	 */
	#handleCallback(req: Request, expectedState: string): Response {
		const url = new URL(req.url);

		if (url.pathname !== this.callbackPath) {
			if (url.pathname === LAUNCH_PATH) {
				const pending = this.#pendingAuthUrl;
				if (!pending) {
					return new Response("OAuth launch URL is no longer active", { status: 503 });
				}
				return Response.redirect(pending, 302);
			}
			return new Response("Not Found", { status: 404 });
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") || "";
		const error = url.searchParams.get("error") || "";
		const errorDescription = url.searchParams.get("error_description") || error;

		type OkState = { ok: true; code: string; state: string };
		type ErrorState = { ok?: false; error?: string };
		let resultState: OkState | ErrorState;

		if (error) {
			resultState = { ok: false, error: `Authorization failed: ${errorDescription}` };
		} else if (!code) {
			resultState = { ok: false, error: "Missing authorization code" };
		} else if (expectedState && state !== expectedState) {
			resultState = { ok: false, error: "State mismatch - possible CSRF attack" };
		} else {
			resultState = { ok: true, code, state };
		}

		if (resultState.ok) {
			const resolve = this.#callbackResolve;
			queueMicrotask(() => {
				resolve?.({ code: resultState.code, state: resultState.state });
			});
		} else if (error && (!expectedState || state === expectedState)) {
			// The redirect carries our state nonce, so it came from the genuine
			// authorization flow (e.g. the user denied the consent screen).
			// Surface the denial now instead of leaving the login waiting for
			// the 5-minute timeout. Errors WITHOUT the expected state stay
			// ignored — any local process can forge those (#4106).
			const reject = this.#callbackReject;
			const message = resultState.error ?? `Authorization failed: ${errorDescription}`;
			queueMicrotask(() => {
				reject?.(new AIError.OAuthError(message, { kind: "device-auth" }));
			});
		}

		return new Response(
			(templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", JSON.stringify(resultState)),
			{
				status: resultState.ok ? 200 : 500,
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	/**
	 * Wait for OAuth callback or manual input (whichever comes first).
	 */
	#waitForCallback(expectedState: string): Promise<CallbackResult> {
		const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT);
		const signal = this.ctrl.signal ? AbortSignal.any([this.ctrl.signal, timeoutSignal]) : timeoutSignal;
		if (signal.aborted) return Promise.reject(this.#loginCancelledError());

		const callback = Promise.withResolvers<CallbackResult>();
		this.#callbackResolve = callback.resolve;
		this.#callbackReject = callback.reject;

		signal.addEventListener("abort", () => {
			this.#callbackResolve = undefined;
			this.#callbackReject = undefined;
			callback.reject(new AIError.LoginCancelledError(`OAuth callback cancelled: ${signal.reason}`));
		});
		const callbackPromise = callback.promise;

		// Manual input race (if supported)
		if (this.ctrl.onManualCodeInput) {
			const requestManualInput = this.ctrl.onManualCodeInput;
			const manualPromise = (async (): Promise<CallbackResult> => {
				while (true) {
					const result = await Promise.race([
						callbackPromise,
						requestManualInput()
							.then((input): CallbackResult | null => {
								const parsed = parseCallbackInput(input);
								if (!parsed.code) return null;
								if (expectedState && parsed.state && parsed.state !== expectedState) return null;
								return { code: parsed.code, state: parsed.state ?? "" };
							})
							.catch((): CallbackResult | null => null),
					]);
					if (result) return result;
				}
			})();

			return Promise.race([callbackPromise, manualPromise]);
		}

		return callbackPromise;
	}
}

/**
 * Parse a redirect URL or code string to extract code and state.
 */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL - check for query string format
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	// Assume raw code, possibly with state after #
	const [code, state] = value.split("#", 2);
	return { code, state };
}
