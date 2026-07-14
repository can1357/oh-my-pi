import { DurableObject } from "cloudflare:workers";
import { handleHubRequest, pruneHubs } from "./hub-service";
import type {
	HubAccessToken,
	HubBucketBinding,
	HubServiceDependencies,
	HubStoredValue,
	HubTokenBinding,
} from "./hub-types";
import { handleShareRequest, pruneShares, type ShareServiceDependencies } from "./share-service";

type RelayRole = "host" | "guest";

interface SocketAttachment {
	role: RelayRole;
	peerId: number;
}

interface Env {
	ASSETS: Fetcher;
	COLLAB_ROOMS: DurableObjectNamespace<CollabRoom>;
	SHARES: R2Bucket;
	SHARE_UPLOADS: DurableObjectNamespace<ShareUploadRateLimit>;
	HUB_BLOBS: R2Bucket;
	HUB_TOKENS: KVNamespace;
	HUB_ADMIN_TOKEN?: string;
}

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;
const SHARE_UPLOAD_LIMIT = 12;
const SHARE_UPLOAD_WINDOW_MS = 60 * 60 * 1_000;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

function asBinary(message: ArrayBuffer | string): Uint8Array<ArrayBuffer> | null {
	if (typeof message === "string") return null;
	return new Uint8Array(message);
}

function readPeerId(bytes: Uint8Array): number | null {
	if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}

function rewritePeerId(bytes: Uint8Array, peerId: number): void {
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, peerId, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentOf(socket: WebSocket): SocketAttachment | null {
	const value: unknown = socket.deserializeAttachment();
	if (!isRecord(value)) return null;
	const record = value;
	if ((record.role !== "host" && record.role !== "guest") || typeof record.peerId !== "number") return null;
	return { role: record.role, peerId: record.peerId };
}

function relayResponse(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match || request.method !== "GET") return Promise.resolve(json({ error: "not found" }, 404));
	const role = url.searchParams.get("role");
	if (role !== "host" && role !== "guest") return Promise.resolve(json({ error: "invalid role" }, 400));
	const id = env.COLLAB_ROOMS.idFromName(match[1]!);
	return env.COLLAB_ROOMS.get(id).fetch(request);
}

function shareUploadClientId(request: Request): string {
	const address = request.headers.get("CF-Connecting-IP") ?? "local";
	return address.length <= 64 ? address : "unknown";
}

async function claimShareUpload(request: Request, env: Env): Promise<Response | null> {
	const id = env.SHARE_UPLOADS.idFromName(shareUploadClientId(request));
	const result = await env.SHARE_UPLOADS.get(id).fetch("https://share-upload-limit/claim");
	if (result.ok) return null;
	return new Response("share upload limit exceeded", {
		status: 429,
		headers: { "Retry-After": result.headers.get("Retry-After") ?? "60" },
	});
}

function shareDependencies(env: Env): ShareServiceDependencies {
	return {
		assets: env.ASSETS,
		shares: env.SHARES,
		claimUpload: request => claimShareUpload(request, env),
	};
}

async function assetOrSpa(request: Request, assets: Fetcher): Promise<Response> {
	const asset = await assets.fetch(request);
	if (asset.status !== 404 || request.method !== "GET") return asset;
	const rootUrl = new URL(request.url);
	rootUrl.pathname = "/";
	rootUrl.search = "";
	return assets.fetch(new Request(rootUrl, { headers: request.headers }));
}

export class CollabRoom extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("websocket upgrade required", { status: 426 });
		}
		const role = new URL(request.url).searchParams.get("role");
		if (role !== "host" && role !== "guest") return json({ error: "invalid role" }, 400);

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const sockets = this.ctx.getWebSockets();
		const host = sockets.find(socket => attachmentOf(socket)?.role === "host");

		this.ctx.acceptWebSocket(server);
		if (role === "host" && host) {
			server.close(4009, "a host is already connected for this room");
			return new Response(null, { status: 101, webSocket: client });
		}
		if (role === "guest" && !host) {
			server.close(4004, "no such room");
			return new Response(null, { status: 101, webSocket: client });
		}

		let peerId = 0;
		if (role === "guest") {
			peerId = (await this.ctx.storage.get<number>("nextPeerId")) ?? 1;
			if (peerId > 0xfffffffe) {
				server.close(4029, "room is full");
				return new Response(null, { status: 101, webSocket: client });
			}
			await this.ctx.storage.put("nextPeerId", peerId + 1);
		}
		server.serializeAttachment({ role, peerId } satisfies SocketAttachment);
		if (role === "guest") host?.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
		const attachment = attachmentOf(socket);
		const bytes = asBinary(message);
		if (!attachment || !bytes) return;
		const sockets = this.ctx.getWebSockets();
		const host = sockets.find(candidate => attachmentOf(candidate)?.role === "host");
		if (!host) return;

		if (attachment.role === "guest") {
			if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) return;
			rewritePeerId(bytes, attachment.peerId);
			host.send(bytes);
			return;
		}

		const targetPeer = readPeerId(bytes);
		if (targetPeer === null) return;
		for (const candidate of sockets) {
			const candidateAttachment = attachmentOf(candidate);
			if (candidateAttachment?.role !== "guest") continue;
			if (targetPeer === 0 || targetPeer === candidateAttachment.peerId) candidate.send(bytes);
		}
	}

	webSocketClose(socket: WebSocket): void {
		const attachment = attachmentOf(socket);
		if (!attachment) return;
		const sockets = this.ctx.getWebSockets();
		if (attachment.role === "host") {
			for (const candidate of sockets) {
				const candidateAttachment = attachmentOf(candidate);
				if (candidateAttachment?.role !== "guest") continue;
				candidate.send(JSON.stringify({ t: "room-closed" }));
				candidate.close(4001, "room closed");
			}
			return;
		}
		const host = sockets.find(candidate => attachmentOf(candidate)?.role === "host");
		if (host) host.send(JSON.stringify({ t: "peer-left", peer: attachment.peerId }));
	}
}

interface ShareUploadWindow {
	count: number;
	resetAt: number;
}

export class ShareUploadRateLimit extends DurableObject<Env> {
	async fetch(): Promise<Response> {
		const now = Date.now();
		const previous = await this.ctx.storage.get<ShareUploadWindow>("window");
		const window =
			previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + SHARE_UPLOAD_WINDOW_MS };
		if (window.count >= SHARE_UPLOAD_LIMIT) {
			return new Response(null, {
				status: 429,
				headers: { "Retry-After": String(Math.max(1, Math.ceil((window.resetAt - now) / 1_000))) },
			});
		}
		window.count++;
		await this.ctx.storage.put("window", window);
		return new Response(null, { status: 204 });
	}
}

function hubDependencies(env: Env): HubServiceDependencies {
	return {
		hubs: r2ToHubBucket(env.HUB_BLOBS),
		tokens: kvToHubTokens(env.HUB_TOKENS),
		claimUpload: request => claimShareUpload(request, env),
		adminToken: env.HUB_ADMIN_TOKEN,
	};
}

interface SerializedHubRecord {
	readonly accountId: string;
	readonly hubId: string;
	readonly deviceId: string;
	readonly displayName: string;
	readonly title: string;
	readonly sealed: string;
	readonly entryCount: number;
	readonly uploaded: string;
}

function r2ToHubBucket(bucket: R2Bucket): HubBucketBinding {
	return {
		async get(key) {
			const object = await bucket.get(key);
			if (!object) return null;
			return deserializeHubRecord(await object.json<unknown>());
		},
		async put(key, value) {
			return bucket.put(key, JSON.stringify(serializeHubRecord(value)), {
				httpMetadata: { contentType: "application/json", cacheControl: "private, max-age=0" },
			});
		},
		async delete(keys) {
			await bucket.delete(keys);
		},
		async list(options) {
			const listing = await bucket.list({ prefix: options.prefix, limit: options.limit, cursor: options.cursor });
			return {
				objects: listing.objects.map(object => ({ key: object.key, uploaded: object.uploaded })),
				truncated: listing.truncated,
			};
		},
	};
}

function serializeHubRecord(value: HubStoredValue): SerializedHubRecord {
	return {
		accountId: value.accountId,
		hubId: value.hubId,
		deviceId: value.deviceId,
		displayName: value.displayName,
		title: value.title,
		sealed: base64Encode(value.sealed),
		entryCount: value.entryCount,
		uploaded: value.uploaded.toISOString(),
	};
}

function deserializeHubRecord(value: unknown): HubStoredValue | null {
	if (!isRecord(value)) return null;
	const record = value;
	const accountId = stringProperty(record, "accountId");
	const hubId = stringProperty(record, "hubId");
	const deviceId = stringProperty(record, "deviceId");
	const displayName = stringProperty(record, "displayName");
	const title = stringProperty(record, "title");
	const sealed = stringProperty(record, "sealed");
	const entryCount = numberProperty(record, "entryCount");
	const uploadedText = stringProperty(record, "uploaded");
	if (!accountId || !hubId || !deviceId || !displayName || !title || !sealed || entryCount === null || !uploadedText) {
		return null;
	}
	const uploaded = new Date(uploadedText);
	const decoded = base64Decode(sealed);
	if (Number.isNaN(uploaded.getTime()) || !decoded || decoded.byteLength > 1_000_000) return null;
	return { accountId, hubId, deviceId, displayName, title, sealed: decoded, entryCount, uploaded };
}

function kvToHubTokens(kv: KVNamespace): HubTokenBinding {
	return {
		async get(token) {
			const raw = await kv.get(`token:${token}`);
			if (!raw) return null;
			try {
				const parsed: unknown = JSON.parse(raw);
				return deserializeHubAccessToken(parsed);
			} catch {
				return null;
			}
		},
		async put(token, value) {
			await kv.put(`token:${token}`, JSON.stringify(value));
		},
	};
}

function deserializeHubAccessToken(value: unknown): HubAccessToken | null {
	if (!isRecord(value)) return null;
	const record = value;
	const accountId = stringProperty(record, "accountId");
	const displayName = stringProperty(record, "displayName");
	const createdAt = stringProperty(record, "createdAt");
	if (!accountId || !displayName || !createdAt || Number.isNaN(new Date(createdAt).getTime())) return null;
	return { accountId, displayName, createdAt };
}

function stringProperty(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function numberProperty(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function base64Encode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64Decode(value: string): Uint8Array | null {
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true, service: "ompk-collab" });
		if (ROOM_PATH_RE.test(url.pathname)) return relayResponse(request, env);
		const shareResponse = await handleShareRequest(request, shareDependencies(env));
		if (shareResponse) return shareResponse;
		const hubResponse = await handleHubRequest(request, hubDependencies(env));
		if (hubResponse) return hubResponse;
		return assetOrSpa(request, env.ASSETS);
	},

	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await Promise.all([pruneShares(env.SHARES), pruneHubs(r2ToHubBucket(env.HUB_BLOBS))]);
	},
};
