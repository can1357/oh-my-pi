/**
 * Cross-process contract for the daemon-hosted blob broker (`blob` module).
 *
 * One `blob` unit runs in the omp daemon per (project scope, config key), so
 * every omp process in a project with the same image URL settings shares one
 * exposure (tunnel or uploader) and one URL per blob. Control traffic is
 * `call("blob", method, params, { unit })` ({@link BlobBrokerCalls}); lazy
 * blobs render through a tunnel on {@link BLOB_RENDER_CHANNEL} back into the
 * registering session. Public traffic reaches the store through the exposure.
 */
import type { BlobDestinationId } from "./destinations";
import type { BlobPublication, RemoteDeleteAction } from "./publication";
import type { BlobBrokerSavingsStatus } from "./savings";
import type { DestinationProcessContext, DestinationRuntimeConfig } from "./uploader-runtime";

/** Daemon unit kind and `call` module name. */
export const BLOB_BROKER_KIND = "blob";

/** Tunnel channel on which the daemon asks the registering session to render lazy blobs. */
export const BLOB_RENDER_CHANNEL = "render";

/** Stable identity for a worker config; the unit key, so differing configs get differing units. */
export function blobBrokerConfigKey(config: BlobBrokerWorkerConfig): string {
	return Bun.hash(JSON.stringify(config)).toString(16);
}

/** `open` params of a `blob` unit. Credentials ride in `config`; never log them. */
export interface BlobUnitParams {
	config: BlobBrokerWorkerConfig;
	/** Environment and cwd of the opening client, for tunnel and uploader children. */
	spawn: DestinationProcessContext;
	/** How long a lazy render may take before its fetch answers 410 (ms); default 30 s, at most 60 s. */
	renderTimeoutMs?: number;
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

/** `info` call result: exposure state advertised by the unit. */
export interface BlobBrokerInfo {
	/** Public base URL for served blobs; empty for uploader backends. */
	baseUrl: string;
	/** Whether lazy (render-on-fetch) blobs are supported. */
	lazy: boolean;
	/** {@link blobBrokerConfigKey} of the unit's config. */
	configKey: string;
}

/**
 * `blob` call params. Probe first (no `data`): a persisted or live
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

/** `lazy` call params. */
export interface EnsureLazyRequest {
	key: string;
	mimeType: string;
	/** Owner id the caller announced on its {@link BLOB_RENDER_CHANNEL} tunnel. */
	owner: string;
}

/** Result of the `blob` and `lazy` calls. */
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

/** `status` call result for daemon and backend health inspection. */
export interface BlobBrokerStatus extends BlobBrokerInfo, BlobStoreStatus {
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

/** `doctor` call params selecting active checks. */
export interface BlobBrokerDoctorRequest {
	/** Include a live public health request; defaults to `true`. */
	probe?: boolean;
}

/** `doctor` call result with daemon status and checks. */
export interface BlobBrokerDoctorResponse {
	/** Store and exposure snapshot observed by the doctor. */
	status: BlobBrokerStatus;
	/** Diagnostic checks in execution order. */
	checks: readonly BlobBrokerDoctorCheck[];
}

/** `probe` call params for the configured destination's public health endpoint. */
export interface BlobBrokerProbeRequest {
	/** Per-attempt public request timeout in milliseconds. */
	timeoutMs?: number;
}

/** `probe` call result from an actual public health request. */
export interface BlobBrokerProbeResponse {
	/** Whether the public health endpoint answered successfully. */
	ok: boolean;
	/** Elapsed wall-clock time for the health request. */
	durationMs: number;
	/** Non-secret diagnostic result. */
	detail: string;
}

/** `purge` call params selecting registrations to remove. */
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

/** `purge` call result describing removed registrations. */
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

/** First line a client sends on its {@link BLOB_RENDER_CHANNEL} tunnel. */
export interface BlobRenderHello {
	owner: string;
}

/** Daemon -> client line on the render tunnel: produce the bytes of lazy blob `key`. */
export interface BlobRenderRequest {
	id: number;
	key: string;
}

/** Client -> daemon line answering a {@link BlobRenderRequest}. */
export type BlobRenderResponse = { id: number; mime: string; base64: string } | { id: number; error: string };

/** `call("blob", method)` params and results. */
export interface BlobBrokerCalls {
	info: { params: Record<string, never>; result: BlobBrokerInfo };
	status: { params: Record<string, never>; result: BlobBrokerStatus };
	doctor: { params: BlobBrokerDoctorRequest; result: BlobBrokerDoctorResponse };
	probe: { params: BlobBrokerProbeRequest; result: BlobBrokerProbeResponse };
	purge: { params: BlobBrokerPurgeRequest; result: BlobBrokerPurgeResponse };
	blob: { params: EnsureBlobRequest; result: EnsureBlobResponse };
	lazy: { params: EnsureLazyRequest; result: EnsureBlobResponse };
}
