/**
 * Cross-process contract for the broker-owned blob daemon.
 *
 * One blob daemon runs per project scope (launched through the same daemon
 * broker that owns the shared Chromium and LSP mux), so every omp process in
 * the project shares one exposure (tunnel or uploader) and one URL per blob.
 * Control traffic rides HTTP over a Unix socket in the daemon runtime dir;
 * public traffic reaches the same store through the exposure.
 */
import * as path from "node:path";
import type { BlobDestinationId } from "./destinations";
import type { BlobPublication, RemoteDeleteAction } from "./publication";
import type { BlobBrokerSavingsStatus } from "./savings";
import type { DestinationRuntimeConfig } from "./uploader-runtime";

/** Hidden CLI selector used to re-enter the blob broker worker. */
export const BLOB_BROKER_WORKER_ARG = "__omp_worker_blob_broker";

/** Environment key carrying the control socket path the worker listens on. */
export const BLOB_BROKER_SOCKET_ENV = "OMP_BLOB_BROKER_SOCKET";

/** Environment key carrying the JSON {@link BlobBrokerWorkerConfig}. */
export const BLOB_BROKER_CONFIG_ENV = "OMP_BLOB_BROKER_CONFIG";

/** Stable broker daemon name for the shared blob broker. */
export const BLOB_BROKER_DAEMON_NAME = "omp.blob.broker";

/** Broker readiness regex matched against the banner printed by the worker. */
export const BLOB_BROKER_READY_PATTERN = String.raw`omp blob broker serving \S+`;

/** Banner printed on stdout once the exposure is up and control is listening. */
export function blobBrokerReadyBanner(baseUrl: string): string {
	return `omp blob broker serving ${baseUrl}`;
}

/** Resolve the control socket path for one project scope. */
export function blobBrokerEndpoint(runtimeDir: string): string {
	return path.join(runtimeDir, "blob-broker.sock");
}

/** Exposure or upload configuration serialized into the worker environment. */
export interface BlobBrokerWorkerConfig {
	kind: BlobDestinationId;
	/** Destination-specific non-secret settings used by the worker. */
	options: DestinationRuntimeConfig["options"];
	/** Destination-specific credentials used by the worker. */
	credentials: DestinationRuntimeConfig["credentials"];
	publicBaseUrl?: string;
	bindHost: string;
	sshTarget?: string;
	sshRemotePort?: number;
	/** Disk persistence for resume-stable publications, tokens, and counters. */
	persist?: {
		blobsDir: string;
		indexPath: string;
		savingsPath: string;
		ttlMs: number;
	};
}

/** `GET /info` — exposure state advertised by the worker. */
export interface BlobBrokerInfo {
	/** Public base URL for served blobs; empty for uploader backends. */
	baseUrl: string;
	/** Whether lazy (render-on-fetch) blobs are supported. */
	lazy: boolean;
}

/**
 * `POST /blob` request body. Probe first (no `data`): a persisted or live
 * registration answers without the bytes ever crossing the socket; only a
 * miss pays the transfer.
 */
export interface EnsureBlobRequest {
	/** Content hash key (caller-computed, stable across processes). */
	key: string;
	mimeType: string;
	/** Base64 blob bytes; omitted on the probe round. */
	data?: string;
}

/** `POST /lazy` request body. */
export interface EnsureLazyRequest {
	key: string;
	mimeType: string;
	/** Loopback port of the owning session's render callback server. */
	callbackPort: number;
	/** Bearer token the daemon presents to the callback server. */
	callbackToken: string;
}

/** Response body for `POST /blob` and `POST /lazy`. */
export interface EnsureBlobResponse {
	/** Durable publication returned by the selected backend. */
	publication?: BlobPublication;
	/** Probe outcome: unknown key, bytes required. */
	missing?: boolean;
}

/** Maximum number of fetch-attribution events retained by a blob store. */
export const BLOB_FETCH_EVENT_LIMIT = 100;

/** Cumulative and instantaneous counters reported by the blob store. */
export interface BlobBrokerMetrics {
	/** Registrations currently addressable by a capability token. */
	activeBlobs: number;
	/** Active registrations backed by eager bytes. */
	eagerBlobs: number;
	/** Active registrations backed by a lazy producer. */
	lazyBlobs: number;
	/** Bytes currently retained in the in-memory cache. */
	residentBytes: number;
	/** Bytes referenced by eager registrations in the disk store. */
	diskBytes: number;
	/** Response-body bytes served by successful GET requests. */
	bytesServed: number;
	/** Successful public GET or HEAD requests. */
	hits: number;
	/** Public GET or HEAD requests that could not produce bytes. */
	misses: number;
	/** Successful GET requests for a token already fetched by GET. */
	duplicateTokenGets: number;
}

/** One bounded telemetry record attributing a public fetch. */
export interface BlobFetchAttributionEvent {
	/** Catalog fetcher identifier, or `null` when unrecognized. */
	fetcherId: string | null;
	/** Whether multiple request signals corroborated the identification. */
	corroborated: boolean;
	/** Unix epoch milliseconds when the request reached the store. */
	timestamp: number;
	/** Public read method used by the fetcher. */
	method: "GET" | "HEAD";
	/** Whether the capability token identified an active registration. */
	found: boolean;
	/** Non-secret tail of the capability token, or `null` when absent. */
	tokenSuffix: string | null;
}

/** Store snapshot embedded in daemon status and diagnostics. */
export interface BlobStoreStatus {
	/** Current aggregate counters. */
	metrics: BlobBrokerMetrics;
	/** Newest retained fetch-attribution events in chronological order. */
	recentFetches: readonly BlobFetchAttributionEvent[];
}

/** `GET /status` response for daemon and backend health inspection. */
export interface BlobBrokerStatus extends BlobBrokerInfo, BlobStoreStatus {
	/** Stable hash of the worker configuration. */
	configKey: string;
	/** Aggregate inline-versus-reference bytes recorded for this project. */
	savings: BlobBrokerSavingsStatus;
}

/** One diagnostic check emitted by a doctor request. */
export interface BlobBrokerDoctorCheck {
	/** Stable machine-readable check name. */
	name: string;
	/** Whether the check succeeded. */
	ok: boolean;
	/** Severity used by the CLI to distinguish warnings from hard failures. */
	status: "pass" | "warn" | "fail";
	/** Human-readable result detail. */
	detail: string;
}

/** `POST /doctor` request selecting active checks. */
export interface BlobBrokerDoctorRequest {
	/** Include a live public health request; defaults to `true`. */
	probe?: boolean;
}

/** `POST /doctor` response with daemon status and checks. */
export interface BlobBrokerDoctorResponse {
	/** Store and exposure snapshot observed by the doctor. */
	status: BlobBrokerStatus;
	/** Diagnostic checks in execution order. */
	checks: readonly BlobBrokerDoctorCheck[];
}

/** `POST /probe` request for the configured destination's public health endpoint. */
export interface BlobBrokerProbeRequest {
	/** Per-attempt public request timeout in milliseconds. */
	timeoutMs?: number;
}

/** `POST /probe` response from an actual public health request. */
export interface BlobBrokerProbeResponse {
	/** Whether the public health endpoint answered successfully. */
	ok: boolean;
	/** Elapsed wall-clock time for the health request. */
	durationMs: number;
	/** Non-secret diagnostic result. */
	detail: string;
}

/** `POST /purge` request selecting registrations to remove. */
export interface BlobBrokerPurgeRequest {
	/** Execute remote deletion requests and remove registrations. Defaults to dry-run. */
	apply?: boolean;
	/** Explicitly select every registration instead of the safe expired-only default. */
	all?: boolean;
	/** Remove only entries whose serving windows have expired. */
	expiredOnly?: boolean;
	/** Remove entries last registered before this Unix epoch millisecond. */
	before?: number;
}

/** `POST /purge` response describing removed registrations. */
export interface BlobBrokerPurgeResponse {
	/** Whether this request performed mutations. */
	applied: boolean;
	/** Number of registrations selected (dry-run) or removed (apply). */
	purgedBlobs: number;
	/** Resident and disk bytes selected (dry-run) or no longer referenced (apply). */
	reclaimedBytes: number;
	/** Publications carrying any remote cleanup metadata needed by callers. */
	publications: readonly BlobPublication[];
	/** Replayable remote deletions extracted from selected publications. */
	remoteDeletes: readonly RemoteDeleteAction[];
	/** Number of remote deletion requests attempted. */
	attempted: number;
	/** Number of remote deletion requests that succeeded. */
	deleted: number;
	/** Redacted remote deletion failures. */
	errors: readonly string[];
}

/** Path prefix of the session-side render callback server. */
export const RENDER_CALLBACK_PATH = "/render/";
/** Header carrying {@link EnsureLazyRequest.callbackToken} on render callbacks. */
export const RENDER_CALLBACK_TOKEN_HEADER = "x-omp-blob-token";
