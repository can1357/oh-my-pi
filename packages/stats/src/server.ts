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
	getTimeRangeConfig,
	getToolDashboardStats,
} from "./aggregator";
import { initDb } from "./db";
import { decodeEmbeddedClientArchive, hasEmbeddedClientArchive } from "./embedded-client";
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
	STATS_DASHBOARD_ALLOWED_HOSTS_HEADER,
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
} from "./port-conflict";
import { getStatsByModel, getTimeSeries } from "./rollup";
import { getSpotlightDashboardStats, getSpotlightSessionContext } from "./spotlight-aggregator";
import {
	buildSessionTrace,
	getTraceEntry,
	listSessionSummaries,
	TRACE_ETAG_VERSION,
	type TraceFingerprint,
	traceFingerprintForEtag,
	TracePathError,
} from "./trace";

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
// Sniff the base64 gzip magic instead of decoding: importing this module (every
// TUI start) must not pay for a multi-megabyte archive nobody may serve.
const USE_EMBEDDED_CLIENT = hasEmbeddedClientArchive(embeddedClientArchiveTxt) || IS_PREBUILT;

let embeddedClientFilesPromise: Promise<Map<string, Blob>> | null = null;

async function getEmbeddedClientFiles(): Promise<Map<string, Blob>> {
	if (embeddedClientFilesPromise) return embeddedClientFilesPromise;

	const archive = decodeEmbeddedClientArchive(embeddedClientArchiveTxt);
	if (!archive) {
		throw new Error(
			"Embedded stats client bundle missing. Rebuild the omp binary or npm bundle with embedded stats assets.",
		);
	}

	// Keep bundled assets in memory so OS temporary-file cleanup cannot break a live dashboard.
	embeddedClientFilesPromise = new Bun.Archive(archive).files().then(files => {
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

/** Environment variable holding extra comma-separated Host names the dashboard may be served under. */
export const STATS_ALLOWED_HOSTS_ENV = "OMP_STATS_ALLOWED_HOSTS";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/**
 * Wildcard bind addresses. Never a name the dashboard is reached by from elsewhere, but the URL printed for a
 * wildcard bind uses one, and local clients that open it connect over loopback.
 */
const UNSPECIFIED_HOSTS = new Set(["0.0.0.0", "[::]"]);

/** Characters that never belong in a Host header or allowed-host entry: they smuggle userinfo, paths, or fragments past URL parsing. */
const HOST_FORBIDDEN = /[@#?/\\\s]/;
/** A normalized host name: dot-separated non-empty labels, or a bracketed IPv6 literal. */
const HOSTNAME_SHAPE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)$/;

/** Lower-case a host name, drop any port, and strip a trailing FQDN dot. Returns undefined when unparsable. */
function normalizeHostName(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || HOST_FORBIDDEN.test(trimmed)) return undefined;
	try {
		const { hostname } = new URL(`http://${trimmed}`);
		const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
		return HOSTNAME_SHAPE.test(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

/** Host names a dashboard answers to; see {@link buildAllowedHosts}. */
export interface AllowedHosts {
	/** Exact host names: the concrete bind address and non-wildcard extras. */
	readonly exact: ReadonlySet<string>;
	/** Suffixes (with leading dot) of `*.example.net` entries; they match subdomains only, never a literal `*`. */
	readonly suffixes: readonly string[];
	/** Hosts reached over plain http by construction: loopback and wildcard addresses and the concrete bind address. */
	readonly plainHttp: ReadonlySet<string>;
	/** Bound to loopback, so only local peers can connect and loopback Host names are safe from any peer. */
	readonly loopbackBind: boolean;
	/** Canonical, sorted extra hosts (`*.` for suffixes); equal keys mean equal policies, so a dashboard is reused only by a caller asking for the same hosts. */
	readonly key: string;
}

function invalidAllowedHost(entry: string): Error {
	return new Error(
		`Invalid allowed host ${JSON.stringify(entry)}: expected a bare host name such as "mybox.tailnet.ts.net" ` +
			`or "*.example.net" (no scheme, port, path, userinfo or whitespace)`,
	);
}

/**
 * Validate one `--allowed-host` entry: `[*.]host` only. A dashboard listens on one port, so a
 * port in the entry would restrict nothing; it is refused rather than silently ignored.
 */
function parseAllowedEntry(rawEntry: string): { wildcard: boolean; hostname: string } {
	const entry = rawEntry.trim();
	const wildcard = entry.startsWith("*.");
	const hostPart = wildcard ? entry.slice(2) : entry;
	if (hostPart.startsWith("[") ? !hostPart.endsWith("]") : hostPart.includes(":")) throw invalidAllowedHost(rawEntry);
	const hostname = normalizeHostName(hostPart);
	if (!hostname || (wildcard && hostname.startsWith("["))) throw invalidAllowedHost(rawEntry);
	return { wildcard, hostname };
}

/**
 * Resolve the Host names a dashboard bound to `bindHostname` answers to: loopback, the
 * concrete bind address (never a wildcard), and operator-approved extras. An extra of the form
 * `*.example.net` matches any subdomain of `example.net`, but not `example.net` itself.
 * Throws on malformed extras so a typo such as `https://host` fails at startup instead of
 * silently allowing the wrong host.
 */
export function buildAllowedHosts(bindHostname: string, extra: readonly string[] = []): AllowedHosts {
	const exact = new Set<string>();
	const suffixes: string[] = [];
	const plainHttp = new Set([...LOOPBACK_HOSTS, ...UNSPECIFIED_HOSTS]);
	const bind = normalizeHostName(
		bindHostname.includes(":") && !bindHostname.startsWith("[") ? `[${bindHostname}]` : bindHostname,
	);
	// Reaching a wildcard bind by an interface address or name takes an allowed host.
	if (bind && !UNSPECIFIED_HOSTS.has(bind)) {
		exact.add(bind);
		plainHttp.add(bind);
	}
	const extras = new Set<string>();
	for (const entry of extra) {
		const { wildcard, hostname } = parseAllowedEntry(entry);
		if (wildcard) suffixes.push(`.${hostname}`);
		else exact.add(hostname);
		extras.add(wildcard ? `*.${hostname}` : hostname);
	}
	const loopbackBind = bind !== undefined && (LOOPBACK_HOSTS.has(bind) || bind.startsWith("127."));
	return { exact, suffixes, plainHttp, loopbackBind, key: [...extras].sort().join(",") };
}

/**
 * True when the request's Host header names an allowed host. Defeats DNS rebinding and forged-Host
 * access. Loopback names (and the wildcard addresses) are only trusted when the listener is loopback-bound or the TCP
 * peer (`peerAddress`) is itself local, so a LAN client cannot claim `Host: 127.0.0.1` on a wildcard bind.
 */
function isAllowedHostHeader(hostHeader: string | null, allowed: AllowedHosts, peerAddress?: string): boolean {
	if (!hostHeader) return false;
	const hostname = normalizeHostName(hostHeader);
	if (!hostname) return false;
	if (LOOPBACK_HOSTS.has(hostname) || UNSPECIFIED_HOSTS.has(hostname)) {
		const loopbackPeer =
			peerAddress !== undefined &&
			(peerAddress === "::1" || peerAddress.startsWith("127.") || peerAddress.startsWith("::ffff:127."));
		return allowed.loopbackBind || loopbackPeer;
	}
	if (allowed.exact.has(hostname)) return true;
	return allowed.suffixes.some(suffix => hostname.length > suffix.length && hostname.endsWith(suffix));
}

function parseAllowedHostsEnv(): string[] {
	return (process.env[STATS_ALLOWED_HOSTS_ENV] ?? "")
		.split(",")
		.map(host => host.trim())
		.filter(Boolean);
}

/**
 * True when the request's `Origin` is exactly this dashboard's serialized origin (scheme, host,
 * port). Userinfo, paths, queries, fragments, `null` and scheme mismatches all fail. Loopback
 * and bind-address hosts are plain http; other allowed hosts may be fronted by a TLS proxy
 * (Tailscale Serve), so https is accepted for them too. Call only after the Host check passed.
 */
function isSameOrigin(req: Request, allowed: AllowedHosts): boolean {
	const origin = req.headers.get("origin");
	const host = req.headers.get("host");
	if (origin === null || !host) return false;
	try {
		if (new URL(origin).origin !== origin) return false;
		const hostname = normalizeHostName(host);
		if (!hostname) return false;
		const schemes = allowed.plainHttp.has(hostname) ? ["http"] : ["http", "https"];
		return schemes.some(scheme => new URL(`${scheme}://${host}`).origin === origin);
	} catch {
		return false;
	}
}

/**
 * Gate for every API route: a cross-site browser request (`Sec-Fetch-Site: cross-site`, or an
 * `Origin` that is not this dashboard) must not trigger work or read data, whatever the method.
 */
function rejectCrossSite(req: Request, allowed: AllowedHosts): Response | undefined {
	const crossSite = req.headers.get("sec-fetch-site") === "cross-site";
	if (crossSite || (req.headers.has("origin") && !isSameOrigin(req, allowed))) {
		return Response.json({ error: "cross-site request rejected" }, { status: 403 });
	}
	return undefined;
}

/** Gate for spending/mutating endpoints: POST only, with the custom action header. Returns a rejection or undefined. */
function rejectUnlessAction(req: Request): Response | undefined {
	if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });
	if (req.headers.get(STATS_ACTION_HEADER) !== "1") {
		return Response.json({ error: `${STATS_ACTION_HEADER}: 1 header required` }, { status: 403 });
	}
	return undefined;
}

/** What the page's Close calls; unset, the page offers none. */
let closeHandler: (() => void) | undefined;

/** Longest a Spotlight build serves later requests of its data version: its time range moves with the clock. */
const SPOTLIGHT_VIEW_TTL_MS = 60_000;

/** Spotlight payloads (JSON) of one live data version by `range\0agent`, with when each build started. */
let spotlightViews: { version: number; views: Map<string, { at: number; json: Promise<string> }> } | null = null;

/**
 * The Spotlight dashboard as JSON, built once per data version and view. Every open page refetches on each version
 * bump and a build takes seconds on the thread that also ingests, so pages showing the same view share one build.
 */
function spotlightView(range: string | null, agent: string | null): Promise<string> {
	const version = statsLive().status().version;
	if (spotlightViews?.version !== version) spotlightViews = { version, views: new Map() };
	const views = spotlightViews.views;
	const key = `${range ?? ""}\0${agent ?? ""}`;
	const cached = views.get(key);
	if (cached && Date.now() - cached.at < SPOTLIGHT_VIEW_TTL_MS) return cached.json;
	const json = getSpotlightDashboardStats(range, agent).then(stats => JSON.stringify(stats));
	const entry = { at: Date.now(), json };
	views.set(key, entry);
	// A failed build is not reused.
	json.catch(() => {
		if (views.get(key) === entry) views.delete(key);
	});
	return json;
}

/**
 * Let the page close the dashboard: while `close` is set, it shows a Close
 * button (and takes Esc and Ctrl+C) that calls it. `omp stats` sets it while
 * Tern shows the page in place of the block it runs in, where the page has no
 * way out of its own; `undefined` takes Close away again.
 */
export function setStatsCloseHandler(close: (() => void) | undefined): void {
	closeHandler = close;
}

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
		const rejection = rejectUnlessAction(req);
		if (rejection) return rejection;
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
		const stats = await getRecentRequests(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/errors") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentErrors(range, limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/models") {
		// Also the port-conflict identity probe: keep it to the one query it serves.
		await initDb();
		return Response.json(getStatsByModel(getTimeRangeConfig(range).cutoff));
	}

	if (path === "/api/stats/folders") {
		const stats = await getFolderStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/timeseries") {
		await initDb();
		return Response.json(getTimeSeries(getTimeRangeConfig(range)));
	}

	if (path.startsWith("/api/request/")) {
		const id = path.split("/").pop();
		if (!id) return new Response("Bad Request", { status: 400 });
		const details = await getRequestDetails(parseInt(id, 10));
		if (!details) return new Response("Not Found", { status: 404 });
		return Response.json(details);
	}

	if (path === "/api/close") {
		if (req.method === "GET") return Response.json({ closable: closeHandler !== undefined });
		const rejection = rejectUnlessAction(req);
		if (rejection) return rejection;
		if (!closeHandler) return Response.json({ error: "this dashboard is not closed from its page" }, { status: 404 });
		closeHandler();
		return new Response(null, { status: 202 });
	}

	if (path === "/api/sync") {
		const rejection = rejectUnlessAction(req);
		if (rejection) return rejection;
		statsLive().requestSync();
		return Response.json(statsLive().status(), { status: 202 });
	}

	if (path === "/api/stats/gain") {
		const project = url.searchParams.get("project");
		const stats = await getGainDashboardStats(range, project);
		return Response.json(stats);
	}
	if (path === "/api/stats/spotlight") {
		return new Response(await spotlightView(range, url.searchParams.get("agent")), {
			headers: { "content-type": "application/json;charset=utf-8" },
		});
	}

	if (path === "/api/stats/spotlight/session") {
		const file = url.searchParams.get("file");
		if (!file) return Response.json({ error: "file required" }, { status: 400 });
		const context = await getSpotlightSessionContext(file);
		if (!context) return Response.json({ error: "not a Spotlight experiment session" }, { status: 404 });
		return Response.json(context);
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
			let fingerprint: TraceFingerprint | undefined;
			if (clientEtag) {
				fingerprint = await traceFingerprintForEtag(file);
				if (fingerprint !== undefined) {
					const etag = `"${TRACE_ETAG_VERSION}:${fingerprint.rootMtimeMs}:${fingerprint.childFingerprint}"`;
					if (clientEtag === etag) return new Response(null, { status: 304 });
				}
			}
			const trace = await buildSessionTrace(file, fingerprint);
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

function createDashboardServer(port: number, hostname: string, allowedHosts: AllowedHosts): Server<undefined> {
	const server = Bun.serve({
		port,
		hostname,
		error(error) {
			// Never fall through to Bun's development error page: it embeds source lines and absolute paths.
			logger.error("Stats dashboard server error", { error: String(error) });
			return new Response("Internal Server Error", { status: 500 });
		},
		async fetch(req, server) {
			// Every route (API, SSE, static) is gated: a hostile page that DNS-rebinds onto this
			// listener, or a client forging Host, must not read session data.
			if (!isAllowedHostHeader(req.headers.get("host"), allowedHosts, server.requestIP(req)?.address)) {
				return new Response("Misdirected Request: Host not allowed (see --allowed-host)", { status: 421 });
			}
			let url: URL;
			try {
				url = new URL(req.url);
			} catch {
				return new Response("Bad Request", { status: 400 });
			}
			const path = url.pathname;

			// The identity header lets another omp session's reuse probe positively
			// recognize this dashboard without allowing cross-origin API reads.
			const dashboardHeaders: Record<string, string> = {
				[STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
				[STATS_DASHBOARD_HOSTNAME_HEADER]: hostname,
				[STATS_DASHBOARD_ALLOWED_HOSTS_HEADER]: allowedHosts.key,
			};

			if (req.method === "OPTIONS") {
				return new Response(null, { headers: dashboardHeaders });
			}

			if (path.startsWith("/api/")) {
				const rejection = rejectCrossSite(req, allowedHosts);
				if (rejection) return rejection;
			}

			if (path === "/api/events") {
				// Long-lived stream: exempt from the idle timeout.
				server.timeout(req, 0);
				return liveEventStream(dashboardHeaders, req.signal);
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
				// Details stay in the log: messages can carry paths and other internals.
				return Response.json({ error: "Internal Server Error" }, { status: 500, headers: dashboardHeaders });
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
 * Disconnects unsubscribe, so ingest winds down once no page is listening.
 */
function liveEventStream(headers: Record<string, string>, signal: AbortSignal): Response {
	const live = statsLive();
	// Ingest starts when the first page connects, not when the server binds.
	live.start();
	const encoder = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (chunk: string) => {
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					// Stream already closed: the client left without a cancel.
					cleanup();
				}
			};
			write(`data: ${JSON.stringify(live.status())}\n\n`);
			const unsubscribe = live.subscribe((_status, frame) => write(`data: ${frame}\n\n`));
			const heartbeat = setInterval(() => write(": keep-alive\n\n"), EVENT_HEARTBEAT_MS);
			const onAbort = () => cleanup();
			cleanup = () => {
				cleanup = () => {};
				unsubscribe();
				clearInterval(heartbeat);
				signal.removeEventListener("abort", onAbort);
			};
			if (signal.aborted) cleanup();
			else signal.addEventListener("abort", onAbort, { once: true });
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

/** A dashboard this process started or found; `port` is where it listens, which may differ from the one requested. */
export interface StatsServerHandle {
	hostname: string;
	port: number;
	stop: () => void;
}

// Dashboards this process already bound, keyed by requested and bound
// `hostname:port#allowedHostsKey`. A second in-process start (e.g. `/trace` twice in one
// session, or a caller passing back a fallback port) must return the live
// handle: probing our own port can time out under load and would then start
// yet another dashboard on a fallback port.
const activeServers = new Map<string, StatsServerHandle>();
/** Dashboards bound by this process (any port); background ingest stops when the last one does. */
let liveServers = 0;

export interface StartServerOptions {
	/** Host judge for the Frustration dashboard's judge runs; replaces any previously registered one. */
	judge?: StatsJudgeProvider;
	/**
	 * Extra Host names to serve beyond loopback and the bind address (e.g. a Tailscale Serve name).
	 * `*.example.net` allows any subdomain. Merged with the `OMP_STATS_ALLOWED_HOSTS` environment variable.
	 */
	allowedHosts?: string[];
}

/**
 * Start the dashboard on `port`, or reuse the current dashboard already serving it.
 * An older dashboard there is stopped and replaced; any other holder (a foreign
 * program, or a dashboard too busy to answer the identity probe) is left running
 * and the dashboard binds an ephemeral port instead.
 */
export async function startServer(
	port = 3847,
	hostname = STATS_DASHBOARD_HOSTNAME,
	options: StartServerOptions = {},
): Promise<StatsServerHandle> {
	// Validate before any side effect, so a malformed entry fails startup instead of binding.
	const allowedHosts = buildAllowedHosts(hostname, [...(options.allowedHosts ?? []), ...parseAllowedHostsEnv()]);
	if (options.judge) setStatsJudgeProvider(options.judge);
	// The allowed hosts are part of the identity: a caller asking for other host names never gets this handle.
	const requestedKey = `${hostname}:${port}#${allowedHosts.key}`;
	if (port !== 0) {
		const active = activeServers.get(requestedKey);
		if (active) return active;
	}
	await ensureClientBuild();
	const register = (server: Server<undefined>): StatsServerHandle => {
		liveServers++;
		let stopped = false;
		const boundPort = server.port ?? port;
		const keys =
			port === 0
				? [`${hostname}:${boundPort}#${allowedHosts.key}`]
				: [requestedKey, `${hostname}:${boundPort}#${allowedHosts.key}`];
		const handle: StatsServerHandle = {
			hostname,
			port: boundPort,
			stop: () => {
				for (const key of keys) activeServers.delete(key);
				server.stop(true);
				if (stopped) return;
				stopped = true;
				// The last dashboard in this process takes background ingest down with it.
				if (--liveServers === 0) statsLive().stop();
			},
		};
		for (const key of keys) activeServers.set(key, handle);
		return handle;
	};

	let claim = await prepareStatsPort(port, hostname, allowedHosts.key);
	if (claim === "bind") {
		const server = bindDashboardServer(port, hostname, allowedHosts);
		if (server) return register(server);
		claim = await recoverStatsPort(port, hostname, allowedHosts.key);
	}
	if (claim === "reuse") return { hostname, port, stop: () => {} };
	if (claim === "bind") {
		const server = bindDashboardServer(port, hostname, allowedHosts);
		if (server) return register(server);
	}
	logger.warn("Stats dashboard port is held by another process; serving on an ephemeral port", { hostname, port });
	return register(createDashboardServer(0, hostname, allowedHosts));
}

/** {@link createDashboardServer}, or null when the port is already in use. */
function bindDashboardServer(port: number, hostname: string, allowedHosts: AllowedHosts): Server<undefined> | null {
	try {
		return createDashboardServer(port, hostname, allowedHosts);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") return null;
		throw error;
	}
}
