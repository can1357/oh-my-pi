/**
 * Internal URL schemes extensions register on the process-global router (`pi.registerUrlScheme`).
 *
 * A scheme belongs to one extension source. Every load of that source — the root session's and each
 * subagent's — may register it. The router holds one dispatcher per scheme while any registration
 * is active (its load not suspended); the dispatcher routes each call to the active registration of
 * the calling session's load.
 */
import { sessionCallerId } from "../../internal-urls/context";
import { assertProtocolHandlerSpec, type InternalUrlRouter } from "../../internal-urls/router";
import type { ProtocolHandler, WriteContext } from "../../internal-urls/types";
import type { ToolSession } from "../../tools";
import type { ExtensionRegistration, ExtensionRegistrations } from "./registrations";

/**
 * Live id of the session whose runner adopted each load, keyed by the load's registrations: a
 * shallow copy of an `Extension` (a legacy `extensionsOverride` may hand one to the session) shares
 * them, so the copy's adoption reaches the schemes the original load registered.
 */
const adoptingSessions = new WeakMap<ExtensionRegistrations, () => string>();

/**
 * Record that the session `sessionId` names adopted the load owning `registrations`, until the load
 * is torn down: the callback holds the adopting runner, which a loader keeping the original load
 * alive must not retain.
 */
export function adoptExtensionLoad(registrations: ExtensionRegistrations, sessionId: () => string): void {
	adoptingSessions.set(registrations, sessionId);
	registrations.add({
		release: () => {
			// A later adopter replaced this one; leave its record.
			if (adoptingSessions.get(registrations) === sessionId) adoptingSessions.delete(registrations);
		},
	});
}

/** Live id of the session that adopted the load owning `registrations`, if any has. */
export function extensionLoadSessionId(registrations: ExtensionRegistrations): string | undefined {
	return adoptingSessions.get(registrations)?.();
}

/**
 * RFC 3986 scheme syntax after lowercasing, at least two characters: a one-letter scheme would
 * capture Windows drive paths such as `C:/notes.txt` (as for `registerLinkScheme`).
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+$/;

/** Standard schemes an extension may not claim: web, file and mail links. */
const STANDARD_SCHEMES: Readonly<Record<string, true>> = {
	about: true,
	blob: true,
	data: true,
	file: true,
	ftp: true,
	http: true,
	https: true,
	javascript: true,
	mailto: true,
	ssh: true,
	ws: true,
	wss: true,
};

/** Whether `scheme` (lowercase) is a standard web, file or mail scheme no extension may claim. */
export function isStandardLinkScheme(scheme: string): boolean {
	// `=== true`: inherited keys such as `constructor` are not reserved.
	return STANDARD_SCHEMES[scheme] === true;
}

/** The extension load registering a scheme. */
export interface UrlSchemeOwner {
	/**
	 * Identity of the extension source, equal for every load of it: the resolved entry path, or an
	 * inline factory itself (inline source ids such as `<inline-0>` restart in every session).
	 */
	source: string | object;
	/** Source name for errors. */
	label: string;
	/** Live id of the session the load serves; undefined until a session adopts the load. */
	sessionId(): string | undefined;
}

/** One live `registerUrlScheme` call; an object so a handler registered twice counts twice. */
interface SchemeHolder {
	handler: ProtocolHandler;
	sessionId(): string | undefined;
	suspended: boolean;
}

/** The extension source owning a scheme and its live registrations, oldest first. */
interface SchemeClaim {
	scheme: string;
	source: string | object;
	label: string;
	holders: SchemeHolder[];
	/** Dispatcher this claim installed on the router; undefined while none is installed. */
	installed?: ProtocolHandler;
	/** Holder whose spec and spec-bound hooks {@link installed} carries. */
	primary?: SchemeHolder;
	/** Optional query hooks {@link installed} exposes: those any active holder defines. */
	queryHooks?: string;
}

/** Claims per router, so a router reset in tests starts without stale ownership. */
const claimsByRouter = new WeakMap<InternalUrlRouter, Map<string, SchemeClaim>>();

/** Name of the extension source holding `scheme` on `router` (suspended loads included), if any. */
export function extensionUrlSchemeHolder(router: InternalUrlRouter, scheme: string): string | undefined {
	return claimsByRouter.get(router)?.get(scheme.toLowerCase())?.label;
}

/**
 * Register `handler` on `router` for the load `owner` and return the registration, for the load's
 * {@link ExtensionRegistrations}: `release()` removes it for good (idempotent), `suspend()` takes
 * it out of routing and puts it back.
 *
 * Throws for invalid scheme syntax, an OMP-owned or standard scheme, a scheme another source claims,
 * a scheme registered outside extensions (RPC host URIs), or a handler whose spec fails
 * {@link assertProtocolHandlerSpec}. A source that already claims the scheme adds a registration.
 *
 * The router serves the scheme while any registration is active, through a dispatcher that carries
 * the spec and hooks of the earliest active one. A call whose context names the calling session
 * (`sessionId`, or the tool `session`) goes to that session's earliest active registration and finds
 * no service when its session has none; a call that names no session goes to the earliest active
 * registration. Without an active registration the scheme leaves the router, and returns when one
 * resumes. A release never touches a handler someone else installed for the scheme in the meantime.
 */
export function claimExtensionUrlScheme(
	router: InternalUrlRouter,
	owner: UrlSchemeOwner,
	handler: ProtocolHandler,
): ExtensionRegistration {
	const scheme = handler.scheme.toLowerCase();
	if (!SCHEME_PATTERN.test(scheme)) {
		throw new Error(
			`registerUrlScheme: "${handler.scheme}" is not a URL scheme (a letter, then at least one more letter, digit, "+", "-" or ".")`,
		);
	}
	if (router.isBuiltin(scheme)) throw new Error(`registerUrlScheme: ${scheme}:// is reserved by OMP`);
	if (isStandardLinkScheme(scheme)) {
		throw new Error(`registerUrlScheme: ${scheme}:// is reserved for standard links`);
	}

	let claims = claimsByRouter.get(router);
	if (!claims) {
		claims = new Map();
		claimsByRouter.set(router, claims);
	}
	const installed = router.getHandler(scheme);
	let claim = claims.get(scheme);
	if (claim && claim.source !== owner.source) {
		throw new Error(`registerUrlScheme: ${scheme}:// is registered by extension ${claim.label}`);
	}
	if (installed !== undefined && installed !== claim?.installed) {
		throw new Error(`registerUrlScheme: ${scheme}:// is registered outside extensions`);
	}
	assertProtocolHandlerSpec(handler);
	if (!claim) {
		claim = { scheme, source: owner.source, label: owner.label, holders: [] };
		claims.set(scheme, claim);
	}
	const holder: SchemeHolder = { handler, sessionId: () => owner.sessionId(), suspended: false };
	claim.holders.push(holder);
	syncRouter(router, claim);

	const owned = claim;
	let released = false;
	return {
		release: () => {
			if (released) return;
			released = true;
			owned.holders.splice(owned.holders.indexOf(holder), 1);
			if (owned.holders.length === 0 && claims.get(scheme) === owned) claims.delete(scheme);
			syncRouter(router, owned);
		},
		suspend: suspended => {
			if (released || holder.suspended === suspended) return;
			holder.suspended = suspended;
			syncRouter(router, owned);
		},
	};
}

/** Optional hooks a call is routed for independently of the spec: any active holder may define them. */
const QUERY_HOOKS = ["complete", "enumerate", "readDirectory", "promptDoc", "promptReference"] as const;

/** The query hooks at least one active holder of `claim` defines, as a stable key. */
function activeQueryHooks(claim: SchemeClaim): string {
	return QUERY_HOOKS.filter(hook =>
		claim.holders.some(holder => !holder.suspended && holder.handler[hook] !== undefined),
	).join(",");
}

/** Install, replace or remove `claim`'s dispatcher so it carries the earliest active holder. */
function syncRouter(router: InternalUrlRouter, claim: SchemeClaim): void {
	const primary = claim.holders.find(holder => !holder.suspended);
	const current = router.getHandler(claim.scheme);
	const ours = claim.installed !== undefined && current === claim.installed;
	if (!primary) {
		if (ours) router.unregister(claim.scheme);
		claim.installed = undefined;
		claim.primary = undefined;
		claim.queryHooks = undefined;
		return;
	}
	const queryHooks = activeQueryHooks(claim);
	if (ours && claim.primary === primary && claim.queryHooks === queryHooks) return;
	// Never replace a handler this claim did not install.
	if (current !== undefined && !ours) return;
	const dispatcher = createDispatcher(claim, primary.handler, new Set(queryHooks.split(",")));
	router.register(dispatcher);
	claim.installed = dispatcher;
	claim.primary = primary;
	claim.queryHooks = queryHooks;
}

/** Calling session a context names: its `sessionId`, else its tool session's (see {@link sessionCallerId}). */
function callerSessionId(context: { sessionId?: string; session?: ToolSession } | undefined): string | undefined {
	return context?.sessionId ?? (context?.session ? sessionCallerId(context.session) : undefined);
}

/** The holder serving `caller`: its session's earliest active one, or the earliest active one for an anonymous call. */
function servingHandler(claim: SchemeClaim, caller: string | undefined): ProtocolHandler | undefined {
	for (const holder of claim.holders) {
		if (holder.suspended) continue;
		if (caller === undefined || holder.sessionId() === caller) return holder.handler;
	}
	return undefined;
}

function requireHandler(claim: SchemeClaim, caller: string | undefined): ProtocolHandler {
	const handler = servingHandler(claim, caller);
	if (handler) return handler;
	throw new Error(
		`${claim.scheme}:// is not available in this session: no active load of extension ${claim.label} serves it here`,
	);
}

/**
 * The router-facing handler for `claim`, each call routed to the holder serving the caller. The spec
 * and the hooks it governs (`write`, `locate`, `locateSync`) are `primary`'s; a query hook (completion,
 * listing, `promptDoc`) is exposed when any active holder defines it, so a session whose own handler
 * has one is served even when the earliest holder lacks it. `promptDoc` carries no caller, so each
 * call asks the earliest active holder that defines one.
 */
function createDispatcher(
	claim: SchemeClaim,
	primary: ProtocolHandler,
	queryHooks: ReadonlySet<string>,
): ProtocolHandler {
	const { scheme } = claim;
	const dispatcher: ProtocolHandler = {
		scheme,
		spec: primary.spec,
		resolve: (url, context) => requireHandler(claim, callerSessionId(context)).resolve(url, context),
	};
	if (primary.write) {
		dispatcher.write = (url, content, context?: WriteContext) => {
			const handler = requireHandler(claim, callerSessionId(context));
			if (!handler.write) throw new Error(`${scheme}:// is read-only in this session`);
			return handler.write(url, content, context);
		};
	}
	if (primary.locate) {
		dispatcher.locate = async (url, context, options) =>
			(await servingHandler(claim, callerSessionId(context))?.locate?.(url, context, options)) ?? null;
	}
	if (primary.locateSync) {
		dispatcher.locateSync = (url, context) =>
			servingHandler(claim, callerSessionId(context))?.locateSync?.(url, context);
	}
	if (queryHooks.has("complete")) {
		dispatcher.complete = async (query, context) =>
			(await servingHandler(claim, callerSessionId(context))?.complete?.(query, context)) ?? [];
	}
	if (queryHooks.has("enumerate")) {
		dispatcher.enumerate = async (url, context) =>
			(await requireHandler(claim, callerSessionId(context)).enumerate?.(url, context)) ?? [];
	}
	if (queryHooks.has("readDirectory")) {
		dispatcher.readDirectory = async (url, context) =>
			(await requireHandler(claim, callerSessionId(context)).readDirectory?.(url, context)) ?? [];
	}
	if (queryHooks.has("promptDoc")) {
		// Looked up per call: the documenting holder can be suspended or released while the
		// dispatcher (keyed by the earliest holder and the hook set) stays installed.
		dispatcher.promptDoc = host =>
			claim.holders.find(holder => !holder.suspended && holder.handler.promptDoc)?.handler.promptDoc?.(host);
	}
	if (queryHooks.has("promptReference")) {
		// The `xd://read/urls` entry, like the prompt doc: no caller, so the earliest active holder that has one.
		dispatcher.promptReference = () =>
			claim.holders.find(holder => !holder.suspended && holder.handler.promptReference)?.handler.promptReference?.();
	}
	return dispatcher;
}
