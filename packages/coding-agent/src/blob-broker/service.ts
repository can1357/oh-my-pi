/**
 * Session-facing image URL service.
 *
 * Owns policy and session state — provider gating, quarantine, and the
 * lazy-frame producer registry — and delegates URL minting to a
 * {@link BlobBackend}: a `blob` unit in the omp daemon per configured
 * destination when the daemon is reachable, in-process backends otherwise.
 * Every failure at any layer degrades to inline base64.
 */

import * as path from "node:path";
import type { Context, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { errorMessage, getBlobsDir, logger } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { Settings } from "../config/settings";
import { daemonClient } from "../daemon/client";
import { canonicalProjectDir } from "../daemon/paths";
import { type DaemonClient, type DaemonTunnel, projectScope } from "../daemon/protocol";
import type * as LocalBroker from "./broker";
import type { BlobBackend } from "./broker";
import { isServeKind } from "./destinations";
import {
	contextHasImages,
	contextHasImageUrls,
	contextHasProviderFiles,
	decorateContextImages,
	inlineContextImages,
	supportsRemoteImageUrls,
} from "./context-images";
import {
	BLOB_APPEND_METHOD,
	BLOB_BROKER_KIND,
	BLOB_CALL_CHUNK_CHARS,
	BLOB_MODULE_VERSION,
	BLOB_RENDER_CHANNEL,
	type BlobBrokerCalls,
	type BlobBrokerDoctorRequest,
	type BlobBrokerDoctorResponse,
	type BlobBrokerProbeRequest,
	type BlobBrokerProbeResponse,
	type BlobBrokerPurgeRequest,
	type BlobBrokerPurgeResponse,
	type BlobBrokerStatus,
	type BlobBrokerWorkerConfig,
	type BlobRenderHello,
	type BlobRenderRequest,
	type BlobRenderResponse,
	type BlobUnitParams,
	blobBrokerConfigKey,
	type EnsureBlobResponse,
} from "./protocol";
import { ProviderFileCache } from "./provider-file-types";
import type { ProviderFileCredentialResolver } from "./provider-file-credential";
import { ProviderFileManager } from "./provider-files";
import type { BlobPublication } from "./publication";
import { BlobBrokerSavingsJournal, type BlobBrokerSavingsRecord, blobBrokerSavingsJournalPath } from "./savings";
import type { LazyBlobFetcher } from "./store";
import { type DestinationOptionValue, destinationSpawnContext } from "./uploader-runtime";

import {
	cfgImagesUrlsBackends,
	cfgImagesUrlsBindHost,
	cfgImagesUrlsCommand,
	cfgImagesUrlsCredentials,
	cfgImagesUrlsEnabled,
	cfgImagesUrlsOptions,
	cfgImagesUrlsPublicBaseUrl,
	cfgImagesUrlsSshRemotePort,
	cfgImagesUrlsSshTarget,
	cfgImagesUrlsTtlHours,
} from "./settings";

/**
 * Render-on-fetch hook handed to the snapcompact inline transformer: returns
 * URL-bearing placeholder frames for `text`, or `null` when lazy frames are
 * unavailable (no backend, uploader mode) and the caller must render eagerly.
 */
export interface SnapcompactFrameSink {
	framesFor(text: string, shape: snapcompact.Shape, maxFrames?: number): Promise<ImageContent[] | null>;
	/** Changes when previously returned frames stop resolving; callers re-request cached frames. */
	readonly generation?: number;
}

interface BlockContentHash {
	data: string;
	mimeType: string;
	hash: string;
}

/**
 * Content key per image block. Converted session history keeps block identity
 * across requests, so each screenshot is hashed once instead of every turn;
 * the stored `data`/`mimeType` guard against in-place block mutation.
 */
const contentHashByBlock = new WeakMap<ImageContent, BlockContentHash>();

function blockContentHash(block: ImageContent): string {
	const memo = contentHashByBlock.get(block);
	if (memo?.data === block.data && memo.mimeType === block.mimeType) return memo.hash;
	const hash = new Bun.CryptoHasher("sha256").update(block.mimeType).update("\n").update(block.data).digest("hex");
	contentHashByBlock.set(block, { data: block.data, mimeType: block.mimeType, hash });
	return hash;
}

type BlobCall = keyof BlobBrokerCalls;

function callBlob<M extends BlobCall>(
	client: DaemonClient,
	unit: string,
	method: M,
	params: BlobBrokerCalls[M]["params"],
): Promise<BlobBrokerCalls[M]["result"]> {
	return client.call<BlobBrokerCalls[M]["result"]>(BLOB_BROKER_KIND, method, params, { unit });
}

/**
 * Publish `data` through the unit's `blob` call. A payload over one control
 * line's budget is staged in {@link BLOB_APPEND_METHOD} slices first.
 */
async function uploadBlob(
	client: DaemonClient,
	unit: string,
	key: string,
	mimeType: string,
	data: string,
): Promise<EnsureBlobResponse> {
	if (data.length <= BLOB_CALL_CHUNK_CHARS) return callBlob(client, unit, "blob", { key, mimeType, data });
	const upload = crypto.randomUUID();
	for (let offset = 0; offset < data.length; offset += BLOB_CALL_CHUNK_CHARS) {
		await client.call(
			BLOB_BROKER_KIND,
			BLOB_APPEND_METHOD,
			{ upload, data: data.slice(offset, offset + BLOB_CALL_CHUNK_CHARS) },
			{ unit },
		);
	}
	return client.call<EnsureBlobResponse>(BLOB_BROKER_KIND, "blob", { key, mimeType, upload }, { unit });
}

/** Open (find-or-start) the project's `blob` unit for `config`, with a lease on this client's connection. */
async function openBlobUnit(
	client: DaemonClient,
	projectDir: string,
	config: BlobBrokerWorkerConfig,
): Promise<{ unit: string; lease: string | undefined }> {
	const params: BlobUnitParams = {
		config,
		spawn: { ...destinationSpawnContext(undefined), cwd: projectDir },
	};
	const opened = await client.open({
		kind: BLOB_BROKER_KIND,
		scope: projectScope(await canonicalProjectDir(projectDir)),
		key: blobBrokerConfigKey(config),
		label: `blob ${config.kind}`,
		params,
	});
	return { unit: opened.unit.id, lease: opened.lease };
}

/** Client side of the `render` tunnel: answers the unit's lazy render requests from session producers. */
class RenderTunnel {
	readonly owner = crypto.randomUUID();
	#tunnel: DaemonTunnel;
	#producers: Map<string, { mimeType: string; fetcher: LazyBlobFetcher }>;
	#closed = false;

	constructor(tunnel: DaemonTunnel, producers: Map<string, { mimeType: string; fetcher: LazyBlobFetcher }>) {
		this.#tunnel = tunnel;
		this.#producers = producers;
		let buffered = "";
		const decoder = new TextDecoder();
		tunnel.start(
			chunk => {
				buffered += decoder.decode(chunk, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf("\n");
					if (!line) continue;
					try {
						void this.#render(JSON.parse(line) as BlobRenderRequest);
					} catch {
						logger.debug("blob render tunnel: malformed request");
					}
				}
			},
			() => {
				this.#closed = true;
			},
		);
		const hello: BlobRenderHello = { owner: this.owner };
		tunnel.send(`${JSON.stringify(hello)}\n`);
	}

	get closed(): boolean {
		return this.#closed;
	}

	async #render(request: BlobRenderRequest): Promise<void> {
		const producer = this.#producers.get(request.key);
		let response: BlobRenderResponse;
		if (!producer) {
			response = { id: request.id, error: `unknown lazy blob ${request.key}` };
		} else {
			try {
				const bytes = await producer.fetcher();
				response = bytes
					? { id: request.id, mime: producer.mimeType, base64: bytes.toBase64() }
					: { id: request.id, error: `lazy blob ${request.key} source is gone` };
			} catch (error) {
				response = { id: request.id, error: errorMessage(error) };
			}
		}
		if (this.#closed) return;
		if (!this.#tunnel.send(`${JSON.stringify(response)}\n`)) await this.#tunnel.drained();
	}

	close(): void {
		this.#closed = true;
		this.#tunnel.close();
	}
}

interface DaemonBlobSession {
	unit: string;
	lease: string | undefined;
	render?: Promise<RenderTunnel>;
}

/**
 * {@link BlobBackend} over one daemon `blob` unit. The unit is opened on first
 * use and re-opened after the daemon restarts (leases die with it).
 */
class DaemonBlobBackend implements BlobBackend {
	readonly supportsLazy: boolean;
	#client: DaemonClient;
	#projectDir: string;
	#config: BlobBrokerWorkerConfig;
	#session: Promise<DaemonBlobSession> | undefined;
	#producers = new Map<string, { mimeType: string; fetcher: LazyBlobFetcher }>();
	#unsubscribe: () => void;
	#stopped = false;

	constructor(client: DaemonClient, projectDir: string, config: BlobBrokerWorkerConfig) {
		this.#client = client;
		this.#projectDir = projectDir;
		this.#config = config;
		this.supportsLazy = isServeKind(config.kind);
		this.#unsubscribe = client.onReconnect(() => {
			const previous = this.#session;
			this.#session = undefined;
			void previous?.then(session => session.render?.then(render => render.close())).catch(() => {});
		});
	}

	/**
	 * Run `action` on the open unit. When it fails because the unit is gone
	 * (its exposure died, it was stopped), forget the session and retry once on
	 * a freshly opened unit; other failures propagate.
	 */
	async #withSession<T>(action: (session: DaemonBlobSession) => Promise<T>): Promise<T> {
		const pending = this.#open();
		const session = await pending;
		try {
			return await action(session);
		} catch (error) {
			if (this.#stopped || (await this.#unitLive(session.unit))) throw error;
			if (this.#session === pending) {
				this.#session = undefined;
				this.#closeSession(session);
			}
			return action(await this.#open());
		}
	}

	async #unitLive(unit: string): Promise<boolean> {
		try {
			const { unit: snapshot } = await this.#client.request({ op: "describe", unit });
			return snapshot.state !== "exited" && snapshot.state !== "failed" && snapshot.state !== "stopping";
		} catch {
			return false;
		}
	}

	#closeSession(session: DaemonBlobSession): void {
		void (async () => {
			const render = session.render ? await session.render.catch(() => undefined) : undefined;
			render?.close();
			if (session.lease) await this.#client.release(session.lease);
		})().catch(() => {});
	}

	/** Start the unit (and its exposure) in the background. */
	prewarm(): void {
		void this.#open().catch(() => {});
	}

	#open(): Promise<DaemonBlobSession> {
		if (this.#stopped) return Promise.reject(new Error("blob backend stopped"));
		if (!this.#session) {
			const pending = openBlobUnit(this.#client, this.#projectDir, this.#config);
			this.#session = pending;
			// A failed open is retried by the next request rather than cached.
			pending.catch(() => {
				if (this.#session === pending) this.#session = undefined;
			});
		}
		return this.#session;
	}

	async #render(session: DaemonBlobSession): Promise<RenderTunnel> {
		const current = session.render ? await session.render.catch(() => undefined) : undefined;
		if (current && !current.closed) return current;
		const pending = this.#client
			.attach(session.unit, BLOB_RENDER_CHANNEL)
			.then(tunnel => new RenderTunnel(tunnel, this.#producers));
		session.render = pending;
		return pending;
	}

	async ensureBlob(
		key: string,
		mimeType: string,
		getBytes: () => Uint8Array,
		getBase64?: () => string,
	): Promise<BlobPublication | null> {
		try {
			return await this.#withSession(async ({ unit }) => {
				// Probe first: persisted/live registrations answer without the bytes
				// ever crossing the connection — the common case on every turn after
				// the first, and on conversation resume.
				const probe = await callBlob(this.#client, unit, "blob", { key, mimeType });
				if (probe.publication) return probe.publication;
				const data = getBase64?.() ?? getBytes().toBase64();
				const { publication } = await uploadBlob(this.#client, unit, key, mimeType, data);
				return publication ?? null;
			});
		} catch (error) {
			logger.debug("blob daemon ensure failed", { destination: this.#config.kind, error: errorMessage(error) });
			return null;
		}
	}

	async ensureLazy(key: string, mimeType: string, fetcher: LazyBlobFetcher): Promise<BlobPublication | null> {
		if (!this.supportsLazy) return null;
		try {
			this.#producers.set(key, { mimeType, fetcher });
			return await this.#withSession(async session => {
				const render = await this.#render(session);
				const { publication } = await callBlob(this.#client, session.unit, "lazy", {
					key,
					mimeType,
					owner: render.owner,
				});
				return publication ?? null;
			});
		} catch (error) {
			logger.debug("blob daemon lazy ensure failed", { destination: this.#config.kind, error: errorMessage(error) });
			return null;
		}
	}

	stop(): void {
		this.#stopped = true;
		this.#unsubscribe();
		const session = this.#session;
		this.#session = undefined;
		this.#producers.clear();
		void session?.then(opened => this.#closeSession(opened)).catch(() => {});
	}
}

/** The daemon, or `null` (after a debug log) when it is unreachable or lacks the `blob` module. */
async function blobDaemon(): Promise<DaemonClient | null> {
	try {
		const client = await daemonClient();
		if (client.welcome.caps[BLOB_BROKER_KIND] !== BLOB_MODULE_VERSION) {
			logger.debug("omp daemon has no compatible blob module; using in-process image URL backends");
			return null;
		}
		return client;
	} catch (error) {
		logger.debug("omp daemon unreachable; using in-process image URL backends", { error: errorMessage(error) });
		return null;
	}
}

/** Newest live `blob` unit of the project, without starting one. */
async function liveBlobUnit(projectDir: string): Promise<{ client: DaemonClient; unit: string } | null> {
	const client = await blobDaemon();
	if (!client) return null;
	const { units } = await client.request({
		op: "list",
		scope: projectScope(await canonicalProjectDir(projectDir)),
		kind: BLOB_BROKER_KIND,
	});
	let newest: (typeof units)[number] | undefined;
	for (const unit of units) {
		if (unit.state !== "ready" && unit.state !== "running") continue;
		if (!newest || unit.startedAt > newest.startedAt) newest = unit;
	}
	return newest ? { client, unit: newest.id } : null;
}

/** Status of the project's live blob unit; `null` when none runs. */
export async function queryBlobBrokerStatus(projectDir: string): Promise<BlobBrokerStatus | null> {
	const live = await liveBlobUnit(projectDir);
	return live ? callBlob(live.client, live.unit, "status", {}) : null;
}

/** Diagnostics of the project's live blob unit; `null` when none runs. */
export async function queryBlobBrokerDoctor(
	projectDir: string,
	request: BlobBrokerDoctorRequest = {},
): Promise<BlobBrokerDoctorResponse | null> {
	const live = await liveBlobUnit(projectDir);
	return live ? callBlob(live.client, live.unit, "doctor", request) : null;
}

/**
 * Open the unit for `config` (starting its exposure), then issue an actual
 * public health request through it. `null` when the daemon is unreachable.
 */
export async function queryBlobBrokerProbe(
	projectDir: string,
	config: BlobBrokerWorkerConfig,
	request: BlobBrokerProbeRequest = {},
): Promise<BlobBrokerProbeResponse | null> {
	const client = await blobDaemon();
	if (!client) return null;
	const { unit, lease } = await openBlobUnit(client, projectDir, config);
	try {
		return await callBlob(client, unit, "probe", request);
	} finally {
		if (lease) await client.release(lease);
	}
}

/** Preview or apply cleanup on the project's live blob unit; `null` when none runs. */
export async function queryBlobBrokerPurge(
	projectDir: string,
	request: BlobBrokerPurgeRequest = {},
): Promise<BlobBrokerPurgeResponse | null> {
	const live = await liveBlobUnit(projectDir);
	return live ? callBlob(live.client, live.unit, "purge", request) : null;
}

/**
 * Ordered backend chain that advances when a destination cannot publish.
 *
 * Each ensure call starts at the first backend so healthy persisted
 * publications remain stable while unavailable destinations can be skipped.
 */
export class FallbackBlobBackend implements BlobBackend {
	readonly supportsLazy: boolean;

	constructor(readonly backends: readonly BlobBackend[]) {
		this.supportsLazy = backends.some(backend => backend.supportsLazy);
	}

	async ensureBlob(
		key: string,
		mimeType: string,
		getBytes: () => Uint8Array,
		getBase64?: () => string,
	): Promise<BlobPublication | null> {
		let bytes: Uint8Array | undefined;
		for (const backend of this.backends) {
			try {
				const publication = await backend.ensureBlob(
					key,
					mimeType,
					() => {
						bytes ??= getBytes();
						return bytes;
					},
					getBase64,
				);
				if (publication) return publication;
			} catch (error) {
				logger.warn("blob-broker: backend publication failed; trying next backend", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return null;
	}

	async ensureLazy(key: string, mimeType: string, fetcher: LazyBlobFetcher): Promise<BlobPublication | null> {
		for (const backend of this.backends) {
			if (!backend.supportsLazy) continue;
			try {
				const publication = await backend.ensureLazy(key, mimeType, fetcher);
				if (publication) return publication;
			} catch (error) {
				logger.warn("blob-broker: lazy backend failed; trying next backend", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return null;
	}

	stop(): void {
		for (const backend of this.backends) backend.stop();
	}
}

/** Coordinates image URL decoration for one session process. */
export class ImageUrlService {
	#projectDir: string;
	#configs: readonly BlobBrokerWorkerConfig[];
	#backendPromises = new Map<string, Promise<BlobBackend | null>>();
	#quarantined = new Set<string>();
	/** Session-side producers answering lazy renders, keyed by blob key. */
	#producers = new Map<string, LazyBlobFetcher>();
	/** Reverse index for inline materialization on provider fallback. */
	#lazyKeyByUrl = new Map<string, string>();
	/** Publication metadata retained by URL for diagnostics and fallback. */
	#publicationByUrl = new Map<string, BlobPublication>();
	/** Backend range and content key retained by URL for ordered fallback. */
	#publicationSourceByUrl = new Map<string, { rangeStart: number; rangeEnd: number; hash: string }>();
	#daemonEnabled: boolean;
	#providerFiles: ProviderFileManager | undefined;
	#providerFilePosition: number;
	#savingsJournal: BlobBrokerSavingsJournal | undefined;

	constructor(
		projectDir: string,
		configs: readonly BlobBrokerWorkerConfig[],
		options?: {
			daemon?: boolean;
			providerFiles?: ProviderFileManager;
			providerFilePosition?: number;
			savingsJournal?: BlobBrokerSavingsJournal;
		},
	) {
		this.#projectDir = projectDir;
		this.#configs = configs;
		this.#daemonEnabled = options?.daemon ?? true;
		this.#providerFiles = options?.providerFiles;
		this.#providerFilePosition = options?.providerFilePosition ?? configs.length;
		this.#savingsJournal = options?.savingsJournal;
	}

	/** Kick off unit/exposure startup in the background to hide latency. */
	prewarm(): void {
		const position = Math.min(this.#providerFilePosition, this.#configs.length);
		const configs = position > 0 ? this.#configs.slice(0, position) : this.#configs.slice(position);
		const key = position > 0 ? `range:0:${position}` : `range:${position}:${this.#configs.length}`;
		if (configs.length > 0) void this.#ensureBackend(configs, key);
	}

	#ensureBackend(
		configs: readonly BlobBrokerWorkerConfig[] = this.#configs,
		key = "all",
	): Promise<BlobBackend | null> {
		let pending = this.#backendPromises.get(key);
		if (!pending) {
			pending = this.#resolveBackend(configs);
			this.#backendPromises.set(key, pending);
		}
		return pending;
	}

	async #resolveBackend(configs: readonly BlobBrokerWorkerConfig[]): Promise<BlobBackend | null> {
		const daemon = this.#daemonEnabled ? await blobDaemon() : null;
		const backends: BlobBackend[] = [];
		for (const config of configs) {
			if (daemon) {
				backends.push(new DaemonBlobBackend(daemon, this.#projectDir, config));
				continue;
			}
			try {
				// The daemon hosts these servers and uploaders unless the local fallback is needed.
				const { LocalBlobBackend }: typeof LocalBroker = require("./broker");
				backends.push(new LocalBlobBackend(config));
			} catch (error) {
				logger.warn("blob-broker: backend unavailable; trying next backend", {
					destination: config.kind,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const first = backends[0];
		if (first instanceof DaemonBlobBackend) first.prewarm();
		if (backends.length === 0) return null;
		return backends.length === 1 ? backends[0] : new FallbackBlobBackend(backends);
	}

	/**
	 * Decorate images in configured backend order. The first source that can
	 * represent an image wins; provider-native upload failures continue into
	 * the following URL destinations without changing the session context.
	 */
	async decorateContext(context: Context, model: Model): Promise<Context> {
		if (!contextHasImages(context)) return context;
		const position = Math.min(this.#providerFilePosition, this.#configs.length);
		let decorated = context;
		if (position > 0) {
			decorated = await this.#decorateUrls(
				decorated,
				model,
				this.#configs.slice(0, position),
				`range:0:${position}`,
			);
		}
		if (this.#providerFiles) decorated = await this.#providerFiles.decorateContext(decorated, model);
		if (position < this.#configs.length) {
			decorated = await this.#decorateUrls(
				decorated,
				model,
				this.#configs.slice(position),
				`range:${position}:${this.#configs.length}`,
			);
		}
		await this.#recordSavings(context, decorated, model);
		return decorated;
	}

	async #recordSavings(source: Context, decorated: Context, model: Model): Promise<void> {
		if (!this.#savingsJournal || source === decorated) return;
		const sourceImages: ImageContent[] = [];
		const decoratedImages: ImageContent[] = [];
		for (const message of source.messages) {
			if (
				(message.role === "user" || message.role === "developer" || message.role === "toolResult") &&
				Array.isArray(message.content)
			) {
				for (const block of message.content) {
					if (block.type === "image") sourceImages.push(block);
				}
			}
		}
		for (const message of decorated.messages) {
			if (
				(message.role === "user" || message.role === "developer" || message.role === "toolResult") &&
				Array.isArray(message.content)
			) {
				for (const block of message.content) {
					if (block.type === "image") decoratedImages.push(block);
				}
			}
		}

		const counters = new Map<string, { imageCount: number; inlineBytes: number; referenceBytes: number }>();
		const count = Math.min(sourceImages.length, decoratedImages.length);
		for (let index = 0; index < count; index++) {
			const inline = sourceImages[index];
			const reference = decoratedImages[index];
			if (
				inline.data.length === 0 ||
				inline.url ||
				inline.providerFile ||
				(!reference.url && !reference.providerFile)
			) {
				continue;
			}
			const destination = reference.providerFile
				? "provider-files"
				: reference.url
					? this.#publicationByUrl.get(reference.url)?.destination
					: undefined;
			if (!destination) continue;
			const inlineBytes = Buffer.byteLength(inline.data, "utf8");
			const referenceBytes = Buffer.byteLength(
				reference.providerFile ? JSON.stringify(reference.providerFile) : (reference.url ?? ""),
				"utf8",
			);
			const current = counters.get(destination) ?? { imageCount: 0, inlineBytes: 0, referenceBytes: 0 };
			current.imageCount++;
			current.inlineBytes += inlineBytes;
			current.referenceBytes += referenceBytes;
			counters.set(destination, current);
		}
		if (counters.size === 0) return;
		const timestamp = Date.now();
		const records: BlobBrokerSavingsRecord[] = [];
		for (const [destination, counter] of counters) {
			records.push({
				timestamp,
				provider: model.provider,
				model: model.id,
				destination,
				...counter,
				savedBytes: counter.inlineBytes - counter.referenceBytes,
			});
		}
		await this.#savingsJournal.append(records);
	}

	async #decorateUrls(
		context: Context,
		model: Model,
		configs: readonly BlobBrokerWorkerConfig[],
		backendKey: string,
	): Promise<Context> {
		if (configs.length === 0 || this.#quarantined.has(model.provider) || !supportsRemoteImageUrls(model)) {
			return context;
		}
		const backend = await this.#ensureBackend(configs, backendKey);
		if (!backend) return context;

		const byHash = new Map<string, ImageContent[]>();
		for (const message of context.messages) {
			if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type !== "image" || block.url || block.providerFile || block.data.length === 0) continue;
				const hash = blockContentHash(block);
				const group = byHash.get(hash);
				if (group) group.push(block);
				else byHash.set(hash, [block]);
			}
		}
		if (byHash.size === 0) return context;

		const urlByBlock = new Map<ImageContent, string>();
		await Promise.all(
			[...byHash].map(async ([hash, blocks]) => {
				const data = blocks[0].data;
				let publication: BlobPublication | null;
				try {
					publication = await backend.ensureBlob(
						hash,
						blocks[0].mimeType,
						() => Buffer.from(data, "base64"),
						() => data,
					);
				} catch (error) {
					logger.warn("blob-broker: backend publication failed", {
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				if (!publication) return;
				this.#publicationByUrl.set(publication.url, publication);
				const rangeStart = this.#configs.indexOf(configs[0]);
				this.#publicationSourceByUrl.set(publication.url, {
					rangeStart: rangeStart < 0 ? 0 : rangeStart,
					rangeEnd: rangeStart < 0 ? this.#configs.length : rangeStart + configs.length,
					hash,
				});
				for (const block of blocks) urlByBlock.set(block, publication.url);
			}),
		);
		return urlByBlock.size === 0 ? context : decorateContextImages(context, block => urlByBlock.get(block));
	}

	/**
	 * Lazy snapcompact frames: URL-bearing placeholders whose PNG renders only
	 * when a provider fetches them. `null` in uploader mode or when no backend
	 * is reachable — the transformer then renders eagerly as before.
	 */
	get frameSink(): SnapcompactFrameSink {
		return {
			framesFor: async (text, shape, maxFrames) => {
				// A leading provider-file source needs eager bytes so the later
				// model-aware decoration phase can upload them natively.
				if (this.#providerFiles && this.#providerFilePosition === 0) return null;
				const backend = await this.#ensureBackend();
				if (!backend?.supportsLazy) return null;
				const total = snapcompact.frames(text, { shape });
				const count = maxFrames === undefined ? total : Math.min(total, maxFrames);
				if (count <= 0) return null;
				const textHash = Bun.hash(text).toString(16);
				const shapeHash = Bun.hash(JSON.stringify(shape)).toString(16);
				// One render covers every frame of this text; shared lazily across
				// the per-frame fetchers and dropped once settled frames age out of
				// the backend's byte budget.
				let rendered: Promise<ImageContent[]> | undefined;
				const renderAll = (): Promise<ImageContent[]> => {
					rendered ??= snapcompact.renderMany(text, { shape, ...(maxFrames !== undefined ? { maxFrames } : {}) });
					return rendered;
				};
				const frames: ImageContent[] = [];
				for (let index = 0; index < count; index++) {
					const key = `sc:${textHash}:${shapeHash}:${index}`;
					const fetcher: LazyBlobFetcher = async () => {
						const all = await renderAll();
						const frame = all[index];
						return frame ? Buffer.from(frame.data, "base64") : null;
					};
					const publication = await backend.ensureLazy(key, "image/png", fetcher);
					if (!publication) return null;
					this.#publicationByUrl.set(publication.url, publication);
					this.#publicationSourceByUrl.set(publication.url, {
						rangeStart: 0,
						rangeEnd: this.#configs.length,
						hash: key,
					});
					this.#producers.set(key, fetcher);
					this.#lazyKeyByUrl.set(publication.url, key);
					frames.push({
						type: "image",
						data: "",
						mimeType: "image/png",
						url: publication.url,
					});
				}
				return frames;
			},
		};
	}

	/**
	 * Undo URL decoration for an inline retry: strip URLs and materialize
	 * lazy placeholders (empty `data`) through their session-side producers.
	 */
	inlineContext(context: Context): Promise<Context> {
		return inlineContextImages(context, async block => {
			if (block.data.length > 0) return block.data;
			const key = block.url ? this.#lazyKeyByUrl.get(block.url) : undefined;
			const fetcher = key ? this.#producers.get(key) : undefined;
			const bytes = fetcher ? await fetcher() : null;
			return bytes ? bytes.toBase64() : null;
		});
	}

	#imageUrls(context: Context): string[] {
		const urls: string[] = [];
		for (const message of context.messages) {
			if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type === "image" && block.url) urls.push(block.url);
			}
		}
		return urls;
	}

	#failedConfigIndex(urls: readonly string[]): number {
		for (const url of urls) {
			const publication = this.#publicationByUrl.get(url);
			const source = this.#publicationSourceByUrl.get(url);
			if (!publication || !source) continue;
			const relativeIndex = this.#configs
				.slice(source.rangeStart, source.rangeEnd)
				.findIndex(config => config.kind === publication.destination);
			if (relativeIndex >= 0) return source.rangeStart + relativeIndex;
		}
		return -1;
	}

	#forgetUrls(urls: readonly string[]): void {
		for (const url of urls) {
			const lazyKey = this.#lazyKeyByUrl.get(url);
			this.#publicationByUrl.delete(url);
			this.#publicationSourceByUrl.delete(url);
			this.#lazyKeyByUrl.delete(url);
			if (lazyKey) this.#producers.delete(lazyKey);
		}
	}

	/**
	 * Advance one rejected image source. Provider-file rejection starts the
	 * URL chain from its beginning. URL rejection resumes strictly after the
	 * destination that produced the failed publication, then falls back inline.
	 */
	async fallbackContext(context: Context, model: Model): Promise<Context> {
		const urls = this.#imageUrls(context);
		if (contextHasProviderFiles(context)) {
			await this.#providerFiles?.invalidateContext(context, model);
			const inline = await this.inlineContext(context);
			this.#forgetUrls(urls);
			const withUrls = await this.#decorateUrls(inline, model, this.#configs, "all");
			const fallback = contextHasImageUrls(withUrls) ? withUrls : inline;
			await this.#recordSavings(inline, fallback, model);
			return fallback;
		}

		const failedIndex = this.#failedConfigIndex(urls);
		const inline = await this.inlineContext(context);
		this.#forgetUrls(urls);
		const nextIndex = failedIndex + 1;
		if (failedIndex < 0 || nextIndex >= this.#configs.length) return inline;
		const withUrls = await this.#decorateUrls(
			inline,
			model,
			this.#configs.slice(nextIndex),
			`range:${nextIndex}:${this.#configs.length}`,
		);
		const fallback = contextHasImageUrls(withUrls) ? withUrls : inline;
		await this.#recordSavings(inline, fallback, model);
		return fallback;
	}

	/** Stop decorating for `provider`; used when inline retry proved URLs were the failure. */
	quarantine(provider: string, reason: string): void {
		if (this.#quarantined.has(provider)) return;
		this.#quarantined.add(provider);
		logger.warn("blob-broker: provider quarantined from image URLs", { provider, reason });
	}

	isQuarantined(provider: string): boolean {
		return this.#quarantined.has(provider);
	}

	stop(): void {
		for (const pending of this.#backendPromises.values()) void pending.then(backend => backend?.stop());
		this.#backendPromises.clear();
		this.#publicationByUrl.clear();
		this.#publicationSourceByUrl.clear();
		this.#lazyKeyByUrl.clear();
		this.#producers.clear();
	}
}

function destinationOptions(
	configured: Readonly<Record<string, unknown>> | undefined,
): Record<string, DestinationOptionValue> {
	const options: Record<string, DestinationOptionValue> = {};
	if (!configured) return options;
	for (const key in configured) {
		const value = configured[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			options[key] = value;
		}
	}
	return options;
}

/** Deterministic durable provider-file cache path for one project. */
export function providerFileCachePath(settings: Settings, projectDir: string): string {
	const projectHash = Bun.hash.wyhash(path.resolve(projectDir)).toString(16);
	return path.join(getBlobsDir(settings.getAgentDir()), `provider-files-index-${projectHash}.json`);
}

/** Resolve configured URL destinations without constructing their runtimes. */
export function resolveBlobBrokerConfigs(settings: Settings, projectDir: string): BlobBrokerWorkerConfig[] {
	const blobsDir = getBlobsDir(settings.getAgentDir());
	const projectHash = Bun.hash.wyhash(path.resolve(projectDir)).toString(16);
	const savingsPath = blobBrokerSavingsJournalPath(settings, projectDir);
	const optionsByDestination = cfgImagesUrlsOptions.get(settings);
	const credentialsByDestination = cfgImagesUrlsCredentials.get(settings);
	const configs: BlobBrokerWorkerConfig[] = [];
	for (const destination of cfgImagesUrlsBackends.get(settings)) {
		if (destination === "provider-files") continue;
		const options = destinationOptions(optionsByDestination[destination]);
		if (destination === "command" && typeof options.command !== "string") {
			const command = cfgImagesUrlsCommand.get(settings);
			if (command) options.command = command;
		}
		const configuredBaseUrl = options.publicBaseUrl;
		const configuredBindHost = options.bindHost;
		const configuredSshTarget = options.sshTarget ?? options.host;
		const configuredSshRemotePort = options.sshRemotePort;
		configs.push({
			kind: destination,
			options,
			credentials: { ...credentialsByDestination[destination] },
			publicBaseUrl:
				typeof configuredBaseUrl === "string"
					? configuredBaseUrl || undefined
					: cfgImagesUrlsPublicBaseUrl.get(settings) || undefined,
			bindHost:
				typeof configuredBindHost === "string"
					? configuredBindHost || "127.0.0.1"
					: cfgImagesUrlsBindHost.get(settings) || "127.0.0.1",
			sshTarget:
				typeof configuredSshTarget === "string"
					? configuredSshTarget || undefined
					: cfgImagesUrlsSshTarget.get(settings) || undefined,
			sshRemotePort:
				typeof configuredSshRemotePort === "number"
					? configuredSshRemotePort
					: cfgImagesUrlsSshRemotePort.get(settings),
			persist: {
				blobsDir,
				indexPath: path.join(blobsDir, `urls-index-${destination}-${projectHash}.json`),
				savingsPath,
				ttlMs: Math.max(0, cfgImagesUrlsTtlHours.get(settings)) * 3_600_000,
			},
		});
	}
	return configs;
}

/** Build the configured service; `undefined` when disabled or no destination is available. */
export function createImageUrlServiceFromSettings(
	settings: Settings,
	projectDir: string,
	resolveCredential: ProviderFileCredentialResolver,
): ImageUrlService | undefined {
	if (!cfgImagesUrlsEnabled.get(settings)) return undefined;
	const configs = resolveBlobBrokerConfigs(settings, projectDir);
	let providerFilePosition: number | undefined;
	let urlPosition = 0;
	for (const destination of cfgImagesUrlsBackends.get(settings)) {
		if (destination === "provider-files") providerFilePosition ??= urlPosition;
		else urlPosition++;
	}
	if (configs.length === 0 && providerFilePosition === undefined) {
		logger.warn("blob-broker: no configured image backend is available; images stay inline");
		return undefined;
	}
	const savingsJournal = new BlobBrokerSavingsJournal(blobBrokerSavingsJournalPath(settings, projectDir));
	const providerFiles =
		providerFilePosition === undefined
			? undefined
			: new ProviderFileManager(
					new ProviderFileCache(providerFileCachePath(settings, projectDir)),
					resolveCredential,
				);
	return new ImageUrlService(projectDir, configs, {
		providerFiles,
		providerFilePosition: providerFilePosition ?? configs.length,
		savingsJournal,
	});
}
