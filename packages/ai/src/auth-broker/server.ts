/**
 * Auth broker HTTP server.
 *
 * Wraps an {@link AuthStorage} (backed by a SQLite store on the broker host)
 * and exposes a minimal REST API for snapshot pulls and explicit refresh /
 * disable operations. Background refresh of expiring credentials lives in
 * {@link AuthBrokerRefresher}.
 *
 * Transport security is delegated to the operator (Tailscale / Wireguard);
 * the server only checks a bearer token against an allow-list per request.
 */

import { type Type, type } from "@oh-my-pi/omptype";
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthCredentialSnapshotEntry, AuthStorage, StoredCredentialBlock } from "../auth-storage";
import { parseBind } from "../utils/parse-bind";
import { resolvePeer } from "../utils/resolve-peer";
import { AuthBrokerRefresher, type AuthBrokerRefresherSchedule } from "./refresher";
import type {
	ClientUsageReportRequest,
	CredentialBlockResponse,
	CredentialBlockSnapshot,
	CredentialBlocksDeleteResponse,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadResponse,
	DisabledCredentialsResponse,
	HealthzResponse,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamRemovedEvent,
	SnapshotStreamSnapshotEvent,
} from "./types";
import {
	AUTH_BROKER_CAPABILITIES_HEADER,
	AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES,
	DEFAULT_AUTH_BROKER_BIND,
	DEFAULT_REFRESH_INTERVAL_MS,
	DEFAULT_REFRESH_SKEW_MS,
	DEFAULT_SERVER_IDLE_TIMEOUT_S,
	DEFAULT_STREAM_KEEPALIVE_MS,
} from "./types";
import { compareCredentialBlockSnapshots, parseGenerationTag } from "./protocol";
import {
	clientUsageReportRequestSchema,
	credentialBlockDeleteRequestSchema,
	credentialBlockRequestSchema,
	credentialDisableRequestSchema,
	credentialUploadRequestSchema,
} from "./wire-schemas";

const DEFAULT_EXTERNAL_CHANGE_POLL_MS = 250;
const AUTH_RECOVERY_REFRESH_OPTIONS = { reuseRecentMint: true } as const;
const TEXT_ENCODER = new TextEncoder();
const SSE_KEEPALIVE = TEXT_ENCODER.encode(": keepalive\n\n");

export interface AuthBrokerServerOptions {
	/** Underlying credential storage (wraps the local SQLite store on the broker). */
	storage: AuthStorage;
	/** Listen address; accepts `host:port` or just `port`. */
	bind?: string;
	/** Accept any of these bearer tokens. Empty disables auth (loopback only). */
	bearerTokens: string[];
	/** Honor forwarded peer headers only when the connecting proxy is trusted. Default false. */
	trustProxyHeaders?: boolean;
	/** Broker version string surfaced on `/v1/healthz`. */
	version?: string;
	/** Refresh credentials expiring within this window. Default 5 min. */
	refreshSkewMs?: number;
	/** Background refresh cadence. Default 60s. */
	refreshIntervalMs?: number;
	/** Disable the background refresher (e.g. for tests). */
	disableRefresher?: boolean;
	/**
	 * Override SSE keepalive cadence in milliseconds for `/v1/snapshot/stream`.
	 * Internal-only — tests use a short interval so they can assert heartbeats
	 * without long sleeps. Default {@link DEFAULT_STREAM_KEEPALIVE_MS}.
	 */
	streamKeepaliveMs?: number;
	/**
	 * Override cross-process SQLite change polling in milliseconds.
	 * Internal-only — tests use a short interval. Default 250ms.
	 */
	externalChangePollMs?: number;
}

export interface AuthBrokerServerHandle {
	/** Bound URL (`http://host:port`). */
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function empty(status: number, headers?: Record<string, string>): Response {
	return new Response(null, { status, headers });
}

function isAuthorized(req: Request, tokens: ReadonlySet<string>): boolean {
	if (tokens.size === 0) return true;
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	return tokens.has(match[1].trim());
}

function supportsCodexMeterBlockScopes(req: Request): boolean {
	const capabilities = req.headers.get(AUTH_BROKER_CAPABILITIES_HEADER);
	return (
		capabilities
			?.split(",")
			.some(capability => capability.trim() === AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES) ?? false
	);
}

/**
 * Parse + validate a JSON request body against an ArkType schema. Returns a
 * `Response` (400) on parse/validation failure so handlers can early-return.
 * When `allowEmpty` is set, an empty request body is validated against `{}`.
 */
async function parseBody<t>(
	req: Request,
	schema: Type<t>,
	options: { allowEmpty?: boolean } = {},
): Promise<{ ok: true; data: typeof schema.infer } | { ok: false; response: Response }> {
	let raw: string;
	try {
		raw = await req.text();
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid request body: ${String(error)}` }) };
	}
	if (raw.length === 0 && !options.allowEmpty) {
		return { ok: false, response: json(400, { error: "Request body required" }) };
	}
	let parsed: unknown;
	try {
		parsed = raw.length === 0 ? {} : JSON.parse(raw);
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid JSON body: ${String(error)}` }) };
	}
	const result = schema(parsed);
	if (result instanceof type.errors) {
		return { ok: false, response: json(400, { error: result.summary }) };
	}
	return { ok: true, data: result };
}

const REFRESH_ROUTE = /^\/v1\/credential\/(\d+)\/refresh$/;
const DISABLE_ROUTE = /^\/v1\/credential\/(\d+)\/disable$/;
const BLOCK_ROUTE = /^\/v1\/credential\/(\d+)\/block$/;
const BLOCKS_ROUTE = /^\/v1\/credential\/(\d+)\/blocks$/;
const STATIC_ROUTES: Record<string, true> = {
	"/v1/snapshot/stream": true,
	"/v1/snapshot": true,
	"/v1/usage": true,
	"/v1/usage/history": true,
	"/v1/usage/observed": true,
	"/v1/usage/clients": true,
	"/v1/usage/stale": true,
	"/v1/credentials/disabled": true,
	"/v1/credential": true,
};

/** Only known routes reach logs verbatim; unknown paths may carry caller-supplied secrets. */
function loggablePath(pathname: string): string {
	if (Object.hasOwn(STATIC_ROUTES, pathname)) return pathname;
	const dynamic = [REFRESH_ROUTE, DISABLE_ROUTE, BLOCK_ROUTE, BLOCKS_ROUTE].some(route => route.test(pathname));
	return dynamic ? pathname : "<unrouted>";
}

const MAX_SNAPSHOT_WAIT_MS = 30_000;
const DISABLED_NEXT_SWEEP_IN_MS = Number.MAX_SAFE_INTEGER;

function snapshotHeaders(generation: number): Record<string, string> {
	return {
		ETag: `"${generation}"`,
		"Cache-Control": "no-store",
		Vary: AUTH_BROKER_CAPABILITIES_HEADER,
	};
}

function parseWaitMs(url: URL): number {
	const raw = url.searchParams.get("wait");
	if (raw === null) return 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.min(MAX_SNAPSHOT_WAIT_MS, Math.trunc(parsed)));
}

function delayResult(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
	const done = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => done.resolve("timeout"), ms);
	timer.unref?.();
	return {
		promise: done.promise,
		cancel: () => clearTimeout(timer),
	};
}

class GenerationGate {
	readonly #storage: AuthStorage;
	readonly #unsubscribe: () => void;
	readonly #pollTimer: NodeJS.Timeout;
	#pollInFlight = false;
	#waiters: Map<number, Set<() => void>> = new Map();

	constructor(storage: AuthStorage, pollIntervalMs: number) {
		this.#storage = storage;
		this.#unsubscribe = storage.credentials.onGeneration(generation => this.#wake(generation));
		this.#pollTimer = setInterval(() => {
			void this.#pollExternalChanges();
		}, pollIntervalMs);
		this.#pollTimer.unref?.();
		void this.#pollExternalChanges();
	}

	waitForChange(afterGeneration: number, signal: AbortSignal): Promise<"changed" | "aborted"> {
		if (this.#storage.credentials.generation !== afterGeneration) return Promise.resolve("changed");
		if (signal.aborted) return Promise.resolve("aborted");

		const done = Promise.withResolvers<"changed" | "aborted">();
		let settled = false;
		const waiters = this.#waiters.get(afterGeneration) ?? new Set<() => void>();
		this.#waiters.set(afterGeneration, waiters);

		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
			waiters.delete(resolveChanged);
			if (waiters.size === 0) this.#waiters.delete(afterGeneration);
		};
		const settle = (result: "changed" | "aborted"): void => {
			if (settled) return;
			settled = true;
			cleanup();
			done.resolve(result);
		};
		const resolveChanged = (): void => settle("changed");
		const onAbort = (): void => settle("aborted");

		waiters.add(resolveChanged);
		signal.addEventListener("abort", onAbort, { once: true });
		return done.promise;
	}

	close(): void {
		clearInterval(this.#pollTimer);
		this.#unsubscribe();
		for (const waiters of this.#waiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.#waiters.clear();
	}

	async #pollExternalChanges(): Promise<void> {
		if (this.#pollInFlight) return;
		this.#pollInFlight = true;
		try {
			await this.#storage.credentials.poll();
		} catch (error) {
			logger.debug("Auth broker external store change poll failed", { error: String(error) });
		} finally {
			this.#pollInFlight = false;
		}
	}

	#wake(generation: number): void {
		for (const [waitingFor, waiters] of Array.from(this.#waiters)) {
			if (generation <= waitingFor) continue;
			for (const resolve of Array.from(waiters)) resolve();
		}
	}
}

function resolveRefresherSchedule(
	refresher: AuthBrokerRefresher | undefined,
	serverNowMs: number,
): { wire: RefresherSchedule; nextSweepAt: number } {
	if (!refresher) {
		return {
			wire: {
				enabled: false,
				intervalMs: 0,
				skewMs: 0,
				nextSweepInMs: DISABLED_NEXT_SWEEP_IN_MS,
			},
			nextSweepAt: DISABLED_NEXT_SWEEP_IN_MS,
		};
	}
	const schedule: AuthBrokerRefresherSchedule = refresher.getSchedule();
	return {
		wire: {
			enabled: schedule.enabled,
			intervalMs: schedule.intervalMs,
			skewMs: schedule.skewMs,
			nextSweepInMs: Math.max(0, schedule.nextSweepAt - serverNowMs),
		},
		nextSweepAt: schedule.nextSweepAt,
	};
}

function computeRotatesInMs(
	entry: { credential: { type: string; expires?: number } },
	schedule: RefresherSchedule,
	nextSweepAt: number,
	serverNowMs: number,
): number | null {
	if (!schedule.enabled || entry.credential.type !== "oauth") return null;
	const expires = entry.credential.expires;
	if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
	if (!Number.isFinite(nextSweepAt) || !Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) return null;

	const dueAt = expires - schedule.skewMs;
	const eligibleAt = Math.max(serverNowMs, dueAt);
	if (dueAt <= serverNowMs && nextSweepAt <= serverNowMs) return 0;
	if (nextSweepAt >= eligibleAt) return Math.max(0, nextSweepAt - serverNowMs);
	const steps = Math.ceil((eligibleAt - nextSweepAt) / schedule.intervalMs);
	const rotatesAt = nextSweepAt + steps * schedule.intervalMs;
	return Math.max(0, rotatesAt - serverNowMs);
}

const CODEX_BLOCK_PROVIDER_KEY = "openai-codex:oauth";
const CODEX_LEGACY_PROJECTED_BLOCK_SCOPES = new Set(["chat", "spark", "shared"]);

/**
 * Older clients only consult the Codex `shared` scope. Keep SQLite canonical
 * state meter-scoped, but conservatively collapse those scopes on their wire
 * view so any active meter block remains visible to them.
 */
function projectCredentialBlocksForLegacyClient(blocks: readonly CredentialBlockSnapshot[]): CredentialBlockSnapshot[] {
	const projected: CredentialBlockSnapshot[] = [];
	let shared: CredentialBlockSnapshot | undefined;
	for (const block of blocks) {
		if (
			block.providerKey !== CODEX_BLOCK_PROVIDER_KEY ||
			!CODEX_LEGACY_PROJECTED_BLOCK_SCOPES.has(block.blockScope)
		) {
			projected.push(block);
			continue;
		}
		const updatedAtMs =
			block.updatedAtMs === undefined
				? shared?.updatedAtMs
				: shared?.updatedAtMs === undefined
					? block.updatedAtMs
					: Math.max(shared.updatedAtMs, block.updatedAtMs);
		shared = {
			providerKey: CODEX_BLOCK_PROVIDER_KEY,
			blockScope: "shared",
			blockedUntilMs: Math.max(shared?.blockedUntilMs ?? 0, block.blockedUntilMs),
			...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
		};
	}
	if (shared) projected.push(shared);
	return projected;
}

function buildCredentialBlockGroups(
	blocks: readonly StoredCredentialBlock[],
	serverNowMs: number,
	clientSupportsCodexMeterBlockScopes: boolean,
): Map<number, CredentialBlockSnapshot[]> {
	const byCredentialId = new Map<number, CredentialBlockSnapshot[]>();
	for (const block of blocks) {
		if (block.blockedUntilMs <= serverNowMs) continue;
		const snapshotBlock: CredentialBlockSnapshot = {
			providerKey: block.providerKey,
			blockScope: block.blockScope,
			blockedUntilMs: block.blockedUntilMs,
			updatedAtMs: block.updatedAtMs,
		};
		const existing = byCredentialId.get(block.credentialId);
		if (existing) {
			existing.push(snapshotBlock);
		} else {
			byCredentialId.set(block.credentialId, [snapshotBlock]);
		}
	}
	for (const [credentialId, credentialBlocks] of byCredentialId) {
		const projected = clientSupportsCodexMeterBlockScopes
			? credentialBlocks
			: projectCredentialBlocksForLegacyClient(credentialBlocks);
		projected.sort(compareCredentialBlockSnapshots);
		byCredentialId.set(credentialId, projected);
	}
	return byCredentialId;
}

/** Credential rows of one pool generation; reloads that change rows bump it. */
interface GenerationSnapshotRows {
	generation: number;
	credentials: AuthCredentialSnapshotEntry[];
}

/**
 * Snapshot builder shared by every HTTP handler and SSE connection. Credential
 * rows are listed once per pool generation; persisted blocks are re-listed per
 * response because not every block write bumps the generation
 * (`CredentialBlocks.mark()` persists without one).
 */
class SnapshotSource {
	readonly #storage: AuthStorage;
	readonly #refresher: AuthBrokerRefresher | undefined;
	#rows: GenerationSnapshotRows | undefined;
	#reloading: Promise<unknown> | undefined;

	constructor(storage: AuthStorage, refresher: AuthBrokerRefresher | undefined) {
		this.#storage = storage;
		this.#refresher = refresher;
	}

	get generation(): number {
		return this.#storage.credentials.generation;
	}

	/**
	 * Re-read the store before serving, so writes made on the broker's own store
	 * handle outside `AuthStorage` are served too (`poll()` sees only other
	 * connections' commits). Callers arriving while a reload is in flight wait it
	 * out and then reload themselves, so none serves the pre-reload pool.
	 */
	async reload(): Promise<void> {
		while (this.#reloading) {
			await this.#reloading.catch(() => undefined);
		}
		const reloading = this.#storage.credentials.reload();
		this.#reloading = reloading;
		try {
			await reloading;
		} finally {
			if (this.#reloading === reloading) this.#reloading = undefined;
		}
	}

	/** Wire snapshot for one client flavour, projected at the current server time. */
	build(clientSupportsCodexMeterBlockScopes: boolean): SnapshotResponse {
		const rows = this.#currentRows();
		const serverNowMs = Date.now();
		const { wire, nextSweepAt } = resolveRefresherSchedule(this.#refresher, serverNowMs);
		const blocksByCredentialId = buildCredentialBlockGroups(
			this.#storage.blocks.list(rows.credentials.map(entry => entry.id)),
			serverNowMs,
			clientSupportsCodexMeterBlockScopes,
		);
		const credentials: SnapshotEntry[] = rows.credentials.map(entry => {
			const blocks = blocksByCredentialId.get(entry.id);
			const rotatesInMs = computeRotatesInMs(entry, wire, nextSweepAt, serverNowMs);
			return blocks && blocks.length > 0 ? { ...entry, rotatesInMs, blocks } : { ...entry, rotatesInMs };
		});
		return {
			generation: rows.generation,
			generatedAt: serverNowMs,
			serverNowMs,
			refresher: wire,
			credentials,
		};
	}

	#currentRows(): GenerationSnapshotRows {
		if (this.#rows?.generation === this.#storage.credentials.generation) return this.#rows;
		const snapshot = this.#storage.credentials.snapshot();
		const rows: GenerationSnapshotRows = { generation: snapshot.generation, credentials: snapshot.credentials };
		this.#rows = rows;
		return rows;
	}
}

async function serveSnapshot(
	req: Request,
	url: URL,
	source: SnapshotSource,
	gate: GenerationGate,
	peer: string,
): Promise<Response> {
	await source.reload();
	const clientSupportsCodexMeterBlockScopes = supportsCodexMeterBlockScopes(req);
	let currentGeneration = source.generation;
	const clientGeneration = parseGenerationTag(req.headers.get("if-none-match"));
	const waitMs = parseWaitMs(url);

	if (clientGeneration === undefined || currentGeneration !== clientGeneration || waitMs <= 0) {
		const body = source.build(clientSupportsCodexMeterBlockScopes);
		logger.info("auth-broker snapshot served", {
			peer,
			credentials: body.credentials.length,
			generation: body.generation,
		});
		return json(200, body, snapshotHeaders(body.generation));
	}

	const delay = delayResult(waitMs);
	const waitController = new AbortController();
	const waitSignal = AbortSignal.any([req.signal, waitController.signal]);
	const result = await Promise.race([gate.waitForChange(clientGeneration, waitSignal), delay.promise]);
	delay.cancel();
	waitController.abort();
	if (result === "aborted" || req.signal.aborted) return empty(499, snapshotHeaders(currentGeneration));

	await source.reload();
	currentGeneration = source.generation;
	if (currentGeneration !== clientGeneration) {
		const body = source.build(clientSupportsCodexMeterBlockScopes);
		logger.info("auth-broker snapshot long-poll changed", {
			peer,
			credentials: body.credentials.length,
			generation: body.generation,
		});
		return json(200, body, snapshotHeaders(body.generation));
	}

	logger.info("auth-broker snapshot long-poll unchanged", { peer, generation: currentGeneration });
	return empty(304, snapshotHeaders(currentGeneration));
}

/**
 * Stable per-credential fingerprint for SSE delta detection. Field order is
 * fixed by this serializer (NOT by entry insertion order) so a credential
 * built by two different paths still produces the same fingerprint.
 *
 * `rotatesInMs` is intentionally part of the fingerprint: when it shifts we
 * want the client to recompute its `prepareForRequest` deadline rather than
 * keep the stale projection.
 */
function fingerprintEntry(entry: SnapshotEntry): string {
	return JSON.stringify([
		entry.id,
		entry.provider,
		entry.identityKey,
		entry.rotatesInMs,
		entry.credential,
		entry.blocks ?? [],
	]);
}

function sseEvent(event: string, body: unknown): Uint8Array {
	return TEXT_ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

/** One open `GET /v1/snapshot/stream` connection, as seen by {@link SnapshotStreamHub}. */
interface SnapshotStreamSubscriber {
	readonly peer: string;
	readonly codexMeterBlockScopes: boolean;
	/** Fingerprint of the last entry frame sent per credential id. */
	readonly sent: Map<number, string>;
	lastGeneration: number;
	/** Enqueue one encoded frame; `false` once the connection is gone. */
	write(chunk: Uint8Array): boolean;
}

/**
 * One generation's snapshot for one client flavour, fingerprinted once and
 * encoded lazily so every connection sharing the flavour reuses the same
 * `entry` / `removed` frames.
 */
class SnapshotStreamFrame {
	readonly snapshot: SnapshotResponse;
	/** {@link fingerprintEntry} per credential, index-aligned with `snapshot.credentials`. */
	readonly fingerprints: string[];
	readonly ids: Set<number>;
	readonly #entryEvents: Array<Uint8Array | undefined> = [];
	readonly #removedEvents = new Map<number, Uint8Array>();

	constructor(snapshot: SnapshotResponse) {
		this.snapshot = snapshot;
		this.fingerprints = snapshot.credentials.map(entry => fingerprintEntry(entry));
		this.ids = new Set(snapshot.credentials.map(entry => entry.id));
	}

	entryEvent(index: number): Uint8Array {
		const cached = this.#entryEvents[index];
		if (cached) return cached;
		const { generation, serverNowMs, refresher, credentials } = this.snapshot;
		const payload: SnapshotStreamEntryEvent = {
			kind: "entry",
			generation,
			serverNowMs,
			refresher,
			entry: credentials[index]!,
		};
		const event = sseEvent("entry", payload);
		this.#entryEvents[index] = event;
		return event;
	}

	removedEvent(id: number): Uint8Array {
		const cached = this.#removedEvents.get(id);
		if (cached) return cached;
		const { generation, serverNowMs, refresher } = this.snapshot;
		const payload: SnapshotStreamRemovedEvent = { kind: "removed", generation, serverNowMs, refresher, id };
		const event = sseEvent("removed", payload);
		this.#removedEvents.set(id, event);
		return event;
	}
}

/** Send `subscriber` the entries whose fingerprint changed since its last frame, then removals. */
function deliverStreamFrame(subscriber: SnapshotStreamSubscriber, frame: SnapshotStreamFrame): void {
	const { snapshot } = frame;
	// Generation must move forward; a duplicate listener firing without a
	// real bump is a no-op below (fingerprints unchanged).
	if (snapshot.generation < subscriber.lastGeneration) {
		logger.warn("auth-broker stream generation went backwards", {
			peer: subscriber.peer,
			previous: subscriber.lastGeneration,
			current: snapshot.generation,
		});
	}
	subscriber.lastGeneration = snapshot.generation;
	for (let index = 0; index < snapshot.credentials.length; index += 1) {
		const entry = snapshot.credentials[index]!;
		const fingerprint = frame.fingerprints[index]!;
		if (subscriber.sent.get(entry.id) === fingerprint) continue;
		subscriber.sent.set(entry.id, fingerprint);
		if (!subscriber.write(frame.entryEvent(index))) return;
		logger.debug("auth-broker stream entry", {
			peer: subscriber.peer,
			id: entry.id,
			provider: entry.provider,
			generation: snapshot.generation,
		});
	}
	for (const id of subscriber.sent.keys()) {
		if (frame.ids.has(id)) continue;
		subscriber.sent.delete(id);
		if (!subscriber.write(frame.removedEvent(id))) return;
		logger.debug("auth-broker stream removed", { peer: subscriber.peer, id, generation: snapshot.generation });
	}
}

/**
 * Fans generation bumps out to every open snapshot stream. A bump polls the
 * store once, builds one snapshot per client flavour, and fingerprints and
 * encodes each changed entry once; per-connection work is a fingerprint
 * compare plus an enqueue of the shared frame.
 */
class SnapshotStreamHub {
	readonly #storage: AuthStorage;
	readonly #source: SnapshotSource;
	readonly #subscribers = new Set<SnapshotStreamSubscriber>();
	#unsubscribe: (() => void) | undefined;
	#processing = false;
	#bumpPending = false;

	constructor(storage: AuthStorage, source: SnapshotSource) {
		this.#storage = storage;
		this.#source = source;
	}

	add(subscriber: SnapshotStreamSubscriber): void {
		this.#subscribers.add(subscriber);
		this.#unsubscribe ??= this.#storage.credentials.onGeneration(() => {
			void this.#processGenerationBump();
		});
	}

	delete(subscriber: SnapshotStreamSubscriber): void {
		this.#subscribers.delete(subscriber);
		if (this.#subscribers.size > 0) return;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	close(): void {
		this.#subscribers.clear();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	async #processGenerationBump(): Promise<void> {
		if (this.#processing) {
			this.#bumpPending = true;
			return;
		}
		this.#processing = true;
		try {
			do {
				this.#bumpPending = false;
				try {
					await this.#source.reload();
				} catch (error) {
					// The in-memory pool is still serviceable; deliver what it holds.
					logger.debug("auth-broker stream store reload failed", { error: String(error) });
				}
				if (this.#subscribers.size === 0) return;
				try {
					this.#fanOut();
				} catch (error) {
					logger.warn("auth-broker stream fan-out failed", { error: String(error) });
				}
			} while (this.#bumpPending && this.#subscribers.size > 0);
		} finally {
			this.#processing = false;
		}
	}

	#fanOut(): void {
		const frames = new Map<boolean, SnapshotStreamFrame>();
		for (const subscriber of Array.from(this.#subscribers)) {
			let frame = frames.get(subscriber.codexMeterBlockScopes);
			if (!frame) {
				frame = new SnapshotStreamFrame(this.#source.build(subscriber.codexMeterBlockScopes));
				frames.set(subscriber.codexMeterBlockScopes, frame);
			}
			deliverStreamFrame(subscriber, frame);
		}
	}
}

function serveSnapshotStream(
	req: Request,
	source: SnapshotSource,
	hub: SnapshotStreamHub,
	peer: string,
	keepaliveMs: number,
): Response {
	const openedAt = Date.now();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let keepaliveTimer: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | null = null;
	let closed = false;

	const cleanup = (): void => {
		if (closed) return;
		closed = true;
		if (keepaliveTimer !== undefined) {
			clearInterval(keepaliveTimer);
			keepaliveTimer = undefined;
		}
		hub.delete(subscriber);
		if (abortHandler) {
			req.signal.removeEventListener("abort", abortHandler);
			abortHandler = null;
		}
		try {
			controller?.close();
		} catch {
			// Already closed by Bun on client disconnect; harmless.
		}
		logger.info("auth-broker stream closed", { peer, durationMs: Date.now() - openedAt });
	};

	const write = (chunk: Uint8Array): boolean => {
		if (closed || !controller) return false;
		try {
			controller.enqueue(chunk);
			return true;
		} catch (err) {
			logger.debug("auth-broker stream enqueue failed", { peer, error: String(err) });
			cleanup();
			return false;
		}
	};

	const subscriber: SnapshotStreamSubscriber = {
		peer,
		codexMeterBlockScopes: supportsCodexMeterBlockScopes(req),
		sent: new Map(),
		lastGeneration: -1,
		write,
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(c) {
			controller = c;
			await source.reload();
			const initial = source.build(subscriber.codexMeterBlockScopes);
			subscriber.lastGeneration = initial.generation;
			for (const entry of initial.credentials) subscriber.sent.set(entry.id, fingerprintEntry(entry));
			const initialEvent: SnapshotStreamSnapshotEvent = { kind: "snapshot", ...initial };
			if (!write(sseEvent("snapshot", initialEvent))) return;
			keepaliveTimer = setInterval(() => {
				write(SSE_KEEPALIVE);
			}, keepaliveMs);
			keepaliveTimer.unref?.();
			// Registered synchronously after the initial build: any later fan-out
			// builds a snapshot at least as new as the one this client just got.
			hub.add(subscriber);
			abortHandler = (): void => cleanup();
			req.signal.addEventListener("abort", abortHandler);
			logger.info("auth-broker stream opened", { peer, generation: initial.generation });
		},
		cancel() {
			cleanup();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
			Vary: AUTH_BROKER_CAPABILITIES_HEADER,
		},
	});
}

/** Boot the broker. Caller owns lifecycle; `handle.close()` to stop. */
export function startAuthBroker(opts: AuthBrokerServerOptions): AuthBrokerServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_BROKER_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version;
	const streamKeepaliveMs = opts.streamKeepaliveMs ?? DEFAULT_STREAM_KEEPALIVE_MS;
	const externalChangePollMs = opts.externalChangePollMs ?? DEFAULT_EXTERNAL_CHANGE_POLL_MS;

	const refresher = opts.disableRefresher
		? undefined
		: new AuthBrokerRefresher({
				storage: opts.storage,
				refreshSkewMs: opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
				refreshIntervalMs: opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
			});
	refresher?.start();
	const snapshotSource = new SnapshotSource(opts.storage, refresher);
	const generationGate = new GenerationGate(opts.storage, externalChangePollMs);
	const streamHub = new SnapshotStreamHub(opts.storage, snapshotSource);

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		idleTimeout: DEFAULT_SERVER_IDLE_TIMEOUT_S,
		fetch: async (req, server): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const socketPeer = server.requestIP(req)?.address ?? "unknown";
			try {
				if (req.method === "GET" && pathname === "/v1/healthz") {
					const body: HealthzResponse = { ok: true, version };
					return json(200, body);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-broker request unauthorized", {
						method: req.method,
						path: loggablePath(pathname),
						peer: socketPeer,
					});
					return json(401, { error: "unauthorized" });
				}
				const peer = resolvePeer(req, socketPeer, opts.trustProxyHeaders);
				if (req.method === "GET" && pathname === "/v1/snapshot/stream") {
					return serveSnapshotStream(req, snapshotSource, streamHub, peer, streamKeepaliveMs);
				}
				if (req.method === "GET" && pathname === "/v1/snapshot") {
					return serveSnapshot(req, url, snapshotSource, generationGate, peer);
				}
				if (req.method === "GET" && pathname === "/v1/usage") {
					try {
						// AuthStorage caches usage reports internally with a 5-minute per-credential
						// TTL (USAGE_REPORT_TTL_MS) so back-to-back widget polls re-use the
						// last fetch instead of hitting provider endpoints repeatedly.
						// `req.signal` propagates HTTP-client disconnects all the way to the
						// per-caller cancel without touching the shared upstream fetch.
						const reports = (await opts.storage.usage.reports?.({ signal: req.signal })) ?? [];
						// Drop the `raw` field — it's the provider-specific upstream body,
						// large and unstable. Everything UI-relevant lives in `limits` and
						// `metadata`.
						const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
						logger.info("auth-broker usage served", { peer, reports: trimmed.length });
						return json(200, { generatedAt: Date.now(), reports: trimmed });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker usage fetch failed", { peer, error: message });
						return json(502, { error: message });
					}
				}
				if (req.method === "GET" && pathname === "/v1/usage/history") {
					const sinceMsRaw = url.searchParams.get("sinceMs");
					const sinceMsParsed = sinceMsRaw === null ? undefined : Number.parseInt(sinceMsRaw, 10);
					const sinceMs =
						sinceMsParsed !== undefined && Number.isFinite(sinceMsParsed) ? sinceMsParsed : undefined;
					const provider = url.searchParams.get("provider") ?? undefined;
					const entries = opts.storage.usage.history({ sinceMs, provider });
					logger.info("auth-broker usage history served", { peer, entries: entries.length, sinceMs, provider });
					return json(200, { generatedAt: Date.now(), entries });
				}
				if (req.method === "POST" && pathname === "/v1/usage/observed") {
					const parsed = await parseBody(req, clientUsageReportRequestSchema);
					if (!parsed.ok) return parsed.response;
					// Arktype's inferred union collides the `entries` field with
					// Array.prototype.entries; the schema already validated the shape.
					const report = parsed.data as ClientUsageReportRequest;
					try {
						const recorded = opts.storage.usage.recordClient(report);
						if (!recorded) return json(501, { error: "broker store does not persist client usage" });
						logger.debug("auth-broker client usage recorded", {
							peer,
							installId: report.installId,
							hostname: report.hostname,
							entries: report.entries.length,
						});
						return json(200, { ok: true });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker client usage record failed", { peer, error: message });
						return json(500, { error: message });
					}
				}
				if (req.method === "GET" && pathname === "/v1/usage/clients") {
					const sinceMsRaw = url.searchParams.get("sinceMs");
					const sinceMsParsed = sinceMsRaw === null ? Number.NaN : Number.parseInt(sinceMsRaw, 10);
					const summary = opts.storage.usage.clientSummary(Number.isFinite(sinceMsParsed) ? sinceMsParsed : 0);
					return json(200, { generatedAt: Date.now(), clients: summary.clients });
				}
				if (req.method === "POST" && pathname === "/v1/usage/stale") {
					const provider = url.searchParams.get("provider") || undefined;
					try {
						await opts.storage.usage.invalidate?.(provider);
						logger.info("auth-broker usage cache invalidated", { peer, provider });
						return json(200, { ok: true });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker usage cache invalidation failed", { peer, error: message });
						return json(500, { error: message });
					}
				}
				if (req.method === "GET" && pathname === "/v1/credentials/disabled") {
					const provider = url.searchParams.get("provider") ?? undefined;
					const disabled = await opts.storage.credentials.listDisabled(provider, req.signal);
					const body: DisabledCredentialsResponse = { generatedAt: Date.now(), disabled };
					return json(200, body);
				}
				const refreshMatch = req.method === "POST" ? pathname.match(REFRESH_ROUTE) : null;
				if (refreshMatch) {
					const id = Number.parseInt(refreshMatch[1], 10);
					const authRecovery = url.searchParams.get("reason") === "auth-recovery";
					try {
						const entry = await opts.storage.oauth.refresh(
							id,
							req.signal,
							authRecovery ? AUTH_RECOVERY_REFRESH_OPTIONS : undefined,
						);
						const body: CredentialRefreshResponse = { entry };
						logger.info("auth-broker credential refreshed", {
							id,
							provider: entry.provider,
							peer,
							expires: entry.credential.type === "oauth" ? entry.credential.expires : undefined,
						});
						return json(200, body);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker refresh failed", { id, peer, error: message });
						const status = message.includes("No credential with id") ? 404 : 500;
						return json(status, { error: message });
					}
				}
				const disableMatch = req.method === "POST" ? pathname.match(DISABLE_ROUTE) : null;
				if (disableMatch) {
					const id = Number.parseInt(disableMatch[1], 10);
					const parsed = await parseBody(req, credentialDisableRequestSchema, {
						allowEmpty: true,
					});
					if (!parsed.ok) return parsed.response;
					const cause =
						parsed.data.cause && parsed.data.cause.length > 0 ? parsed.data.cause : "disabled via auth-broker";
					const ok = await opts.storage.credentials.disable(id, cause);
					if (!ok) {
						logger.info("auth-broker disable miss", { id, peer, cause });
						return json(404, { error: `No credential with id=${id}` });
					}
					logger.info("auth-broker credential disabled", { id, peer, cause });
					const response: CredentialDisableResponse = { ok: true };
					return json(200, response);
				}
				const blockMatch = req.method === "POST" ? pathname.match(BLOCK_ROUTE) : null;
				if (blockMatch) {
					const id = Number.parseInt(blockMatch[1], 10);
					const parsed = await parseBody(req, credentialBlockRequestSchema);
					if (!parsed.ok) return parsed.response;
					const block: StoredCredentialBlock = {
						credentialId: id,
						providerKey: parsed.data.providerKey,
						blockScope: parsed.data.blockScope,
						blockedUntilMs: parsed.data.blockedUntilMs,
					};
					if (!opts.storage.credentials.snapshot().credentials.some(entry => entry.id === id)) {
						logger.info("auth-broker credential block miss", { id, peer });
						return json(404, { error: `No credential with id=${id}` });
					}
					try {
						opts.storage.blocks.upsert(block);
						const response: CredentialBlockResponse = { ok: true };
						logger.info("auth-broker credential block upserted", {
							id,
							peer,
							providerKey: block.providerKey,
							blockScope: block.blockScope,
							blockedUntilMs: block.blockedUntilMs,
						});
						return json(200, response);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker credential block upsert failed", { id, peer, error: message });
						const status = message.includes("No credential with id") ? 404 : 500;
						return json(status, { error: message });
					}
				}
				const blockDeleteMatch = req.method === "DELETE" ? pathname.match(BLOCK_ROUTE) : null;
				if (blockDeleteMatch) {
					const id = Number.parseInt(blockDeleteMatch[1], 10);
					const parsed = await parseBody(req, credentialBlockDeleteRequestSchema);
					if (!parsed.ok) return parsed.response;
					if (!opts.storage.credentials.snapshot().credentials.some(entry => entry.id === id)) {
						return json(404, { error: `No credential with id=${id}` });
					}
					try {
						opts.storage.blocks.delete(id, parsed.data.providerKey, parsed.data.blockScope);
						const response: CredentialBlocksDeleteResponse = { ok: true };
						logger.info("auth-broker credential block deleted", { id, peer, ...parsed.data });
						return json(200, response);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker credential block delete failed", { id, peer, error: message });
						return json(500, { error: message });
					}
				}
				const blocksDeleteMatch = req.method === "DELETE" ? pathname.match(BLOCKS_ROUTE) : null;
				if (blocksDeleteMatch) {
					const id = Number.parseInt(blocksDeleteMatch[1], 10);
					if (!opts.storage.credentials.snapshot().credentials.some(entry => entry.id === id)) {
						logger.info("auth-broker credential blocks delete miss", { id, peer });
						return json(404, { error: `No credential with id=${id}` });
					}
					try {
						opts.storage.blocks.deleteAll(id);
						const response: CredentialBlocksDeleteResponse = { ok: true };
						logger.info("auth-broker credential blocks deleted", { id, peer });
						return json(200, response);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker credential blocks delete failed", { id, peer, error: message });
						const status = message.includes("No credential with id") ? 404 : 500;
						return json(status, { error: message });
					}
				}
				if (req.method === "POST" && pathname === "/v1/credential") {
					const parsed = await parseBody(req, credentialUploadRequestSchema);
					if (!parsed.ok) return parsed.response;
					const { provider, credential, ifProviderAbsent } = parsed.data;
					try {
						let inserted: boolean | undefined;
						let entries: CredentialUploadResponse["entries"];
						if (ifProviderAbsent) {
							if (credential.type !== "api_key" || credential.source !== undefined) {
								return json(400, { error: "Conditional credential uploads require a generated API key" });
							}
							inserted = await opts.storage.credentials.addGeneratedApiKeyIfAbsent(
								provider,
								credential.key,
								req.signal,
							);
							entries = opts.storage.credentials
								.snapshot()
								.credentials.filter(entry => entry.provider === provider);
						} else {
							entries = await opts.storage.credentials.upsert(provider, credential);
						}
						const identity =
							credential.type === "oauth"
								? (credential.email ?? credential.accountId ?? credential.projectId ?? "(no identity)")
								: "(api key)";
						logger.info(
							ifProviderAbsent ? "auth-broker conditional credential upload" : "auth-broker credential upserted",
							{
								provider,
								type: credential.type,
								identity,
								peer,
								providerTotal: entries.length,
								...(inserted === undefined ? {} : { inserted }),
							},
						);
						const response: CredentialUploadResponse = {
							entries,
							...(inserted === undefined ? {} : { inserted }),
						};
						return json(200, response);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker upload failed", { provider, peer, error: message });
						return json(500, { error: message });
					}
				}
				return json(404, { error: `No route: ${req.method} ${pathname}` });
			} catch (error) {
				logger.error("auth-broker handler crashed", {
					method: req.method,
					path: loggablePath(pathname),
					error: String(error),
				});
				return json(500, { error: "internal error" });
			}
		},
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			refresher?.stop();
			generationGate.close();
			streamHub.close();
			server.stop(true);
		},
	};
}
