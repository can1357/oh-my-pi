/**
 * `blob` module: the image URL broker, one unit per (project, config key).
 *
 * A unit hosts a {@link LocalBlobBackend} (store + exposure, or uploader)
 * built from the opening client's config and environment. Sessions register
 * blobs through `call("blob", ...)`; providers fetch them through the
 * exposure. Lazy blobs render on fetch: the registering session keeps a
 * tunnel on {@link BLOB_RENDER_CHANNEL} open, the unit sends `{id,key}` lines
 * down it and the session answers `{id,mime,base64}` or `{id,error}`.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { LocalBlobBackend, MAX_LAZY_RENDER_MS, redactUrl } from "../../blob-broker/broker";
import { isServeKind } from "../../blob-broker/destinations";
import {
	BLOB_APPEND_METHOD,
	BLOB_BROKER_KIND,
	BLOB_MODULE_VERSION,
	BLOB_RENDER_CHANNEL,
	type BlobBrokerCalls,
	type BlobBrokerDoctorRequest,
	type BlobBrokerInfo,
	type BlobBrokerProbeRequest,
	type BlobBrokerPurgeRequest,
	type BlobBrokerStatus,
	type BlobBrokerWorkerConfig,
	type BlobRenderHello,
	type BlobRenderRequest,
	type BlobRenderResponse,
	type BlobUnitParams,
	blobBrokerConfigKey,
	type EnsureBlobRequest,
	type EnsureBlobResponse,
	type EnsureLazyRequest,
} from "../../blob-broker/protocol";
import { readBlobBrokerSavingsStatus } from "../../blob-broker/savings";
import type { DaemonModule, ModuleContext, ModuleTunnel, ModuleUnit } from "../module";
import type { UnitPolicy } from "../protocol";

/** How long a staged upload waits for its next slice or its `blob` call. */
const UPLOAD_IDLE_MS = 60_000;
/** Default for how long a lazy render may take in the owning session. */
const RENDER_TIMEOUT_MS = 30_000;

const POLICY: UnitPolicy = {
	hold: "leases",
	idleMs: 30_000,
	onIdle: "flush-stop",
	restart: "no",
	survive: "none",
};

function parseParams(params: unknown): BlobUnitParams {
	if (
		isRecord(params) &&
		isRecord(params.config) &&
		typeof params.config.kind === "string" &&
		isRecord(params.spawn) &&
		isRecord(params.spawn.env) &&
		typeof params.spawn.cwd === "string"
	) {
		const timeout = params.renderTimeoutMs;
		if (
			timeout !== undefined &&
			!(typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_LAZY_RENDER_MS)
		) {
			throw new Error(`blob: renderTimeoutMs must be an integer in 1..${MAX_LAZY_RENDER_MS}`);
		}
		return params as unknown as BlobUnitParams;
	}
	throw new Error("blob: open params need config and spawn { env, cwd }");
}

function record(params: unknown): Record<string, unknown> {
	return isRecord(params) ? params : {};
}

function requireString(params: Record<string, unknown>, field: string): string {
	const value = params[field];
	if (typeof value !== "string") throw new Error(`blob: ${field} must be a string`);
	return value;
}

/** One session's render tunnel. */
class RenderPeer {
	#tunnel: ModuleTunnel;
	#pending = new Map<number, PromiseWithResolvers<Uint8Array | null>>();
	#nextId = 1;
	#closed = false;
	#timeoutMs: number;

	constructor(tunnel: ModuleTunnel, timeoutMs: number) {
		this.#tunnel = tunnel;
		this.#timeoutMs = timeoutMs;
	}

	get closed(): boolean {
		return this.#closed;
	}

	render(key: string): Promise<Uint8Array | null> {
		if (this.#closed) return Promise.reject(new Error(`lazy blob ${key}: owning session disconnected`));
		const id = this.#nextId++;
		const pending = Promise.withResolvers<Uint8Array | null>();
		this.#pending.set(id, pending);
		const timer = setTimeout(() => {
			if (this.#pending.delete(id)) pending.reject(new Error(`lazy blob ${key}: render timed out`));
		}, this.#timeoutMs);
		timer.unref();
		void pending.promise.finally(() => clearTimeout(timer)).catch(() => {});
		const request: BlobRenderRequest = { id, key };
		this.#tunnel.send(`${JSON.stringify(request)}\n`);
		return pending.promise;
	}

	answer(response: BlobRenderResponse): void {
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		this.#pending.delete(response.id);
		if ("error" in response) pending.reject(new Error(response.error));
		else pending.resolve(response.base64.length > 0 ? Buffer.from(response.base64, "base64") : null);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.reject(new Error("owning session disconnected"));
		this.#pending.clear();
		this.#tunnel.close();
	}
}

class BlobUnit implements ModuleUnit {
	label: string;
	readonly ready: Promise<void>;
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	#context: ModuleContext;
	#unitId: string;
	#config: BlobBrokerWorkerConfig;
	#renderTimeoutMs: number;
	#backend: LocalBlobBackend;
	#baseUrl = "";
	#peers = new Map<string, RenderPeer>();
	/** Blobs arriving in {@link BLOB_APPEND_METHOD} slices, by upload id. */
	#uploads = new Map<string, { chunks: Buffer[]; timer: NodeJS.Timeout }>();
	#inflight = 0;
	#stopped = false;
	#exit = Promise.withResolvers<{ exitCode?: number; reason?: string }>();

	constructor(context: ModuleContext, unitId: string, params: BlobUnitParams) {
		this.#context = context;
		this.#unitId = unitId;
		this.#config = params.config;
		this.#renderTimeoutMs = params.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
		this.#backend = new LocalBlobBackend(params.config, { spawn: params.spawn });
		this.label = `blob ${params.config.kind}`;
		this.exited = this.#exit.promise;
		this.ready = this.#start();
		void this.#backend.died.then(() => {
			if (this.#stopped) return;
			void this.stop("exposure process exited");
		});
	}

	async #start(): Promise<void> {
		// A ready unit is a serving unit; uploader configs have nothing to start.
		if (!isServeKind(this.#config.kind)) return;
		const baseUrl = await this.#backend.ensureStarted();
		if (baseUrl === null) {
			void this.stop("exposure failed to start");
			throw new Error(`blob exposure ${this.#config.kind} failed to start`);
		}
		this.#baseUrl = baseUrl;
		const shown = redactUrl(baseUrl);
		this.label = `blob ${this.#config.kind} ${shown}`;
		this.#context.changed(this.#unitId);
		logger.info("blob unit serving", { kind: this.#config.kind, baseUrl: shown });
	}

	pids(): number[] {
		const pid = this.#backend.exposurePid;
		return pid === undefined ? [] : [pid];
	}

	busy(): boolean {
		return this.#inflight > 0;
	}

	attach(tunnel: ModuleTunnel, channel: string | undefined): void {
		if (channel !== BLOB_RENDER_CHANNEL) {
			tunnel.close();
			throw new Error(`blob: unknown channel ${channel ?? "(none)"}`);
		}
		const peer = new RenderPeer(tunnel, this.#renderTimeoutMs);
		let owner: string | undefined;
		let buffered = "";
		const decoder = new TextDecoder();
		tunnel.start(
			chunk => {
				// Render answers carry whole images: scan only the new text for the line end.
				const scanFrom = buffered.length;
				buffered += decoder.decode(chunk, { stream: true });
				let newline = buffered.indexOf("\n", scanFrom);
				while (newline >= 0) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf("\n");
					if (!line) continue;
					let message: unknown;
					try {
						message = JSON.parse(line);
					} catch {
						logger.debug("blob render tunnel: malformed line");
						continue;
					}
					if (!isRecord(message)) continue;
					if (owner === undefined) {
						const hello = message as Partial<BlobRenderHello>;
						if (typeof hello.owner !== "string") {
							peer.close();
							return;
						}
						owner = hello.owner;
						this.#peers.get(owner)?.close();
						this.#peers.set(owner, peer);
						continue;
					}
					if (typeof message.id === "number") peer.answer(message as unknown as BlobRenderResponse);
				}
			},
			() => {
				peer.close();
				if (owner !== undefined && this.#peers.get(owner) === peer) this.#peers.delete(owner);
			},
		);
	}

	async call(method: string, params: unknown): Promise<unknown> {
		this.#inflight++;
		try {
			return await this.#dispatch(method, record(params));
		} finally {
			this.#inflight--;
		}
	}

	async #dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case "info":
				return this.#info();
			case "status":
				return this.#status();
			case "doctor": {
				const request = params as BlobBrokerDoctorRequest;
				return {
					status: await this.#status(),
					checks: [
						{ name: "control", ok: true, status: "pass", detail: "daemon blob unit is responding" },
						...(await this.#backend.doctor(request.probe !== false)),
					],
				} satisfies BlobBrokerCalls["doctor"]["result"];
			}
			case "probe": {
				const request = params as BlobBrokerProbeRequest;
				return this.#backend.probePublicHealth(request.timeoutMs);
			}
			case "purge":
				return this.#backend.purge(params as BlobBrokerPurgeRequest);
			case BLOB_APPEND_METHOD:
				this.#append(requireString(params, "upload"), requireString(params, "data"));
				return null;
			case "blob": {
				const upload = typeof params.upload === "string" ? this.#takeUpload(params.upload) : undefined;
				return this.#ensureBlob(
					{
						key: requireString(params, "key"),
						mimeType: requireString(params, "mimeType"),
						...(typeof params.data === "string" ? { data: params.data } : {}),
					},
					upload,
				);
			}
			case "lazy":
				return this.#ensureLazy({
					key: requireString(params, "key"),
					mimeType: requireString(params, "mimeType"),
					owner: requireString(params, "owner"),
				});
			default:
				throw new Error(`blob: unknown method ${method}`);
		}
	}

	#info(): BlobBrokerInfo {
		return {
			baseUrl: this.#baseUrl,
			lazy: this.#backend.supportsLazy,
			configKey: blobBrokerConfigKey(this.#config),
		};
	}

	async #status(): Promise<BlobBrokerStatus> {
		const savingsPath = this.#config.persist?.savingsPath;
		let savings: BlobBrokerStatus["savings"] = {
			journalPath: savingsPath ?? "",
			entries: 0,
			imageCount: 0,
			inlineBytes: 0,
			referenceBytes: 0,
			savedBytes: 0,
			byDestination: {},
		};
		if (savingsPath) {
			try {
				savings = await readBlobBrokerSavingsStatus(savingsPath);
			} catch {
				// Status remains available when the optional savings journal is unreadable.
			}
		}
		return { ...this.#info(), ...this.#backend.storeStatus(), savings };
	}

	#append(upload: string, data: string): void {
		const previous = this.#uploads.get(upload);
		if (previous) clearTimeout(previous.timer);
		const timer = setTimeout(() => this.#uploads.delete(upload), UPLOAD_IDLE_MS);
		timer.unref();
		const chunks = previous?.chunks ?? [];
		chunks.push(Buffer.from(data, "base64"));
		this.#uploads.set(upload, { chunks, timer });
	}

	#takeUpload(upload: string): Buffer {
		const staged = this.#uploads.get(upload);
		if (!staged) throw new Error(`blob: unknown or expired upload ${upload}`);
		this.#uploads.delete(upload);
		clearTimeout(staged.timer);
		return Buffer.concat(staged.chunks);
	}

	async #ensureBlob(request: EnsureBlobRequest, uploaded?: Buffer): Promise<EnsureBlobResponse> {
		if (uploaded) {
			const publication = await this.#backend.ensureBlob(request.key, request.mimeType, () => uploaded);
			if (!publication) throw new Error(`blob ${this.#config.kind}: publication unavailable`);
			return { publication };
		}
		if (request.data === undefined) {
			const publication = await this.#backend.lookupBlob(request.key);
			return publication ? { publication } : { missing: true };
		}
		const bytes = Buffer.from(request.data, "base64");
		const publication = await this.#backend.ensureBlob(request.key, request.mimeType, () => bytes);
		if (!publication) throw new Error(`blob ${this.#config.kind}: publication unavailable`);
		return { publication };
	}

	async #ensureLazy(request: EnsureLazyRequest): Promise<EnsureBlobResponse> {
		const { key, owner } = request;
		if (!this.#peers.has(owner)) throw new Error(`blob: no render tunnel attached for owner ${owner}`);
		const publication = await this.#backend.ensureLazy(key, request.mimeType, () => {
			const peer = this.#peers.get(owner);
			if (!peer || peer.closed) {
				return Promise.reject(new Error(`lazy blob ${key}: owning session disconnected`));
			}
			return peer.render(key);
		});
		if (!publication) throw new Error(`blob ${this.#config.kind}: lazy publication unavailable`);
		return { publication };
	}

	async flush(): Promise<void> {
		this.#backend.flush();
	}

	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const peer of this.#peers.values()) peer.close();
		this.#peers.clear();
		for (const staged of this.#uploads.values()) clearTimeout(staged.timer);
		this.#uploads.clear();
		// Stopping flushes the persisted URL index rather than losing the debounced write.
		this.#backend.stop();
		this.#exit.resolve({ reason });
	}
}

/** Image URL broker, one project-scoped unit per config (key: `blobBrokerConfigKey`). */
export const blobModule: DaemonModule = {
	kind: BLOB_BROKER_KIND,
	version: BLOB_MODULE_VERSION,
	policy: () => POLICY,
	open: (context, request) => new BlobUnit(context, request.unitId, parseParams(request.params)),
	async call(_context, method, params, _client, unit) {
		if (!unit) throw new Error("blob calls must name a unit");
		if (!(unit.unit instanceof BlobUnit)) throw new Error(`blob: unit ${unit.snapshot.id} is not a blob unit`);
		return unit.unit.call(method, params);
	},
};
