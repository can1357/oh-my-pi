/**
 * Runtime local Collab host registry.
 *
 * Every ordinary interactive session publishes a private, per-process IPC endpoint
 * (Unix domain socket on POSIX, named pipe on Windows) so that a separate local
 * process can discover live hosts and, on explicit request, retrieve a
 * shareable URL or send an agent-attributed message. The endpoint exposes:
 *
 * - `snapshot`: non-capability metadata (identity, session, cwd, model,
 *   participants, relay/attention/activity state) suitable for listing and
 *   polling;
 * - `link`: one browser URL for one exact host generation and access level,
 *   rejected when the generation moved or the access level is not published.
 * - `send` / `deliver` / `outgoing` / `commit` / `settle`: authenticated messages
 *   with non-authorizing proofs, source-committed authorization, synchronous
 *   receiver admission, and bounded acknowledged withdrawal.
 *
 * Full-control and view-only URLs, room keys, and write tokens stay in host
 * memory; disk carries only ephemeral discovery metadata (protocol version,
 * instance ID, PID, endpoint, creation time, random bearer token) with
 * owner-only permissions. Endpoints die with the host process, so a crash
 * leaves at most stale metadata that the next list operation prunes best-effort.
 *
 * Transport follows the launch daemon broker conventions: the native
 * `IpcServer`/`IpcConnection` line framing, newline-delimited JSON envelopes,
 * per-request bearer authentication, and bounded frames. Guests never publish;
 * this registry is host-only.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, isEnoent, isFsError, isRecord } from "@oh-my-pi/pi-utils";

/** Discovery, snapshot, and link protocol; public message details also remain v1. */
export const COLLAB_REGISTRY_VERSION = 1;
/** Never send a non-authorizing proof to a legacy proof-only receiver. */
export const COLLAB_MESSAGE_PROTOCOL_VERSION = 2;

/** Includes worst-case JSON escaping of a 16 KiB agent message. */
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
/** Never evict a request while its generation remains live: eviction enables replay. */
const MAX_SEND_RECORDS = 1024;
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
/** Proof, commit, and settlement deadlines nest inside delivery, then the caller. */
const ADMISSION_DRAIN_TIMEOUT_MS = 1_500;
const DELIVERY_TIMEOUT_MS = 6_000;
const DEFAULT_SEND_TIMEOUT_MS = 9_000;
/** Concurrency bound for querying discovery entries. */
const LIST_CONCURRENCY = 8;

/** Access a link grants: `view` (bare room key) or `control` (room key + write token). */
export type CollabAccess = "view" | "control";

export const COLLAB_AGENT_MESSAGE_TYPE = "collab:agent-message";

export interface CollabAgentIdentity {
	instanceId: string;
	generation: number;
	sessionId: string;
}

export interface CollabSendRequest {
	requestId: string;
	recipient: { instanceId: string; generation: number };
	text: string;
}

export interface CollabAgentMessageDetails {
	version: 1;
	requestId: string;
	sender: CollabAgentIdentity;
	recipient: CollabAgentIdentity;
	admission: "idle" | "busy";
	admittedAt: number;
}

export interface CollabSendReceipt extends CollabAgentMessageDetails {
	status: "admitted";
}

export type CollabSendErrorCode =
	| "malformed_request"
	| "unsupported_protocol"
	| "authentication_failed"
	| "invalid_operation"
	| "stale_generation"
	| "snapshot_unavailable"
	| "access_unavailable"
	| "sender_unavailable"
	| "recipient_unavailable"
	| "not_found"
	| "ambiguous"
	| "unreachable"
	| "duplicate_mismatch"
	| "ledger_full"
	| "admission_failed"
	| "revocation_incomplete"
	| "closed";

export class CollabSendError extends Error {
	constructor(readonly code: CollabSendErrorCode) {
		super(`Collab agent message failed: ${code}`);
		this.name = "CollabSendError";
	}
}

/**
 * Non-capability host state, computed by the host process at query time.
 * Free-form strings (session id and name, cwd, model) are bounded to
 * {@link MAX_SNAPSHOT_FIELD_CHARS} characters on the wire.
 */
export interface CollabHostSnapshot {
	/** Random per-process identity; stable across session and remote-room generations. */
	instanceId: string;
	/** Advances on session transitions and remote-room changes; never moves backwards. */
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
	/** Epoch milliseconds when the local session or remote host started. */
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
	/** `local` publishes agent messaging only, never a remote browser link. */
	access: CollabAccess | "local";
}

/** Live host state served over the IPC endpoint. */
export interface CollabHostRegistrySource {
	/** Current metadata; throws when the host can no longer vouch for its session. */
	snapshot(): CollabHostSnapshot;
	/** Browser URL for `access`, or `null` when that access is not published. */
	link(access: CollabAccess): string | null;
	/** Enqueue atomically in the current session; must not defer admission across an await. */
	admitAgentMessage?(text: string, details: CollabAgentMessageDetails): void;
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
	/**
	 * Fence new authorization immediately and withdraw discovery. Wait until the
	 * source-local drain deadline for committed receivers to acknowledge settlement.
	 * Missing acknowledgements reject with `revocation_incomplete`: cleanup still
	 * completes, but already-committed admissions may still finish. Idempotent.
	 */
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
}

export interface CollabListOptions extends CollabRegistryOptions {
	/** Per-entry query deadline; for send, overrides the outer request deadline (milliseconds). */
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

interface DiscoveryMetadata {
	version: number;
	instanceId: string;
	pid: number;
	endpoint: string;
	createdAt: number;
	token: string;
}

const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/;
const InstanceId = type(INSTANCE_ID_PATTERN);
const Access = type("'view' | 'control'");

const DiscoveryMetadataShape = type({
	"+": "delete",
	version: "number",
	instanceId: InstanceId,
	pid: "number.integer > 0",
	endpoint: "string > 0",
	createdAt: "number",
	token: "string > 0",
});

function parseDiscoveryMetadata(text: string): DiscoveryMetadata | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	const meta = DiscoveryMetadataShape(raw);
	return meta instanceof type.errors ? null : meta;
}

function tokenMatches(expected: string, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

const SnapshotShape = type({
	"+": "delete",
	instanceId: InstanceId,
	generation: "number.integer >= 1",
	pid: "number.integer",
	sessionId: "string",
	sessionName: "string | null",
	cwd: "string",
	model: type({ "+": "delete", provider: "string", id: "string" }).or("null"),
	startedAt: "number",
	participants: "number",
	relayConnected: "boolean",
	inputRequired: "boolean",
	// `busy` was added after the protocol version shipped, and the version is a
	// hard gate on both sides: bumping it would make every host invisible to a
	// differently versioned lister on the same machine. So an older host's
	// snapshot simply omits the field, and a missing one reads as unknown
	// (`null`) rather than rejecting an otherwise healthy host.
	"busy?": "boolean | null",
	access: Access.or("'local'"),
});

function parseSnapshot(raw: unknown): CollabHostSnapshot | null {
	const snapshot = SnapshotShape(raw);
	if (snapshot instanceof type.errors || !isGeneration(snapshot.generation)) return null;
	return { ...snapshot, busy: snapshot.busy ?? null };
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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isInstanceId(value: unknown): value is string {
	return typeof value === "string" && INSTANCE_ID_PATTERN.test(value);
}

function isRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function parseRecipient(value: unknown): CollabSendRequest["recipient"] | null {
	if (!isRecord(value) || !exactKeys(value, ["instanceId", "generation"])) return null;
	if (!isInstanceId(value.instanceId) || !isGeneration(value.generation)) return null;
	return Object.freeze({ instanceId: value.instanceId, generation: value.generation });
}

function parseIdentity(value: unknown): CollabAgentIdentity | null {
	if (!isRecord(value) || !exactKeys(value, ["instanceId", "generation", "sessionId"])) return null;
	if (!isInstanceId(value.instanceId) || !isGeneration(value.generation)) return null;
	if (typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > MAX_SNAPSHOT_FIELD_CHARS) {
		return null;
	}
	return Object.freeze({ instanceId: value.instanceId, generation: value.generation, sessionId: value.sessionId });
}

function identityOf(snapshot: CollabHostSnapshot): CollabAgentIdentity {
	const identity = parseIdentity({
		instanceId: snapshot.instanceId,
		generation: snapshot.generation,
		sessionId: snapshot.sessionId,
	});
	if (!identity) throw new CollabSendError("snapshot_unavailable");
	return identity;
}

function sameIdentity(a: CollabAgentIdentity, b: CollabAgentIdentity): boolean {
	return a.instanceId === b.instanceId && a.generation === b.generation && a.sessionId === b.sessionId;
}

function sameRecipient(a: CollabSendRequest["recipient"], b: CollabSendRequest["recipient"]): boolean {
	return a.instanceId === b.instanceId && a.generation === b.generation;
}

function parseSendRequest(value: unknown): CollabSendRequest | null {
	if (!isRecord(value) || !exactKeys(value, ["requestId", "recipient", "text"])) return null;
	const recipient = parseRecipient(value.recipient);
	if (!recipient || !isRequestId(value.requestId)) return null;
	if (
		typeof value.text !== "string" ||
		!value.text.trim() ||
		Buffer.byteLength(value.text, "utf8") > MAX_MESSAGE_BYTES
	) {
		return null;
	}
	return Object.freeze({ requestId: value.requestId, recipient, text: value.text });
}

function sameRequest(a: CollabSendRequest, b: CollabSendRequest): boolean {
	return a.requestId === b.requestId && a.text === b.text && sameRecipient(a.recipient, b.recipient);
}

function parseReceipt(value: unknown): CollabSendReceipt | null {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["version", "requestId", "sender", "recipient", "admission", "admittedAt", "status"])
	) {
		return null;
	}
	const sender = parseIdentity(value.sender);
	const recipient = parseIdentity(value.recipient);
	if (!sender || !recipient || !isRequestId(value.requestId) || value.version !== 1 || value.status !== "admitted") {
		return null;
	}
	if (value.admission !== "idle" && value.admission !== "busy") return null;
	if (typeof value.admittedAt !== "number" || !Number.isSafeInteger(value.admittedAt) || value.admittedAt <= 0)
		return null;
	return Object.freeze({
		version: 1,
		requestId: value.requestId,
		sender,
		recipient,
		admission: value.admission,
		admittedAt: value.admittedAt,
		status: "admitted",
	});
}

interface DeliveryRequest {
	sender: CollabAgentIdentity;
	recipient: CollabAgentIdentity;
	requestId: string;
	nonce: string;
}

interface OutgoingMessage {
	sender: CollabAgentIdentity;
	recipient: CollabAgentIdentity;
	request: CollabSendRequest;
}

interface AdmissionAuthorization extends Readonly<DeliveryRequest> {
	readonly authorizationId: string;
}

interface CommittedAdmission {
	readonly authorization: AdmissionAuthorization;
	/** Source-local monotonic deadline bounds draining, not receiver authority. */
	readonly drainDeadline: number;
	readonly settled: Promise<void>;
	readonly resolve: () => void;
}

interface OutboundRecord {
	readonly sender: CollabAgentIdentity;
	readonly request: CollabSendRequest;
	readonly nonce: string;
	readonly promise: Promise<CollabSendReceipt>;
	recipient: CollabAgentIdentity | null;
	/** Only a pending forward may commit new authorization. */
	active: boolean;
	authorization: AdmissionAuthorization | null;
}

interface InboundRecord {
	delivery: DeliveryRequest;
	promise: Promise<CollabSendReceipt>;
}

function isNonce(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function monotonicNow(): number {
	return Number(process.hrtime.bigint() / 1_000_000n);
}

function isMessageOperation(op: unknown): boolean {
	return op === "send" || op === "deliver" || op === "outgoing" || op === "commit" || op === "settle";
}

function parseAuthorization(value: unknown): AdmissionAuthorization | null {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["sender", "recipient", "requestId", "nonce", "authorizationId"]) ||
		!isRequestId(value.requestId) ||
		!isNonce(value.nonce) ||
		!isNonce(value.authorizationId)
	)
		return null;
	const sender = parseIdentity(value.sender);
	const recipient = parseIdentity(value.recipient);
	if (!sender || !recipient) return null;
	return Object.freeze({
		sender: Object.freeze(sender),
		recipient: Object.freeze(recipient),
		requestId: value.requestId,
		nonce: value.nonce,
		authorizationId: value.authorizationId,
	});
}

function sendErrorCode(error: unknown): CollabSendErrorCode {
	switch (error) {
		case "malformed_request":
		case "unsupported_protocol":
		case "authentication_failed":
		case "invalid_operation":
		case "stale_generation":
		case "snapshot_unavailable":
		case "access_unavailable":
		case "sender_unavailable":
		case "recipient_unavailable":
		case "not_found":
		case "ambiguous":
		case "unreachable":
		case "duplicate_mismatch":
		case "ledger_full":
		case "admission_failed":
		case "revocation_incomplete":
		case "closed":
			return error;
		default:
			return "unreachable";
	}
}

function requireQuery(result: QueryResult<unknown>): Record<string, unknown> {
	if (result.status !== "ok") {
		throw new CollabSendError(result.status === "skip" ? sendErrorCode(result.error) : "unreachable");
	}
	if (!isRecord(result.value)) throw new CollabSendError("unreachable");
	return result.value;
}

/** State is per publication; only a strictly newer generation can release its replay ledger. */
class RegistryMessaging {
	#closed = false;
	#closing: Promise<void> | undefined;
	#identity: CollabAgentIdentity | null = null;
	readonly #outbound = new Map<string, OutboundRecord>();
	readonly #inbound = new Map<string, InboundRecord>();
	/** Survives generation changes; never discard unacknowledged commitments. */
	readonly #committed = new Map<string, CommittedAdmission>();

	constructor(
		readonly source: CollabHostRegistrySource,
		readonly instanceId: string,
		readonly dir: string,
	) {}

	close(): Promise<void> {
		this.#closed = true;
		return (this.#closing ??= this.#drain());
	}

	async #drain(): Promise<void> {
		if (this.#committed.size === 0) return;
		const settlements: Promise<void>[] = [];
		let deadline = 0;
		for (const lease of this.#committed.values()) {
			settlements.push(lease.settled);
			deadline = Math.max(deadline, lease.drainDeadline);
		}
		const expired = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => expired.reject(new CollabSendError("revocation_incomplete")),
			Math.max(0, deadline - monotonicNow()),
		);
		try {
			await Promise.race([Promise.all(settlements), expired.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	snapshot(): CollabHostSnapshot {
		if (this.#closed) throw new CollabSendError("closed");
		try {
			return this.source.snapshot();
		} catch {
			throw new CollabSendError("snapshot_unavailable");
		}
	}

	#guard(expected?: CollabAgentIdentity): CollabHostSnapshot {
		const snapshot = this.snapshot();
		const identity = identityOf(snapshot);
		if (identity.instanceId !== this.instanceId) throw new CollabSendError("snapshot_unavailable");
		if (this.#identity && !sameIdentity(identity, this.#identity)) {
			if (identity.generation <= this.#identity.generation) throw new CollabSendError("stale_generation");
			this.#outbound.clear();
			this.#inbound.clear();
		}
		this.#identity = identity;
		if (expected && !sameIdentity(identity, expected)) throw new CollabSendError("stale_generation");
		return snapshot;
	}

	async send(generation: number, request: CollabSendRequest): Promise<CollabSendReceipt> {
		const sender = identityOf(this.#guard());
		if (sender.generation !== generation) throw new CollabSendError("stale_generation");
		let record = this.#outbound.get(request.requestId);
		if (record) {
			if (!sameRequest(record.request, request)) throw new CollabSendError("duplicate_mismatch");
		} else {
			if (this.#outbound.size >= MAX_SEND_RECORDS) throw new CollabSendError("ledger_full");
			const { promise, resolve, reject } = Promise.withResolvers<CollabSendReceipt>();
			const outbound: OutboundRecord = {
				sender,
				request,
				nonce: crypto.randomBytes(32).toString("hex"),
				recipient: null,
				promise,
				active: true,
				authorization: null,
			};
			record = outbound;
			this.#outbound.set(request.requestId, outbound);
			void this.#forward(outbound).then(
				receipt => {
					outbound.active = false;
					resolve(receipt);
				},
				(error: unknown) => {
					outbound.active = false;
					reject(error);
				},
			);
		}
		// A committed admission remains admitted even if the source rotates or
		// closes while its receipt is in flight. Authorization already linearized.
		return record.promise;
	}

	async #forward(record: OutboundRecord): Promise<CollabSendReceipt> {
		const meta = await findMessageEndpoint(record.request.recipient.instanceId, this.dir);
		this.#guard(record.sender);
		const result = await querySnapshot(meta, DEFAULT_QUERY_TIMEOUT_MS);
		this.#guard(record.sender);
		if (result.status !== "ok") throw new CollabSendError("recipient_unavailable");
		const recipient = identityOf(result.value);
		if (!sameRecipient(recipient, record.request.recipient)) throw new CollabSendError("stale_generation");
		record.recipient = recipient;
		const response = await query(
			meta,
			{
				op: "deliver",
				sender: record.sender,
				recipient,
				requestId: record.request.requestId,
				nonce: record.nonce,
			},
			DELIVERY_TIMEOUT_MS,
		);
		const receipt = parseReceipt(requireQuery(response).receipt);
		if (
			!receipt ||
			receipt.requestId !== record.request.requestId ||
			!sameIdentity(receipt.sender, record.sender) ||
			!sameIdentity(receipt.recipient, recipient)
		) {
			throw new CollabSendError("unreachable");
		}
		// A real receipt is also a terminal acknowledgement, independent of the
		// source's current generation/closed state and of the settlement socket.
		if (!record.authorization) throw new CollabSendError("sender_unavailable");
		this.settle(record.authorization, record.authorization.authorizationId);
		return receipt;
	}

	#pendingOutbound(
		generation: number,
		requestId: string,
		nonce: string,
		recipient: CollabAgentIdentity,
	): OutboundRecord {
		const sender = identityOf(this.#guard());
		if (sender.generation !== generation) throw new CollabSendError("stale_generation");
		const record = this.#outbound.get(requestId);
		if (
			!record ||
			!record.active ||
			!tokenMatches(record.nonce, nonce) ||
			!record.recipient ||
			!sameIdentity(record.sender, sender) ||
			!sameIdentity(record.recipient, recipient)
		) {
			throw new CollabSendError("sender_unavailable");
		}
		return record;
	}

	outgoing(generation: number, requestId: string, nonce: string, recipient: CollabAgentIdentity): OutgoingMessage {
		const record = this.#pendingOutbound(generation, requestId, nonce, recipient);
		// Inspection is deliberately not permission to call the receiver.
		return { sender: record.sender, recipient, request: record.request };
	}

	commit(
		generation: number,
		requestId: string,
		nonce: string,
		recipient: CollabAgentIdentity,
	): AdmissionAuthorization {
		const record = this.#pendingOutbound(generation, requestId, nonce, recipient);
		if (record.authorization) {
			if (!this.#committed.has(nonce)) throw new CollabSendError("sender_unavailable");
			return record.authorization;
		}
		if (this.#committed.size >= MAX_SEND_RECORDS) throw new CollabSendError("ledger_full");
		const authorization: AdmissionAuthorization = Object.freeze({
			sender: Object.freeze(record.sender),
			recipient: Object.freeze(recipient),
			requestId,
			nonce,
			authorizationId: crypto.randomBytes(32).toString("hex"),
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		// No await between the live source fence and this authorization commit.
		// Replays share this exact authorization without renewing the drain deadline.
		this.#committed.set(nonce, {
			authorization,
			drainDeadline: monotonicNow() + ADMISSION_DRAIN_TIMEOUT_MS,
			settled: promise,
			resolve,
		});
		record.authorization = authorization;
		return authorization;
	}

	settle(delivery: DeliveryRequest, authorizationId: string): void {
		const lease = this.#committed.get(delivery.nonce);
		if (!lease) return; // Idempotent after an earlier acknowledgement.
		const authorization = lease.authorization;
		if (
			!tokenMatches(authorization.authorizationId, authorizationId) ||
			authorization.requestId !== delivery.requestId ||
			!sameIdentity(authorization.sender, delivery.sender) ||
			!sameIdentity(authorization.recipient, delivery.recipient)
		) {
			throw new CollabSendError("sender_unavailable");
		}
		// Acknowledge old-generation commitments even while withdrawal drains.
		this.#committed.delete(delivery.nonce);
		lease.resolve();
	}

	async deliver(delivery: DeliveryRequest): Promise<CollabSendReceipt> {
		this.#guard(delivery.recipient);
		if (!this.source.admitAgentMessage) throw new CollabSendError("recipient_unavailable");
		const key = JSON.stringify([
			delivery.sender.instanceId,
			delivery.sender.generation,
			delivery.sender.sessionId,
			delivery.requestId,
		]);
		let record = this.#inbound.get(key);
		if (record) {
			if (record.delivery.nonce !== delivery.nonce || !sameIdentity(record.delivery.recipient, delivery.recipient)) {
				throw new CollabSendError("duplicate_mismatch");
			}
		} else {
			if (this.#inbound.size >= MAX_SEND_RECORDS) throw new CollabSendError("ledger_full");
			const { promise, resolve, reject } = Promise.withResolvers<CollabSendReceipt>();
			record = { delivery, promise };
			this.#inbound.set(key, record);
			void this.#admit(delivery).then(resolve, reject);
		}
		return record.promise;
	}

	async #admit(delivery: DeliveryRequest): Promise<CollabSendReceipt> {
		const meta = await findMessageEndpoint(delivery.sender.instanceId, this.dir);
		this.#guard(delivery.recipient);
		const response = await query(
			meta,
			{
				op: "outgoing",
				generation: delivery.sender.generation,
				requestId: delivery.requestId,
				nonce: delivery.nonce,
				recipient: delivery.recipient,
			},
			DEFAULT_QUERY_TIMEOUT_MS,
		);
		const snapshot = this.#guard(delivery.recipient);
		const outgoing = requireQuery(response).outgoing;
		if (!isRecord(outgoing) || !exactKeys(outgoing, ["sender", "recipient", "request"])) {
			throw new CollabSendError("sender_unavailable");
		}
		const sender = parseIdentity(outgoing.sender);
		const recipient = parseIdentity(outgoing.recipient);
		const request = parseSendRequest(outgoing.request);
		if (
			!sender ||
			!recipient ||
			!request ||
			!sameIdentity(sender, delivery.sender) ||
			!sameIdentity(recipient, delivery.recipient) ||
			request.requestId !== delivery.requestId ||
			!sameRecipient(request.recipient, recipient)
		) {
			throw new CollabSendError("sender_unavailable");
		}
		if (typeof snapshot.busy !== "boolean") throw new CollabSendError("snapshot_unavailable");
		if (!this.source.admitAgentMessage) throw new CollabSendError("recipient_unavailable");
		// Receiver readiness is established before asking the source to commit.
		// The proof above cannot itself authorize this or any later admission.
		const committed = await query(
			meta,
			{
				op: "commit",
				generation: sender.generation,
				requestId: request.requestId,
				nonce: delivery.nonce,
				recipient,
			},
			DEFAULT_QUERY_TIMEOUT_MS,
		);
		const authorization = parseAuthorization(requireQuery(committed).authorization);
		if (
			!authorization ||
			!sameIdentity(authorization.sender, sender) ||
			!sameIdentity(authorization.recipient, recipient) ||
			authorization.requestId !== request.requestId ||
			!tokenMatches(authorization.nonce, delivery.nonce)
		) {
			throw new CollabSendError("sender_unavailable");
		}
		try {
			const current = this.#guard(delivery.recipient);
			if (typeof current.busy !== "boolean") throw new CollabSendError("snapshot_unavailable");
			const admit = this.source.admitAgentMessage;
			if (!admit) throw new CollabSendError("recipient_unavailable");
			const details: CollabAgentMessageDetails = Object.freeze({
				version: 1,
				requestId: request.requestId,
				sender: authorization.sender,
				recipient: authorization.recipient,
				admission: current.busy ? "busy" : "idle",
				admittedAt: Date.now(),
			});
			try {
				// No await from the receiver identity fence through its callback.
				// Source revocation must drain this already-committed admission; its
				// local deadline is not transferable authority expiry on this process.
				admit.call(this.source, request.text, details);
			} catch {
				throw new CollabSendError("admission_failed");
			}
			return Object.freeze({ ...details, status: "admitted" });
		} finally {
			// Even a stale receiver or throwing callback has now settled. An ACK
			// needs the committed authorization, not merely knowledge of its proof.
			// Transport loss is not proof of non-admission; the source retains the
			// obligation unless this ACK or the validated delivery receipt arrives.
			await query(
				meta,
				{
					op: "settle",
					...delivery,
					authorizationId: authorization.authorizationId,
				},
				DEFAULT_QUERY_TIMEOUT_MS,
			);
		}
	}
}

/** One request per connection: authenticate, dispatch the op, respond, close. */
function handleConnection(
	connection: IpcConnection,
	token: string,
	messaging: RegistryMessaging,
	onClose: () => void,
): void {
	let handled = false;
	let connected = true;
	let responseVersion = COLLAB_REGISTRY_VERSION;
	const respond = (payload: object): void => {
		if (!connected) return;
		connection.send(JSON.stringify(payload));
		connection.end();
	};
	const dispatch = async (line: string): Promise<object> => {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			throw new CollabSendError("malformed_request");
		}
		if (!isRecord(request)) throw new CollabSendError("malformed_request");
		responseVersion = isMessageOperation(request.op) ? COLLAB_MESSAGE_PROTOCOL_VERSION : COLLAB_REGISTRY_VERSION;
		if (request.v !== responseVersion) throw new CollabSendError("unsupported_protocol");
		if (!tokenMatches(token, request.token)) throw new CollabSendError("authentication_failed");
		// Only authenticated settlement of existing commitments remains available
		// during withdrawal; it must not consult a closed or successor snapshot.
		if (request.op === "settle") {
			if (
				!exactKeys(request, ["v", "token", "op", "sender", "recipient", "requestId", "nonce", "authorizationId"]) ||
				!isRequestId(request.requestId) ||
				!isNonce(request.nonce) ||
				!isNonce(request.authorizationId)
			) {
				throw new CollabSendError("malformed_request");
			}
			const sender = parseIdentity(request.sender);
			const recipient = parseIdentity(request.recipient);
			if (!sender || !recipient) throw new CollabSendError("malformed_request");
			messaging.settle(
				{ sender, recipient, requestId: request.requestId, nonce: request.nonce },
				request.authorizationId,
			);
			return { settled: true };
		}
		const snapshot = messaging.snapshot();
		switch (request.op) {
			case "snapshot":
				if (!exactKeys(request, ["v", "token", "op"])) throw new CollabSendError("malformed_request");
				return { snapshot: boundSnapshot(snapshot) };
			case "link": {
				if (!exactKeys(request, ["v", "token", "op", "access", "generation"])) {
					throw new CollabSendError("malformed_request");
				}
				if (!Access.allows(request.access)) return { ok: false, error: "invalid_access" };
				if (!isGeneration(request.generation) || request.generation !== snapshot.generation) {
					throw new CollabSendError("stale_generation");
				}
				if (snapshot.access === "local" || (request.access === "control" && snapshot.access !== "control")) {
					throw new CollabSendError("access_unavailable");
				}
				let url: string | null;
				try {
					url = messaging.source.link(request.access);
				} catch {
					throw new CollabSendError("snapshot_unavailable");
				}
				if (!url) throw new CollabSendError("access_unavailable");
				return { url };
			}
			case "send": {
				if (
					!exactKeys(request, ["v", "token", "op", "generation", "request"]) ||
					!isGeneration(request.generation)
				) {
					throw new CollabSendError("malformed_request");
				}
				const message = parseSendRequest(request.request);
				if (!message) throw new CollabSendError("malformed_request");
				return { receipt: await messaging.send(request.generation, message) };
			}
			case "deliver": {
				if (
					!exactKeys(request, ["v", "token", "op", "sender", "recipient", "requestId", "nonce"]) ||
					!isRequestId(request.requestId) ||
					!isNonce(request.nonce)
				) {
					throw new CollabSendError("malformed_request");
				}
				const sender = parseIdentity(request.sender);
				const recipient = parseIdentity(request.recipient);
				if (!sender || !recipient) throw new CollabSendError("malformed_request");
				return {
					receipt: await messaging.deliver({
						sender,
						recipient,
						requestId: request.requestId,
						nonce: request.nonce,
					}),
				};
			}
			case "outgoing":
			case "commit": {
				if (
					!exactKeys(request, ["v", "token", "op", "generation", "requestId", "nonce", "recipient"]) ||
					!isGeneration(request.generation) ||
					!isRequestId(request.requestId) ||
					!isNonce(request.nonce)
				) {
					throw new CollabSendError("malformed_request");
				}
				const recipient = parseIdentity(request.recipient);
				if (!recipient) throw new CollabSendError("malformed_request");
				return request.op === "commit"
					? { authorization: messaging.commit(request.generation, request.requestId, request.nonce, recipient) }
					: { outgoing: messaging.outgoing(request.generation, request.requestId, request.nonce, recipient) };
			}
			default:
				throw new CollabSendError("invalid_operation");
		}
	};
	// Native framing rejects oversized requests before this callback. Claim the
	// connection before dispatch can await, not when its first response arrives.
	connection.start(
		line => {
			if (handled) return;
			handled = true;
			void dispatch(line).then(
				payload => respond({ ok: true, v: responseVersion, ...payload }),
				(error: unknown) =>
					respond({
						ok: false,
						v: responseVersion,
						error: error instanceof CollabSendError ? error.code : "snapshot_unavailable",
					}),
			);
		},
		() => {
			connected = false;
			onClose();
		},
	);
}

/**
 * The registry must be a real directory; POSIX also verifies its owner.
 * Both publication and listing check this: listing prunes malformed
 * entries, so following a symlink into an unrelated directory would let a
 * planted link turn `omp collab list` into a deletion tool.
 */
async function assertPrivateDir(dir: string): Promise<fs.Stats | null> {
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`collab registry directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`collab registry path is not a directory: ${dir}`);
	if (process.platform === "win32") return null;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`collab registry directory is not owned by the current user: ${dir}`);
	}
	return stat;
}

/**
 * Create the directory with owner-only POSIX permissions. Windows retains
 * the config root's ACL. `mkdir` with a mode leaves an
 * existing directory's permissions alone, so an already-present directory is
 * tightened explicitly; a symlink or a directory owned by another user is
 * refused rather than published into.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await assertPrivateDir(dir);
	if (stat && (stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

/**
 * Unix files an endpoint leaves on disk: the socket and the native listener's
 * `<socket>.bind.lock`. Endpoint names are unique per publication, so no other
 * binder can contend for that lock and unlinking it is race-free.
 */
function endpointFiles(endpoint: string): string[] {
	return process.platform === "win32" ? [] : [endpoint, `${endpoint}.bind.lock`];
}

/** Best-effort synchronous unlink; a survivor is pruned by the next list. */
function removeFilesSync(files: string[]): void {
	for (const file of files) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Best-effort.
		}
	}
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
	const dir = options?.dir ?? collabHostsRuntimeDir();
	await ensurePrivateDir(dir);

	const instanceId = options?.instanceId ?? crypto.randomBytes(8).toString("hex");
	if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new Error("invalid collab registry instance id");
	// Unpredictable per-publication entry ID names the endpoint and the metadata
	// file: PID reuse cannot attach stale metadata to an unrelated process, and a
	// room that rotates never shares artifact names with its predecessor, so a
	// lister pruning the stale entry can never remove the live successor's.
	const entryId = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(32).toString("hex");
	// `<dir>/<entryId>.sock` on Unix (natively relocated when it would overflow
	// `sun_path`); listers never guess it, the metadata records the endpoint.
	const endpoint = ipcEndpoint(dir, entryId);
	const metaPath = path.join(dir, `${entryId}.json`);

	const liveConnections = new Set<IpcConnection>();
	const messaging = new RegistryMessaging(source, instanceId, dir);
	const server = await IpcServer.listen(
		endpoint,
		{ framing: "lines", maxFrameBytes: MAX_REQUEST_BYTES },
		connection => {
			liveConnections.add(connection);
			handleConnection(connection, token, messaging, () => liveConnections.delete(connection));
		},
	);
	try {
		const meta: DiscoveryMetadata = {
			version: COLLAB_REGISTRY_VERSION,
			instanceId,
			pid: process.pid,
			endpoint,
			createdAt: Date.now(),
			token,
		};
		// Write-then-rename so a concurrent list never observes a partial file
		// (it would classify the entry as malformed and prune it, leaving this
		// host published but undiscoverable). The temp suffix keeps it outside
		// the `*.json` listing filter; the entry ID makes the name unique. Any
		// failure after the exclusive create removes the temp file again.
		const tmpPath = `${metaPath}.tmp`;
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			try {
				await handle.writeFile(JSON.stringify(meta), "utf8");
			} finally {
				await handle.close();
			}
			await fs.promises.rename(tmpPath, metaPath);
		} catch (err) {
			fs.rmSync(tmpPath, { force: true });
			throw err;
		}
	} catch (err) {
		await messaging.close();
		for (const connection of liveConnections) connection.destroy();
		await server.close();
		removeFilesSync(endpointFiles(endpoint));
		throw err;
	}

	// Normal process shutdown without an explicit stop still withdraws the host.
	// The exit hook is synchronous, so it unlinks the socket itself instead of
	// awaiting `server.close()`.
	const removeArtifactsOnExit = (): void => removeFilesSync([metaPath, ...endpointFiles(endpoint)]);
	process.once("exit", removeArtifactsOnExit);

	let closing: Promise<void> | undefined;
	return {
		endpoint,
		close(): Promise<void> {
			if (closing) return closing;
			const drained = messaging.close(); // Synchronous fence before any await.
			process.off("exit", removeArtifactsOnExit);
			removeFilesSync([metaPath]);
			closing = (async () => {
				try {
					// Retain the endpoint only for committed receivers' settlement ACKs.
					await drained;
				} finally {
					// Expiry rejects the drain, but cannot leave an accepting endpoint.
					for (const connection of liveConnections) connection.destroy();
					try {
						await server.close();
					} finally {
						removeFilesSync(endpointFiles(endpoint));
					}
				}
			})();
			return closing;
		},
	};
}

type QueryResult<T> = { status: "ok"; value: T } | { status: "dead" } | { status: "skip"; error?: string };

/** Query one endpoint: connect, authenticate, send one request, read one bounded response line. */
function query(
	meta: DiscoveryMetadata,
	request: Record<string, unknown>,
	timeoutMs: number,
): Promise<QueryResult<unknown>> {
	const version = isMessageOperation(request.op) ? COLLAB_MESSAGE_PROTOCOL_VERSION : COLLAB_REGISTRY_VERSION;
	const { promise, resolve } = Promise.withResolvers<QueryResult<unknown>>();
	let connection: IpcConnection | undefined;
	let settled = false;
	const finish = (result: QueryResult<unknown>): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		connection?.destroy();
		resolve(result);
	};
	const timer = setTimeout(() => finish({ status: "skip" }), timeoutMs);
	const onLine = (line: string): void => {
		let response: unknown;
		try {
			response = JSON.parse(line);
		} catch {
			finish({ status: "skip" });
			return;
		}
		if (typeof response !== "object" || response === null) {
			finish({ status: "skip" });
			return;
		}
		const { ok, error, v } = response as Record<string, unknown>;
		if (v !== version) {
			finish({ status: "skip", error: "unsupported_protocol" });
			return;
		}
		if (ok !== true) {
			// Authentication failure or structured error: an unrelated endpoint
			// cannot satisfy stale metadata without the matching token.
			finish({ status: "skip", error: typeof error === "string" ? error : undefined });
			return;
		}
		finish({ status: "ok", value: response });
	};
	// An oversized response (past `maxFrameBytes`) closes the connection without a frame: skip.
	IpcConnection.connect(meta.endpoint, { framing: "lines", timeoutMs, maxFrameBytes: MAX_RESPONSE_BYTES }).then(
		conn => {
			if (settled) {
				conn.destroy();
				return;
			}
			connection = conn;
			conn.start(onLine, () => finish({ status: "skip" }));
			conn.send(JSON.stringify({ v: version, token: meta.token, ...request }));
		},
		(err: unknown) => {
			// Endpoints die with their host process: a refused or missing socket
			// means the host is gone. Any other error (EMFILE, EACCES, ETIMEDOUT, …)
			// says nothing about liveness and must not prune a live host.
			const code = isFsError(err) ? err.code : undefined;
			finish({ status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip" });
		},
	);
	return promise;
}

async function querySnapshot(meta: DiscoveryMetadata, timeoutMs: number): Promise<QueryResult<CollabHostSnapshot>> {
	const result = await query(meta, { op: "snapshot" }, timeoutMs);
	if (result.status !== "ok") return result;
	const snapshot = parseSnapshot((result.value as Record<string, unknown>).snapshot);
	return snapshot ? { status: "ok", value: snapshot } : { status: "skip" };
}

/** Messaging never accepts PID aliases or silently chooses between duplicate publications. */
async function findMessageEndpoint(instanceId: string, dir: string): Promise<DiscoveryMetadata> {
	let names: string[];
	try {
		await assertPrivateDir(dir);
		names = await fs.promises.readdir(dir);
	} catch (error) {
		throw new CollabSendError(isEnoent(error) ? "not_found" : "unreachable");
	}
	let match: DiscoveryMetadata | undefined;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		let meta: DiscoveryMetadata | null;
		try {
			meta = parseDiscoveryMetadata(await Bun.file(path.join(dir, name)).text());
		} catch {
			continue;
		}
		if (!meta || meta.instanceId !== instanceId) continue;
		if (match) throw new CollabSendError("ambiguous");
		match = meta;
	}
	if (!match) throw new CollabSendError("not_found");
	if (match.version !== COLLAB_REGISTRY_VERSION) throw new CollabSendError("unsupported_protocol");
	return match;
}

/**
 * Authenticate to the exact source publication. Only that source can stamp the
 * sender identity and establish the outgoing record a receiver will verify.
 * A retry with the same request ID/body returns the original admission receipt;
 * failures and pending requests also remain in the bounded generation ledger.
 * New outgoing proofs are available only while forwarding is pending. A caller
 * timeout is an ambiguous transport outcome, not cancellation: an explicit
 * same-ID retry observes the retained outcome and never starts another send.
 */
export async function sendCollabAgentMessage(
	sender: { instanceId: string; generation: number },
	request: CollabSendRequest,
	options?: CollabListOptions,
): Promise<CollabSendReceipt> {
	const source = parseRecipient(sender);
	const message = parseSendRequest(request);
	const timeoutMs = options?.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
	if (!source || !message || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new CollabSendError("malformed_request");
	}
	const meta = await findMessageEndpoint(source.instanceId, options?.dir ?? collabHostsRuntimeDir());
	const result = await query(meta, { op: "send", generation: source.generation, request: message }, timeoutMs);
	const receipt = parseReceipt(requireQuery(result).receipt);
	if (
		!receipt ||
		receipt.requestId !== message.requestId ||
		!sameRecipient(receipt.sender, source) ||
		!sameRecipient(receipt.recipient, message.recipient)
	) {
		throw new CollabSendError("unreachable");
	}
	return receipt;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Remove one stale entry. Artifact names are unique per publication, so the
 * metadata and endpoint observed dead can only belong to that publication;
 * a room that rotated meanwhile lives under different names and is untouched.
 */
async function pruneEntry(dir: string, name: string, meta: DiscoveryMetadata | null): Promise<void> {
	try {
		await fs.promises.rm(path.join(dir, name), { force: true });
		// Only unlink sockets this registry could have created: beside the
		// metadata, or at the exact relocated endpoint this entry's publication
		// derives (under the shared `/tmp/omp-<euid>/`, never another socket there).
		const ownsEndpoint =
			meta !== null &&
			process.platform !== "win32" &&
			(meta.endpoint.startsWith(dir + path.sep) || meta.endpoint === ipcEndpoint(dir, path.basename(name, ".json")));
		if (ownsEndpoint) {
			for (const file of endpointFiles(meta.endpoint)) await fs.promises.rm(file, { force: true });
		}
	} catch {
		// Best-effort cleanup only (a missing file means someone else already pruned it).
	}
}

interface LiveEntry {
	meta: DiscoveryMetadata;
	snapshot: CollabHostSnapshot;
}

async function listEntry(dir: string, name: string, timeoutMs: number): Promise<LiveEntry | null> {
	let text: string;
	try {
		text = await Bun.file(path.join(dir, name)).text();
	} catch {
		return null;
	}
	const meta = parseDiscoveryMetadata(text);
	if (!meta) {
		// Malformed metadata can never become listable; remove it.
		await pruneEntry(dir, name, null);
		return null;
	}
	if (meta.version !== COLLAB_REGISTRY_VERSION) {
		// A different omp version owns this entry. Never show it; prune only
		// once the owning process is gone so newer versions keep their state.
		if (!pidAlive(meta.pid)) await pruneEntry(dir, name, meta);
		return null;
	}
	const result = await querySnapshot(meta, timeoutMs);
	if (result.status === "ok") return { meta, snapshot: result.value };
	if (result.status === "dead") await pruneEntry(dir, name, meta);
	return null;
}

async function listLiveEntries(options?: CollabListOptions): Promise<LiveEntry[]> {
	const dir = options?.dir ?? collabHostsRuntimeDir();
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
	let names: string[];
	try {
		await assertPrivateDir(dir);
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries = names.filter(name => name.endsWith(".json")).sort();
	const live: LiveEntry[] = [];
	// Bounded worker pool: LIST_CONCURRENCY entries in flight at once.
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < entries.length) {
			const name = entries[next++];
			const entry = await listEntry(dir, name, timeoutMs);
			if (entry) live.push(entry);
		}
	};
	await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, entries.length) }, worker));
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
