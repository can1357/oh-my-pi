import { isCatalogEndpointUrl } from "@oh-my-pi/pi-catalog/compat/catalog-endpoint";
import { logger } from "@oh-my-pi/pi-utils";
import type { Api, DispatchHold, FetchImpl, Model } from "../types";
import { lastDispatchOrigin, transportFetch } from "../utils/transport-fetch";
import { resolveAnthropicPrewarmTarget } from "./anthropic-http-options";

/**
 * Minimum gap between warm-ups of one origin. Idle pooled sockets outlive it
 * by minutes (Copilot drops them after ~2.5–5 min, most hosts later), so a
 * tighter cadence would only add requests.
 */
const PREWARM_INTERVAL_MS = 30_000;
const PREWARM_TIMEOUT_MS = 10_000;

const prewarmedAt = new Map<string, number>();

/**
 * Where a warm-up for {@link model} goes, or `undefined` when it must not be
 * probed. First-party Anthropic resolves its effective endpoint (following
 * `ANTHROPIC_BASE_URL`/Foundry reroutes) and TLS options up front. Every
 * other model warms only the origin its last inference request actually
 * reached, so credential endpoints (Copilot plans), env overrides
 * (`MOONSHOT_BASE_URL`, `XAI_BASE_URL`), and regional hosts are never guessed
 * from `baseUrl`; before its first request there is nothing to warm. That
 * origin must also be the provider's own endpoint: a custom provider, or a
 * catalog provider id routed to a gateway, proxy, or local server, is never
 * probed.
 */
function resolvePrewarmTarget(model: Model<Api>): { origin: string; init: RequestInit } | undefined {
	if (model.provider === "anthropic") {
		const target = resolveAnthropicPrewarmTarget(model);
		return target && { origin: new URL(target.url).origin, init: target.init };
	}
	const origin = lastDispatchOrigin(model);
	if (!origin || !isCatalogEndpointUrl(model, origin)) return undefined;
	return { origin, init: {} };
}

export interface ConnectionPrewarmOptions {
	fetch?: FetchImpl;
	/**
	 * Asked at the last step before the `HEAD` reaches the wire, after the
	 * transport has prepared it; `true` abandons the warm-up there. A warm-up is
	 * skipped rather than held: one that waited the condition out would wake up
	 * racing the request it exists to speed up, for the same socket.
	 */
	skipIf?: () => boolean;
}

/**
 * Opens, or keeps alive, a pooled connection to {@link model}'s API host so
 * the next turn skips DNS + TCP + TLS. Sends a credential-less `HEAD` (nothing
 * is billed; hosts answer 401/404/405) through the same transport — proxy,
 * extra CA, Cowork profile, TLS options — as real requests, because sockets
 * pool per transport configuration and a warm-up made any other way (e.g.
 * `fetch.preconnect`, which also throws on Windows) is never reused.
 * Throttled per origin; best effort, never throws.
 */
export async function prewarmModelConnection(model: Model<Api>, options?: ConnectionPrewarmOptions): Promise<void> {
	let origin: string | undefined;
	let startedAt: number | undefined;
	let skipped = false;
	const skipIf = options?.skipIf;
	// The transport runs a dispatch hold after all of its own preparation and
	// right before the wire, so that is where the skip check belongs. Throwing
	// ends the attempt before any connection is opened, and the probe puts the
	// same question in the synchronous step the transport dispatches from, so a
	// condition that turns true after the hold was asked still abandons it.
	const skipHold: DispatchHold | undefined =
		skipIf &&
		Object.assign(
			(): void => {
				if (!skipIf()) return;
				skipped = true;
				throw new Error("Connection prewarm skipped");
			},
			{ isClosed: skipIf },
		);
	try {
		// Inside the boundary: resolving Anthropic's TLS options throws on an
		// unusable CA or client-certificate setup, which the real request reports.
		const target = resolvePrewarmTarget(model);
		if (!target) return;
		origin = target.origin;
		const now = Date.now();
		const last = prewarmedAt.get(origin);
		if (last !== undefined && now - last < PREWARM_INTERVAL_MS) return;
		prewarmedAt.set(origin, now);
		startedAt = now;
		const response = await transportFetch(
			model,
			options?.fetch,
			skipHold,
		)(origin, {
			...target.init,
			method: "HEAD",
			headers: {},
			signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
		});
		await response.body?.cancel();
	} catch (error) {
		if (skipped) {
			// Nothing reached the host, so the throttle must not count this
			// warm-up: the next one, asked once the condition has cleared, goes out.
			if (origin !== undefined && prewarmedAt.get(origin) === startedAt) prewarmedAt.delete(origin);
			return;
		}
		logger.debug("Model connection prewarm failed", {
			origin,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Test hook: forgets every warm-up so the next call is not throttled. */
export function resetConnectionPrewarmForTesting(): void {
	prewarmedAt.clear();
}
