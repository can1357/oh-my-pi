/**
 * Runtime local Collab host registry.
 *
 * Every connected Collab host publishes a private, per-process IPC endpoint
 * (Unix domain socket on POSIX, named pipe on Windows) so that a separate local
 * process can discover live hosts and, on explicit request, retrieve a
 * shareable URL. The registry exposes two contracts over that endpoint:
 *
 * - `snapshot`: non-capability metadata (identity, session, cwd, model,
 *   participants, relay/attention/activity state) suitable for listing and
 *   polling;
 * - `link`: one browser URL for one exact host generation and access level,
 *   rejected when the generation moved or the access level is not published.
 *
 * Full-control and view-only URLs, room keys, and write tokens stay in host
 * memory; disk carries only ephemeral discovery metadata (protocol version,
 * instance ID, PID, endpoint, creation time, random bearer token) with
 * owner-only permissions. Endpoints die with the host process, so a crash
 * leaves at most stale metadata that the next list operation prunes best-effort.
 *
 * Transport follows the launch daemon broker conventions: node `net` servers,
 * newline-delimited JSON envelopes, per-request bearer authentication, and
 * bounded buffers. Guests never publish; this registry is host-only.
 */
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";
import { getBaseConfigRoot } from "@oh-my-pi/pi-utils";
import {
	handleLocalEndpointRequest,
	type LocalEndpointMetadata,
	type LocalEndpointQueryResult,
	type LocalEndpointRegistry,
	listLocalEndpoints,
	publishLocalEndpoint,
	queryLocalEndpoint,
} from "../ipc/local-endpoint-registry";

/** Discovery metadata / IPC protocol version. Mixed omp versions fail safely. */
export const COLLAB_REGISTRY_VERSION = 1;

/** Reject request lines beyond this size; a valid request is <300 bytes. */
const MAX_REQUEST_BYTES = 4 * 1024;
/** Reject responses beyond this size. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/**
 * Longest string any snapshot field is sent with. Session names, imported
 * session ids, and working directories have no length limit of their own;
 * bounding them here keeps every valid snapshot response (five such fields,
 * worst case fully escaped) well inside {@link MAX_RESPONSE_BYTES}, so an
 * unusual title never makes an otherwise healthy host invisible.
 */
const MAX_SNAPSHOT_FIELD_CHARS = 1024;
/** Per-entry connect+response deadline during listing. */
const DEFAULT_QUERY_TIMEOUT_MS = 1_500;

/** Access a link grants: `view` (bare room key) or `control` (room key + write token). */
export type CollabAccess = "view" | "control";

/**
 * Non-capability host state, computed by the host process at query time.
 * Free-form strings (session id and name, cwd, model) are bounded to
 * {@link MAX_SNAPSHOT_FIELD_CHARS} characters on the wire.
 */
export interface CollabHostSnapshot {
	/** Random per-process identity; stable across the host's room generations. */
	instanceId: string;
	/** Increments every time this process starts a new room (session switch, restart). */
	generation: number;
	/** Host process ID. */
	pid: number;
	/** Session ID of the hosted conversation. */
	sessionId: string;
	/** Human-readable session name, when one is set. */
	sessionName: string | null;
	/** Host working directory. */
	cwd: string;
	/** Model the host session is currently using, when one is selected. */
	model: { provider: string; id: string } | null;
	/** Epoch milliseconds when the host first connected to the relay. */
	startedAt: number;
	/** Current participant count, including the host. */
	participants: number;
	/** Whether the host currently holds an open relay connection. */
	relayConnected: boolean;
	/** Whether a host-side question is waiting for an answer a writable guest could give. */
	inputRequired: boolean;
	/**
	 * Whether the session is running a turn: streaming a response or executing
	 * tools. A poller watching this fall from `true` to `false` sees the host
	 * stop working while it is still published, which no other field reports —
	 * disappearing from discovery means the process died or became unreachable,
	 * not that the agent finished.
	 *
	 * `null` when the host does not report it (an omp older than this field).
	 * Unknown is not idle: a consumer must not read the absence as a session
	 * that stopped.
	 */
	busy: boolean | null;
	/** Highest access the registry will hand out for this host. */
	access: CollabAccess;
}

/** Live host state served over the IPC endpoint. */
export interface CollabHostRegistrySource {
	/** Current metadata; throws when the host can no longer vouch for its session. */
	snapshot(): CollabHostSnapshot;
	/** Browser URL for `access`, or `null` when that access is not published. */
	link(access: CollabAccess): string | null;
}

/** One resolved capability returned by {@link resolveCollabHostLink}. */
export interface CollabResolvedLink {
	instanceId: string;
	generation: number;
	access: CollabAccess;
	url: string;
}

/** Handle returned by {@link publishCollabHost}; closing withdraws the host. */
export interface CollabHostPublication {
	/** Endpoint the host listens on (test/diagnostic use; not secret). */
	readonly endpoint: string;
	/** Stop serving requests and remove the discovery metadata. Idempotent. */
	close(): Promise<void>;
}

export interface CollabRegistryOptions {
	/** Override the discovery metadata directory (tests). */
	dir?: string;
}

export interface CollabPublishOptions extends CollabRegistryOptions {
	/**
	 * Identity recorded in the metadata and matched by `omp collab link <id>`.
	 * Defaults to a fresh random ID; a host that rotates rooms passes its
	 * process-lifetime instance ID so the replacement room keeps the same id.
	 * The metadata file and endpoint are always named per publication, so a
	 * stale entry and its successor never share artifacts.
	 */
	instanceId?: string;
	/**
	 * Base for the short socket directory used when the canonical socket path
	 * would overflow `sun_path`. Defaults to `/tmp`; tests point it elsewhere.
	 */
	socketFallbackBase?: string;
}

export interface CollabListOptions extends CollabRegistryOptions {
	/** Per-entry query deadline in milliseconds. */
	timeoutMs?: number;
}

/** Stable failure codes for {@link resolveCollabHostLink}; never carry URLs. */
export type CollabLinkErrorCode = "not_found" | "ambiguous" | "stale_generation" | "access_unavailable" | "unreachable";

export class CollabLinkError extends Error {
	readonly code: CollabLinkErrorCode;
	constructor(code: CollabLinkErrorCode, message: string) {
		super(message);
		this.name = "CollabLinkError";
		this.code = code;
	}
}

/**
 * Discovery metadata directory. Deliberately under the profile-independent
 * config root (`~/.omp/run/collab-hosts`) — unlike the launch broker's
 * profile-scoped runtime dir — so hosts started under any profile are
 * discoverable from any other (issue #6099 user story 18).
 */
export function collabHostsRuntimeDir(): string {
	return path.join(getBaseConfigRoot(), "run", "collab-hosts");
}

type DiscoveryMetadata = LocalEndpointMetadata;

const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

function registryFor(dir: string): LocalEndpointRegistry {
	return {
		dir,
		pipePrefix: "omp-collab",
		version: COLLAB_REGISTRY_VERSION,
		maxRequestBytes: MAX_REQUEST_BYTES,
		maxResponseBytes: MAX_RESPONSE_BYTES,
		requireToken: true,
	};
}

function isAccess(value: unknown): value is CollabAccess {
	return value === "view" || value === "control";
}

function parseSnapshot(raw: unknown): CollabHostSnapshot | null {
	if (typeof raw !== "object" || raw === null) return null;
	const host = raw as Record<string, unknown>;
	if (typeof host.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(host.instanceId)) return null;
	if (typeof host.generation !== "number" || !Number.isInteger(host.generation) || host.generation < 1) return null;
	if (typeof host.pid !== "number" || !Number.isInteger(host.pid)) return null;
	if (typeof host.sessionId !== "string") return null;
	if (host.sessionName !== null && typeof host.sessionName !== "string") return null;
	if (typeof host.cwd !== "string") return null;
	let model: CollabHostSnapshot["model"] = null;
	if (host.model !== null) {
		if (typeof host.model !== "object" || host.model === null) return null;
		const { provider, id } = host.model as Record<string, unknown>;
		if (typeof provider !== "string" || typeof id !== "string") return null;
		model = { provider, id };
	}
	if (typeof host.startedAt !== "number") return null;
	if (typeof host.participants !== "number") return null;
	if (typeof host.relayConnected !== "boolean") return null;
	if (typeof host.inputRequired !== "boolean") return null;
	// `busy` was added after the protocol version shipped, and the version is a
	// hard gate on both sides: bumping it would make every host invisible to a
	// differently versioned lister on the same machine. So an older host's
	// snapshot simply omits the field, and a missing one reads as unknown
	// (`null`) rather than rejecting an otherwise healthy host.
	if (host.busy !== undefined && host.busy !== null && typeof host.busy !== "boolean") return null;
	if (!isAccess(host.access)) return null;
	return {
		instanceId: host.instanceId,
		generation: host.generation,
		pid: host.pid,
		sessionId: host.sessionId,
		sessionName: host.sessionName,
		cwd: host.cwd,
		model,
		startedAt: host.startedAt,
		participants: host.participants,
		relayConnected: host.relayConnected,
		inputRequired: host.inputRequired,
		busy: typeof host.busy === "boolean" ? host.busy : null,
		access: host.access,
	};
}

function boundField(value: string): string {
	return value.length > MAX_SNAPSHOT_FIELD_CHARS ? value.slice(0, MAX_SNAPSHOT_FIELD_CHARS) : value;
}

/** The snapshot as sent on the wire: every free-form string bounded to {@link MAX_SNAPSHOT_FIELD_CHARS}. */
function boundSnapshot(snapshot: CollabHostSnapshot): CollabHostSnapshot {
	return {
		...snapshot,
		sessionId: boundField(snapshot.sessionId),
		sessionName: snapshot.sessionName === null ? null : boundField(snapshot.sessionName),
		cwd: boundField(snapshot.cwd),
		model: snapshot.model
			? { provider: boundField(snapshot.model.provider), id: boundField(snapshot.model.id) }
			: null,
	};
}

/** One request per connection: authenticate, dispatch the op, respond, close. */
function handleConnection(
	socket: net.Socket,
	registry: LocalEndpointRegistry,
	token: string,
	source: CollabHostRegistrySource,
): void {
	handleLocalEndpointRequest(socket, registry, token, request => {
		const { op, access, generation } = request;
		let snapshot: CollabHostSnapshot;
		try {
			snapshot = source.snapshot();
		} catch {
			return { ok: false, error: "snapshot_unavailable" };
		}
		if (op === "snapshot") return { ok: true, snapshot: boundSnapshot(snapshot) };
		if (op !== "link") return { ok: false, error: "invalid_operation" };
		if (!isAccess(access)) return { ok: false, error: "invalid_access" };
		// Resolve against the generation listed, never a successor room.
		if (generation !== snapshot.generation) return { ok: false, error: "stale_generation" };
		if (access === "control" && snapshot.access !== "control") return { ok: false, error: "access_unavailable" };
		let url: string | null;
		try {
			url = source.link(access);
		} catch {
			return { ok: false, error: "snapshot_unavailable" };
		}
		return url ? { ok: true, url } : { ok: false, error: "access_unavailable" };
	});
}

/**
 * Publish a live Collab host to the local registry.
 *
 * Creates the owner-only runtime dir, starts a private IPC endpoint backed by
 * `source`, and writes discovery metadata (never URLs or room secrets).
 * Call {@link CollabHostPublication.close} on every teardown path; a process
 * exit hook removes the on-disk state for normal shutdown, and the OS closing
 * the endpoint covers crashes.
 */
export async function publishCollabHost(
	source: CollabHostRegistrySource,
	options?: CollabPublishOptions,
): Promise<CollabHostPublication> {
	const registry = registryFor(options?.dir ?? collabHostsRuntimeDir());
	const token = crypto.randomBytes(32).toString("hex");
	const publication = await publishLocalEndpoint(
		registry,
		socket => handleConnection(socket, registry, token, source),
		{ ...options, extra: { token } },
	);
	return { endpoint: publication.endpoint, close: () => publication.close() };
}

type QueryResult<T> = LocalEndpointQueryResult<T>;

function query(meta: DiscoveryMetadata, request: object, timeoutMs: number): Promise<QueryResult<unknown>> {
	return queryLocalEndpoint(registryFor(collabHostsRuntimeDir()), meta, request, timeoutMs);
}

async function querySnapshot(meta: DiscoveryMetadata, timeoutMs: number): Promise<QueryResult<CollabHostSnapshot>> {
	const result = await query(meta, { op: "snapshot" }, timeoutMs);
	if (result.status !== "ok") return result;
	const snapshot = parseSnapshot((result.value as Record<string, unknown>).snapshot);
	return snapshot ? { status: "ok", value: snapshot } : { status: "skip" };
}

interface LiveEntry {
	meta: DiscoveryMetadata;
	snapshot: CollabHostSnapshot;
}

async function listLiveEntries(options?: CollabListOptions): Promise<LiveEntry[]> {
	const registry = registryFor(options?.dir ?? collabHostsRuntimeDir());
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
	const entries = await listLocalEndpoints(registry, async entry => {
		if (typeof entry.meta.token !== "string" || entry.meta.token.length === 0) return { status: "skip" };
		return querySnapshot(entry.meta, timeoutMs);
	});
	const live: LiveEntry[] = entries.map(({ entry, value }) => ({ meta: entry.meta, snapshot: value }));
	live.sort(
		(a, b) =>
			a.snapshot.startedAt - b.snapshot.startedAt ||
			a.snapshot.pid - b.snapshot.pid ||
			a.snapshot.instanceId.localeCompare(b.snapshot.instanceId),
	);
	return live;
}

/**
 * List live Collab hosts under this config root.
 *
 * Reads every discovery entry, queries the live hosts concurrently (bounded,
 * short independent deadlines), prunes stale or malformed entries
 * best-effort, and returns healthy hosts sorted by start time, PID, then
 * instance ID. Unreachable, unauthenticated, malformed, or version-mismatched
 * entries are omitted without failing the listing. The result carries no URLs.
 */
export async function listCollabHosts(options?: CollabListOptions): Promise<CollabHostSnapshot[]> {
	return (await listLiveEntries(options)).map(entry => entry.snapshot);
}

/**
 * Resolve one browser URL for the host selected by `selector` — an exact
 * instance ID, or a PID when no instance matches. The link request carries the
 * generation observed while listing, so a host that rotated rooms in between
 * answers `stale_generation` instead of leaking its successor's capability.
 */
export async function resolveCollabHostLink(
	selector: string,
	access: CollabAccess,
	options?: CollabListOptions,
): Promise<CollabResolvedLink> {
	const wanted = selector.trim();
	const live = await listLiveEntries(options);
	let matches = live.filter(entry => entry.snapshot.instanceId === wanted);
	if (matches.length === 0 && /^[1-9][0-9]*$/.test(wanted)) {
		const pid = Number(wanted);
		matches = live.filter(entry => entry.snapshot.pid === pid);
	}
	if (matches.length === 0) {
		throw new CollabLinkError("not_found", `no active Collab host matches ${wanted}`);
	}
	if (matches.length > 1) {
		const ids = matches.map(entry => entry.snapshot.instanceId).join(", ");
		throw new CollabLinkError("ambiguous", `${wanted} matches more than one Collab host; use an instance id: ${ids}`);
	}
	const [{ meta, snapshot }] = matches;
	// No local access precheck: the host decides, and it checks the generation
	// before the access level, so a room that rotated underneath the listing
	// reports `stale_generation` rather than a verdict about its predecessor.
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
	const result = await query(meta, { op: "link", access, generation: snapshot.generation }, timeoutMs);
	if (result.status === "ok") {
		const { url } = result.value as Record<string, unknown>;
		if (typeof url === "string" && url.length > 0) {
			return { instanceId: snapshot.instanceId, generation: snapshot.generation, access, url };
		}
		throw new CollabLinkError("unreachable", `host ${snapshot.instanceId} returned an invalid link response`);
	}
	if (result.status === "skip" && result.error === "stale_generation") {
		throw new CollabLinkError(
			"stale_generation",
			`host ${snapshot.instanceId} started a new room since it was listed; list again and retry`,
		);
	}
	if (result.status === "skip" && result.error === "access_unavailable") {
		throw new CollabLinkError("access_unavailable", `host ${snapshot.instanceId} does not publish ${access} access`);
	}
	if (result.status === "dead") {
		// Every room generation has its own endpoint, so a host that rotated
		// since the listing is simply gone from this one rather than answering
		// `stale_generation` itself. Look the instance up again before giving up.
		const rotated = (await listLiveEntries(options)).some(
			entry => entry.snapshot.instanceId === snapshot.instanceId && entry.snapshot.generation > snapshot.generation,
		);
		if (rotated) {
			throw new CollabLinkError(
				"stale_generation",
				`host ${snapshot.instanceId} started a new room since it was listed; list again and retry`,
			);
		}
	}
	throw new CollabLinkError("unreachable", `host ${snapshot.instanceId} did not answer the link request`);
}
