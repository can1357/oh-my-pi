/**
 * Broker-side HTTP routes for the shared-state protocol.
 *
 * {@link createStateBrokerRoutes} returns a single {@link BrokerRouteHandler}
 * mounted into the auth broker's listener after bearer auth. It owns the three
 * `/v1/state` routes and nothing else — any path outside {@link STATE_API_PREFIX}
 * returns `null` so the listener falls through to its own 404.
 *
 * `GET ?wait=` long-polls: rather than polling SQLite on a timer, it parks on an
 * in-process notifier ({@link StateBrokerStore.subscribe}) that `push()` fires
 * whenever a domain's sequence advances. The wait/abort/clamp shape mirrors the
 * credential snapshot route in `packages/ai/src/auth-broker/server.ts`.
 */

import { type Type, type } from "@oh-my-pi/omptype";
import type { BrokerRouteHandler } from "@oh-my-pi/pi-ai/auth-broker";
import { logger } from "@oh-my-pi/pi-utils";
import type { StateBrokerStore } from "./store";
import {
	isStateDomainId,
	STATE_API_PREFIX,
	STATE_MAX_WAIT_MS,
	STATE_PAGE_LIMIT,
	type StateDomainId,
	statePushRequestSchema,
} from "./wire";

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Parse + validate a JSON request body against an ArkType schema, returning a
 * 400 `Response` on any parse/validation failure so handlers can early-return.
 * A local copy of the auth broker's helper — kept private so the two brokers
 * stay independently editable.
 */
async function parseBody<t>(
	req: Request,
	schema: Type<t>,
): Promise<{ ok: true; data: typeof schema.infer } | { ok: false; response: Response }> {
	let raw: string;
	try {
		raw = await req.text();
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid request body: ${String(error)}` }) };
	}
	if (raw.length === 0) {
		return { ok: false, response: json(400, { error: "Request body required" }) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid JSON body: ${String(error)}` }) };
	}
	const result = schema(parsed);
	if (result instanceof type.errors) {
		return { ok: false, response: json(400, { error: result.summary }) };
	}
	return { ok: true, data: result };
}

/** `?since=` cursor, defaulting to 0 and rejecting negative/non-finite input. */
function parseSince(url: URL): number {
	const raw = url.searchParams.get("since");
	if (raw === null) return 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return 0;
	return Math.trunc(parsed);
}

/** `?limit=` page size, defaulting to and clamped at {@link STATE_PAGE_LIMIT}. */
function parseLimit(url: URL): number {
	const raw = url.searchParams.get("limit");
	if (raw === null) return STATE_PAGE_LIMIT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return STATE_PAGE_LIMIT;
	return Math.min(STATE_PAGE_LIMIT, Math.trunc(parsed));
}

/** `?wait=` long-poll window, clamped to `0..`{@link STATE_MAX_WAIT_MS}. */
function parseWaitMs(url: URL): number {
	const raw = url.searchParams.get("wait");
	if (raw === null) return 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.min(STATE_MAX_WAIT_MS, Math.trunc(parsed)));
}

export function createStateBrokerRoutes(store: StateBrokerStore): BrokerRouteHandler {
	return async (req, url, ctx) => {
		const path = url.pathname;
		if (path !== STATE_API_PREFIX && !path.startsWith(`${STATE_API_PREFIX}/`)) return null;

		// `GET /v1/state` — cheap "anything changed?" summary across all domains.
		if (path === STATE_API_PREFIX) {
			if (req.method !== "GET") return json(405, { error: "Method not allowed" });
			return json(200, { generatedAt: Date.now(), domains: store.summary() });
		}

		const rest = path.slice(STATE_API_PREFIX.length + 1);
		// Only a single path segment names a domain; anything deeper is unknown.
		if (rest.length === 0 || rest.includes("/")) return json(404, { error: "Not found" });
		const domain = decodeURIComponent(rest);
		if (!isStateDomainId(domain)) return json(404, { error: `Unknown domain: ${domain}` });

		if (req.method === "GET") {
			const since = parseSince(url);
			const limit = parseLimit(url);
			const waitMs = parseWaitMs(url);

			let delta = store.delta(domain, since, limit);
			// Long-poll only when the immediate read is empty: hold the request
			// until the domain advances, the window elapses, or the client aborts.
			if (delta.entries.length === 0 && waitMs > 0) {
				const outcome = await waitForAdvance(store, domain, req.signal, waitMs);
				if (outcome === "aborted") return new Response(null, { status: 499 });
				if (outcome === "changed") delta = store.delta(domain, since, limit);
			}

			logger.debug("state-broker delta served", {
				peer: ctx.peer,
				domain,
				since,
				returned: delta.entries.length,
				seq: delta.seq,
				more: delta.more,
			});
			return json(200, delta);
		}

		if (req.method === "POST") {
			const body = await parseBody(req, statePushRequestSchema);
			if (!body.ok) return body.response;
			const result = store.push(domain, body.data.entries);
			logger.info("state-broker push applied", {
				peer: ctx.peer,
				domain,
				accepted: result.accepted,
				seq: result.seq,
			});
			return json(200, { domain, seq: result.seq, accepted: result.accepted });
		}

		return json(405, { error: "Method not allowed" });
	};
}

/**
 * Park until the domain's sequence advances, the wait window elapses, or the
 * request aborts. Fed by the store's in-process notifier — never polls SQLite.
 */
function waitForAdvance(
	store: StateBrokerStore,
	domain: StateDomainId,
	signal: AbortSignal,
	waitMs: number,
): Promise<"changed" | "timeout" | "aborted"> {
	if (signal.aborted) return Promise.resolve("aborted");

	const done = Promise.withResolvers<"changed" | "timeout" | "aborted">();
	let settled = false;
	const settle = (result: "changed" | "timeout" | "aborted"): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe();
		signal.removeEventListener("abort", onAbort);
		done.resolve(result);
	};

	const timer = setTimeout(() => settle("timeout"), waitMs);
	timer.unref?.();
	const unsubscribe = store.subscribe(domain, () => settle("changed"));
	const onAbort = (): void => settle("aborted");
	signal.addEventListener("abort", onAbort, { once: true });

	return done.promise;
}
