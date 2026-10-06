import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { $, type Server } from "bun";
import {
	getCostDashboardStats,
	getDashboardStats,
	getFolderStats,
	getModelDashboardStats,
	getOverviewStats,
	getProviderDashboardStats,
	getProviderWindowStats,
	getRecentErrors,
	getRecentRequests,
	getRequestDetails,
	getToolDashboardStats,
} from "./aggregator";
import { decodeEmbeddedClientArchive } from "./embedded-client";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";
import {
	cancelFrustrationRun,
	estimateFrustrationRun,
	getFrustrationDashboardStats,
	type StatsJudgeProvider,
	setStatsJudgeProvider,
	startFrustrationRun,
} from "./frustration";
import { getGainDashboardStats } from "./gain-aggregator";
import { statsLive } from "./live";
import {
	prepareStatsPort,
	recoverStatsPort,
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
} from "./port-conflict";
import type { LiveStatus } from "./shared-types";
import {
	buildSessionTrace,
	getTraceEntry,
	listSessionSummaries,
	TRACE_ETAG_VERSION,
	traceFingerprintForEtag,
	TracePathError,
} from "./trace";

const EMBEDDED_CLIENT_ARCHIVE = decodeEmbeddedClientArchive(embeddedClientArchiveTxt);

const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");
const IS_BUN_COMPILED =
	Boolean(process.env.PI_COMPILED || Bun.env.PI_COMPILED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
// The prepacked npm bundle (coding-agent dist/cli.js) constant-folds
// process.env.PI_BUNDLED at build time. Like compiled binaries, it ships no
// dashboard sources or prebuilt dist/client next to the bundle, so the
// embedded archive is the only viable asset source.
const IS_PREBUILT = IS_BUN_COMPILED || Boolean(process.env.PI_BUNDLED || Bun.env.PI_BUNDLED);
const USE_EMBEDDED_CLIENT = EMBEDDED_CLIENT_ARCHIVE !== null || IS_PREBUILT;

let embeddedClientFilesPromise: Promise<Map<string, Blob>> | null = null;

async function getEmbeddedClientFiles(): Promise<Map<string, Blob>> {
	if (embeddedClientFilesPromise) return embeddedClientFilesPromise;

	if (!EMBEDDED_CLIENT_ARCHIVE) {
		throw new Error(
			"Embedded stats client bundle missing. Rebuild the omp binary or npm bundle with embedded stats assets.",
		);
	}

	// Keep bundled assets in memory so OS temporary-file cleanup cannot break a live dashboard.
	embeddedClientFilesPromise = new Bun.Archive(EMBEDDED_CLIENT_ARCHIVE).files().then(files => {
		for (const [name, file] of files) {
			// Archive entries are untyped blobs; infer MIME types just as disk-backed Bun files do.
			files.set(name, new File([file], name, { type: Bun.file(name).type }));
		}
		return files;
	});

	return embeddedClientFilesPromise;
}

async function getLatestMtime(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		// Tolerate missing source trees (e.g. installs without the dashboard
		// sources); the caller falls back to prebuilt assets or a clear build
		// failure instead of crashing on the scan.
		if (isEnoent(err)) return 0;
		throw err;
	}

	const promises = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			promises.push(getLatestMtime(fullPath));
		} else if (entry.isFile()) {
			promises.push(fs.stat(fullPath).then(stats => stats.mtimeMs));
		}
	}

	let latest = 0;
	await Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "fulfilled") {
				latest = Math.max(latest, result.value);
			}
		}
	});
	return latest;
}

const ensureClientBuild = async () => {
	if (USE_EMBEDDED_CLIENT) return;
	const indexPath = path.join(STATIC_DIR, "index.html");
	const cssPath = path.join(STATIC_DIR, "index.css");
	const sourceMtime = await getLatestMtime(CLIENT_DIR);
	let shouldBuild = true;
	try {
		const [indexStats, cssStats] = await Promise.all([fs.stat(indexPath), fs.stat(cssPath)]);
		if (
			indexStats.isFile() &&
			cssStats.isFile() &&
			indexStats.mtimeMs >= sourceMtime &&
			cssStats.mtimeMs >= sourceMtime
		) {
			shouldBuild = false;
		}
	} catch {
		shouldBuild = true;
	}

	if (!shouldBuild) return;

	await fs.rm(STATIC_DIR, { recursive: true, force: true });

	logger.debug("Building stats client");
	const packageRoot = path.join(import.meta.dir, "..");
	const buildResult = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`Failed to build stats client (exit ${buildResult.exitCode})${details}`);
	}
};

/**
 * Required on every spending/mutating POST. A custom header forces a CORS
 * preflight, which this server never approves, so a hostile page cannot
 * trigger a paid judge run through a cross-site form or `fetch`.
 */
const STATS_ACTION_HEADER = "X-Omp-Stats-Action";

/**
 * Handle API requests.
 */
export async function handleApi(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	// Stats reads are DB-only; ingest runs in the background (see `live.ts`).
	const range = url.searchParams.get("range");

	if (path === "/api/status") {
		return Response.json(statsLive().status());
	}

	if (path === "/api/stats") {
		const stats = await getDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/overview") {
		const stats = await getOverviewStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/model-dashboard") {
		const stats = await getModelDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/costs") {
		const stats = await getCostDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/frustration") {
		const stats = await getFrustrationDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/frustration/estimate") {
		const estimate = await estimateFrustrationRun(range);
		return Response.json(estimate);
	}

	if (path === "/api/frustration/judge" || path === "/api/frustration/cancel") {
		if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });
		if (req.headers.get(STATS_ACTION_HEADER) !== "1") {
			return Response.json({ error: `${STATS_ACTION_HEADER}: 1 header required` }, { status: 403 });
		}
		if (path === "/api/frustration/cancel") return Response.json(cancelFrustrationRun());
		const result = await startFrustrationRun(range);
		if (!result.started) return Response.json({ error: result.error }, { status: result.status });
		return Response.json(result.job, { status: 202 });
	}

	if (path === "/api/stats/tools") {
		const stats = await getToolDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/provider-windows") {
		return Response.json(await getProviderWindowStats(range, url.searchParams.get("provider")));
	}

	if (path === "/api/stats/providers") {
		const stats = await getProviderDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/recent") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentRequests(limit ? parseInt(limit, 10) : undefined, url.searchParams.get("range"));
		return Response.json(stats);
	}

	if (path === "/api/stats/errors") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentErrors(range, limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/models") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.byModel);
	}

	if (path === "/api/stats/folders") {
		const stats = await getFolderStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/timeseries") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.timeSeries);
	}

	if (path.startsWith("/api/request/")) {
		const id = path.split("/").pop();
		if (!id) return new Response("Bad Request", { status: 400 });
		const details = await getRequestDetails(parseInt(id, 10));
		if (!details) return new Response("Not Found", { status: 404 });
		return Response.json(details);
	}

	if (path === "/api/sync") {
		if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });
		statsLive().requestSync();
		return Response.json(statsLive().status(), { status: 202 });
	}

	if (path === "/api/stats/gain") {
		const project = url.searchParams.get("project");
		const stats = await getGainDashboardStats(range, project);
		return Response.json(stats);
	}
	if (path === "/api/sessions") {
		const limitParam = Number(url.searchParams.get("limit") ?? "100");
		const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 100;
		const q = url.searchParams.get("q") ?? undefined;
		return Response.json(await listSessionSummaries(limit, q));
	}

	if (path === "/api/session/trace") {
		const file = url.searchParams.get("file");
		if (!file) return Response.json({ error: "file required" }, { status: 400 });
		try {
			// ETag-first: compare the client's etag against the
			// root+child fingerprint WITHOUT building the trace. A matching
			// (unchanged) poll returns 304 after stats only; only a changed
			// tree pays the full re-read/re-parse/rebuild in
			// buildSessionTrace (itself memoized for non-conditional polls).
			// The fingerprint covers child transcripts, so a subagent-only
			// append changes the ETag and never 304s stale.
			const clientEtag = req.headers.get("if-none-match");
			if (clientEtag) {
				const fingerprint = await traceFingerprintForEtag(file);
				if (fingerprint !== undefined) {
					const etag = `"${TRACE_ETAG_VERSION}:${fingerprint}"`;
					if (clientEtag === etag) return new Response(null, { status: 304 });
				}
			}
			const trace = await buildSessionTrace(file);
			const etag = `"${TRACE_ETAG_VERSION}:${trace.etag}"`;
			if (clientEtag === etag) return new Response(null, { status: 304 });
			return Response.json(trace, { headers: { ETag: etag } });
		} catch (err) {
			if (err instanceof TracePathError) return Response.json({ error: err.message }, { status: 400 });
			if (isEnoent(err)) return Response.json({ error: "session not found" }, { status: 404 });
			throw err;
		}
	}

	if (path === "/api/session/entry") {
		const file = url.searchParams.get("file");
		const id = url.searchParams.get("id");
		if (!file || !id) return Response.json({ error: "file and id required" }, { status: 400 });
		try {
			const entry = await getTraceEntry(file, id);
			if (!entry) return Response.json({ error: "entry not found" }, { status: 404 });
			return Response.json({ entry });
		} catch (err) {
			if (err instanceof TracePathError) return Response.json({ error: err.message }, { status: 400 });
			throw err;
		}
	}

	return new Response("Not Found", { status: 404 });
}

/**
 * Handle static file requests.
 */
async function handleStatic(requestPath: string): Promise<Response> {
	if (USE_EMBEDDED_CLIENT) {
		const files = await getEmbeddedClientFiles();
		const file = files.get(requestPath.slice(1)) ?? files.get("index.html");
		return file ? new Response(file) : new Response("Not Found", { status: 404 });
	}

	const filePath = requestPath === "/" ? "/index.html" : requestPath;
	const fullPath = path.join(STATIC_DIR, filePath);

	const file = Bun.file(fullPath);
	if (await file.exists()) {
		return new Response(file);
	}

	// SPA fallback
	const index = Bun.file(path.join(STATIC_DIR, "index.html"));
	if (await index.exists()) {
		return new Response(index);
	}

	return new Response("Not Found", { status: 404 });
}

/** Format a dashboard origin, including brackets required by IPv6 literals. */
export function formatStatsDashboardUrl(hostname: string, port: number): string {
	const urlHostname = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
	return `http://${urlHostname}:${port}`;
}

function createDashboardServer(port: number, hostname: string): Server<undefined> {
	const server = Bun.serve({
		port,
		hostname,
		async fetch(req, server) {
			const url = new URL(req.url);
			const path = url.pathname;

			// The identity header lets another omp session's reuse probe positively
			// recognize this dashboard without allowing cross-origin API reads.
			const dashboardHeaders: Record<string, string> = {
				[STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
				[STATS_DASHBOARD_HOSTNAME_HEADER]: hostname,
			};

			if (req.method === "OPTIONS") {
				return new Response(null, { headers: dashboardHeaders });
			}

			if (path === "/api/events") {
				// Long-lived stream: exempt from the idle timeout.
				server.timeout(req, 0);
				return liveEventStream(dashboardHeaders);
			}

			try {
				let response: Response;

				if (path.startsWith("/api/")) {
					response = await handleApi(req);
				} else {
					response = await handleStatic(path);
				}

				// Add the dashboard identity header to all responses.
				const headers = new Headers(response.headers);
				for (const key in dashboardHeaders) {
					headers.set(key, dashboardHeaders[key]);
				}

				return new Response(response.body, {
					status: response.status,
					headers,
				});
			} catch (error) {
				logger.error("Stats dashboard request failed", { path, error: String(error) });
				return Response.json(
					{ error: error instanceof Error ? error.message : "Unknown error" },
					{ status: 500, headers: dashboardHeaders },
				);
			}
		},
	});
	return server;
}

/** Keep-alive comment cadence so proxies and the browser keep the stream open. */
const EVENT_HEARTBEAT_MS = 15_000;

/**
 * Server-sent events of {@link LiveStatus}: the current status immediately,
 * then every change (sync progress, data version bumps, indexing backlog).
 */
function liveEventStream(headers: Record<string, string>): Response {
	const live = statsLive();
	// Ingest starts when the first page connects, not when the server binds.
	live.start();
	const encoder = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (status: LiveStatus) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(status)}\n\n`));
			};
			send(live.status());
			const unsubscribe = live.subscribe(send);
			const heartbeat = setInterval(
				() => controller.enqueue(encoder.encode(": keep-alive\n\n")),
				EVENT_HEARTBEAT_MS,
			);
			cleanup = () => {
				unsubscribe();
				clearInterval(heartbeat);
			};
		},
		cancel() {
			cleanup();
		},
	});
	return new Response(stream, {
		headers: {
			...headers,
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

/**
 * Start the HTTP server, reusing a live dashboard or reclaiming a stale omp listener.
 */
export interface StatsServerHandle {
	hostname: string;
	port: number;
	stop: () => void;
}

// Dashboards this process already bound, keyed by requested `hostname:port`.
// A second in-process start (e.g. `/trace` twice in one session) must return
// the live handle: probing our own port can time out under load and would
// then dead-end in the reclaim path's self-PID guard.
const activeServers = new Map<string, StatsServerHandle>();
/** Dashboards bound by this process (any port); background ingest stops when the last one does. */
let liveServers = 0;

export interface StartServerOptions {
	/** Host judge for the Frustration dashboard's judge runs; replaces any previously registered one. */
	judge?: StatsJudgeProvider;
}

export async function startServer(
	port = 3847,
	hostname = STATS_DASHBOARD_HOSTNAME,
	options: StartServerOptions = {},
): Promise<StatsServerHandle> {
	if (options.judge) setStatsJudgeProvider(options.judge);
	const activeKey = `${hostname}:${port}`;
	if (port !== 0) {
		const active = activeServers.get(activeKey);
		if (active) return active;
	}
	await ensureClientBuild();
	const preparation = await prepareStatsPort(port, hostname);
	if (preparation === "reuse") {
		return { hostname, port, stop: () => {} };
	}
	const register = (server: Server<undefined>): StatsServerHandle => {
		liveServers++;
		let stopped = false;
		const handle: StatsServerHandle = {
			hostname,
			port: server.port ?? port,
			stop: () => {
				activeServers.delete(activeKey);
				server.stop(true);
				if (stopped) return;
				stopped = true;
				// The last dashboard in this process takes background ingest down with it.
				if (--liveServers === 0) statsLive().stop();
			},
		};
		if (port !== 0) activeServers.set(activeKey, handle);
		return handle;
	};

	try {
		return register(createDashboardServer(port, hostname));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;

		const recovery = await recoverStatsPort(port, hostname);
		if (recovery === "reuse") {
			return { hostname, port, stop: () => {} };
		}

		try {
			return register(createDashboardServer(port, hostname));
		} catch (retryError) {
			throw new Error(`Failed to start stats dashboard on ${hostname}:${port} after reclaiming it.`, {
				cause: retryError,
			});
		}
	}
}
