/**
 * Versioned Stats API v1 router.
 *
 * All endpoints return the same response shapes as the existing `/api/stats/*`
 * routes (one source of truth: same aggregator functions). This module adds
 * versioning, parameter validation, CORS headers for loopback dev, and honest
 * error handling.
 *
 * Base path: /api/v1/
 *
 * Supported ranges: today, 1h, 24h, 7d, 30d, 90d, all (default 24h).
 * from/to epoch-ms and model/provider/status filters: NOT supported by the
 * existing query layer, so omitted. Documented in /api/v1/meta.
 */

import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getFolderStats,
	getModelDashboardStats,
	getOverviewStats,
	getProviderDashboardStats,
	getRecentErrors,
	getRequestsPaginated,
	getToolDashboardStats,
} from "./aggregator";
import { getGainDashboardStats } from "./gain-aggregator";

const VALID_RANGES = ["today", "1h", "24h", "7d", "30d", "90d", "all"] as const;
type ValidRange = (typeof VALID_RANGES)[number];

const DEFAULT_RANGE: ValidRange = "24h";

/** CORS header for loopback development. */
const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "http://localhost:3000",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
};

/**
 * Handle an API v1 request.
 *
 * All handlers call the same functions as the existing unversioned routes.
 * The response shapes are identical — this is a stable version boundary, not
 * a different aggregation layer.
 */
export async function handleApiV1(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const pathname = url.pathname;

	// Only GET is supported (OPTIONS preflight is handled at the server level)
	if (req.method !== "GET") {
		return Response.json({ error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
	}

	const rawRange = url.searchParams.get("range");
	const normalized = rawRange?.trim().toLowerCase();
	if (normalized !== undefined && normalized !== "" && !(VALID_RANGES as readonly string[]).includes(normalized)) {
		return Response.json(
			{ error: `Invalid range "${rawRange}". Valid ranges: ${VALID_RANGES.join(", ")}` },
			{ status: 400, headers: CORS_HEADERS },
		);
	}
	const range: ValidRange = normalized ? (normalized as ValidRange) : DEFAULT_RANGE;

	try {
		if (pathname === "/api/v1/meta") {
			return Response.json(
				{
					version: 1,
					ranges: [...VALID_RANGES],
					endpoints: [
						"/api/v1/meta",
						"/api/v1/overview",
						"/api/v1/models",
						"/api/v1/providers",
						"/api/v1/tools",
						"/api/v1/projects",
						"/api/v1/costs",
						"/api/v1/behavior",
						"/api/v1/errors",
						"/api/v1/requests",
						"/api/v1/gain",
					],
					serverTime: Date.now(),
					supportedParams: {
						range: VALID_RANGES,
						limit: "number (errors, requests)",
						offset: "number (requests)",
						project: "string (gain)",
					},
					unsupportedParams: {
						from: "not supported by query layer (use range instead)",
						to: "not supported by query layer (use range instead)",
						model: "not supported by query layer",
						provider: "not supported by query layer",
						status: "not supported by query layer",
					},
				},
				{ headers: CORS_HEADERS },
			);
		}

		if (pathname === "/api/v1/overview") {
			const stats = await getOverviewStats(range);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/models") {
			const stats = await getModelDashboardStats(range);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/providers") {
			const stats = await getProviderDashboardStats(range);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/tools") {
			const stats = await getToolDashboardStats(range);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/projects") {
			const stats = await getFolderStats(range);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/costs") {
			const stats = await getCostDashboardStats(range);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/behavior") {
			const stats = await getBehaviorDashboardStats(range);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/errors") {
			const limitRaw = url.searchParams.get("limit");
			const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
			const stats = await getRecentErrors(range, Number.isFinite(limit) && limit >= 0 ? limit : 20);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/requests") {
			const limitRaw = url.searchParams.get("limit");
			const offsetRaw = url.searchParams.get("offset");
			const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
			const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;
			const effectiveLimit = Number.isFinite(limit) && limit >= 0 ? limit : 20;
			const effectiveOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
			const { items, total } = await getRequestsPaginated(effectiveLimit, effectiveOffset);
			return Response.json({ requests: items, total }, { headers: CORS_HEADERS });
		}

		if (pathname === "/api/v1/gain") {
			const project = url.searchParams.get("project");
			const stats = await getGainDashboardStats(range, project);
			return Response.json(stats, { headers: CORS_HEADERS });
		}

		return Response.json({ error: "Unknown v1 endpoint" }, { status: 404, headers: CORS_HEADERS });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Internal server error";
		return Response.json({ error: message }, { status: 500, headers: CORS_HEADERS });
	}
}
