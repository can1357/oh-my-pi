/**
 * Cloud-durable OMP hub — server side.
 *
 * A hub stores encrypted session snapshots by account, hub, and device. The
 * relay never receives an encryption key or plaintext session data. A shared
 * account access token authorizes every device the operator chooses to link;
 * the `deviceId` header only distinguishes each device's latest snapshot.
 *
 * Routes:
 *   POST /h/tokens            mint an account token (worker-admin only)
 *   GET  /h                   list caller's hubs
 *   POST /h/<hubId>           publish a sealed snapshot
 *   GET  /h/<hubId>           inspect caller's devices for a hub
 *   GET  /h/<hubId>/devices   inspect caller's devices for a hub
 *   GET  /h/<hubId>/head      fetch the caller's newest sealed snapshot
 *   DELETE /h/<hubId>         remove the caller's current-device snapshot
 */

import type {
	HubAccessToken,
	HubBucketBinding,
	HubServiceDependencies,
	HubStoredObject,
	HubStoredValue,
} from "./hub-types";

export type { HubServiceDependencies } from "./hub-types";

const HUB_ROOT_PATH = "/h";
const HUB_TOKEN_PATH = "/h/tokens";
const HUB_PATH_RE = /^\/h\/([A-Za-z0-9_-]{10,64})\/?$/;
const HUB_DEVICES_PATH_RE = /^\/h\/([A-Za-z0-9_-]{10,64})\/devices\/?$/;
const HUB_HEAD_PATH_RE = /^\/h\/([A-Za-z0-9_-]{10,64})\/head\/?$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_HUB_BLOB_BYTES = 1_000_000;
const MAX_TOKEN_REQUEST_BYTES = 1_024;
const HUB_KEY_PREFIX = "hubs/";
export const HUB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface HubDeviceListing {
	readonly deviceId: string;
	readonly displayName: string;
	readonly lastPublishedAt: string;
	readonly entryCount: number;
}

export interface HubListingEntry {
	readonly hubId: string;
	readonly title: string;
	readonly devices: number;
	readonly lastPublishedAt: string;
	readonly entryCount: number;
	readonly resumable: boolean;
}

export interface HubHead {
	readonly hubId: string;
	readonly sealed: string;
	readonly lastPublishedAt: string;
	readonly entryCount: number;
	readonly devices: ReadonlyArray<HubDeviceListing>;
}

export async function handleHubRequest(request: Request, deps: HubServiceDependencies): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname === HUB_TOKEN_PATH) return provisionAccessToken(request, deps);
	if (url.pathname === HUB_ROOT_PATH || url.pathname === `${HUB_ROOT_PATH}/`) {
		if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET" });
		const access = await authorise(request, deps);
		return access instanceof Response ? access : listHubs(access, deps);
	}

	const head = matchPath(HUB_HEAD_PATH_RE, url.pathname);
	if (head) {
		if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET" });
		const access = await authorise(request, deps);
		return access instanceof Response ? access : serveHubHead(head, access, deps);
	}
	const devices = matchPath(HUB_DEVICES_PATH_RE, url.pathname);
	if (devices) {
		if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET" });
		const access = await authorise(request, deps);
		return access instanceof Response ? access : serveHubDevices(devices, access, deps);
	}
	const hubId = matchPath(HUB_PATH_RE, url.pathname);
	if (!hubId) return null;
	const access = await authorise(request, deps);
	if (access instanceof Response) return access;
	if (request.method === "POST") return publishHub(hubId, request, access, deps);
	if (request.method === "GET") return serveHubOverview(hubId, access, deps);
	if (request.method === "DELETE") return revokeHub(hubId, request, access, deps);
	return json({ error: "method not allowed" }, 405, { Allow: "GET, POST, DELETE" });
}

function matchPath(re: RegExp, pathname: string): string | null {
	const match = re.exec(pathname);
	return match?.[1] ?? null;
}

function json(data: unknown, status = 200, extraHeaders: Readonly<Record<string, string>> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
	});
}

async function authorise(request: Request, deps: HubServiceDependencies): Promise<HubAccessToken | Response> {
	const token = extractToken(request);
	if (!token) return json({ error: "hub token required" }, 401);
	const access = await deps.tokens.get(token);
	return access ?? json({ error: "invalid hub token" }, 401);
}

function extractToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice("Bearer ".length).trim();
	return token.length > 0 && token.length <= 256 ? token : null;
}

function expectDeviceId(request: Request): string | null {
	const id = request.headers.get("X-OMP-Device-Id");
	return id && DEVICE_ID_RE.test(id) ? id : null;
}

async function provisionAccessToken(request: Request, deps: HubServiceDependencies): Promise<Response> {
	if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
	if (!deps.adminToken) return json({ error: "hub provisioning is not configured" }, 503);
	const provided = extractToken(request);
	if (!provided || !tokensEqual(provided, deps.adminToken))
		return json({ error: "invalid hub administrator token" }, 403);
	const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") return json({ error: "hub provisioning requires application/json" }, 415);
	const input = await readBoundedJson(request, MAX_TOKEN_REQUEST_BYTES);
	if (!input) return json({ error: "invalid hub provisioning payload" }, 400);
	const displayName = normaliseDisplayName(input.displayName);
	if (!displayName) return json({ error: "displayName must contain printable text" }, 400);
	const now = new Date((deps.now ?? Date.now)()).toISOString();
	const token = `hubt_${randomBase64Url(32)}`;
	const access: HubAccessToken = {
		accountId: `acct_${randomBase64Url(16)}`,
		displayName,
		createdAt: now,
	};
	await deps.tokens.put(token, access);
	return json({ token, accountId: access.accountId, displayName, createdAt: now }, 201);
}

function tokensEqual(provided: string, expected: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(provided);
	const right = encoder.encode(expected);
	if ("timingSafeEqual" in crypto.subtle && typeof crypto.subtle.timingSafeEqual === "function") {
		return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
	}
	// Bun's WebCrypto shim does not yet expose Cloudflare's native primitive.
	// Compare every byte anyway so the same source remains testable off-Worker.
	let difference = left.byteLength ^ right.byteLength;
	for (let index = 0; index < Math.max(left.byteLength, right.byteLength); index++) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

async function publishHub(
	hubId: string,
	request: Request,
	access: HubAccessToken,
	deps: HubServiceDependencies,
): Promise<Response> {
	const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/octet-stream") {
		return json({ error: "hub publish requires application/octet-stream" }, 415);
	}
	const deviceId = expectDeviceId(request);
	if (!deviceId) return json({ error: "X-OMP-Device-Id header required" }, 400);
	const claimedHubId = request.headers.get("X-OMP-Hub-Id");
	if (claimedHubId !== null && claimedHubId !== hubId)
		return json({ error: "hub id header does not match request path" }, 400);
	const limit = await deps.claimUpload(request);
	if (limit) return limit;
	const sealed = await readBoundedBody(request);
	if (!sealed || sealed.byteLength <= 12) return json({ error: "hub blob exceeds 1 MB or is truncated" }, 413);
	const entryCountText = request.headers.get("X-OMP-Entry-Count");
	const entryCount = entryCountText === null ? Number.NaN : Number(entryCountText);
	if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
		return json({ error: "X-OMP-Entry-Count must be a non-negative integer" }, 400);
	}
	const now = new Date((deps.now ?? Date.now)());
	const key = hubObjectKey(access.accountId, hubId, deviceId);
	await deps.hubs.put(key, {
		accountId: access.accountId,
		hubId,
		deviceId,
		displayName: access.displayName,
		title: "OMP session",
		sealed,
		entryCount,
		uploaded: now,
	});
	const devices = await countDevices(hubId, access.accountId, deps);
	return json({ hubId, devices, entryCount, uploadedAt: now.toISOString() }, 201);
}

async function serveHubOverview(
	hubId: string,
	access: HubAccessToken,
	deps: HubServiceDependencies,
): Promise<Response> {
	const records = await listHubRecords(hubId, access.accountId, deps);
	if (records.length === 0) return json({ error: "hub not found" }, 404);
	const head = latestRecord(records);
	return json({
		hubId,
		title: head.title,
		devices: deviceListings(records),
		lastPublishedAt: head.uploaded.toISOString(),
		entryCount: head.entryCount,
	});
}

async function serveHubDevices(hubId: string, access: HubAccessToken, deps: HubServiceDependencies): Promise<Response> {
	const records = await listHubRecords(hubId, access.accountId, deps);
	if (records.length === 0) return json({ error: "hub not found" }, 404);
	return json({ hubId, devices: deviceListings(records) });
}

async function serveHubHead(hubId: string, access: HubAccessToken, deps: HubServiceDependencies): Promise<Response> {
	const records = await listHubRecords(hubId, access.accountId, deps);
	if (records.length === 0) return json({ error: "hub not found" }, 404);
	const head = latestRecord(records);
	return json({
		hubId,
		sealed: base64Encode(head.sealed),
		lastPublishedAt: head.uploaded.toISOString(),
		entryCount: head.entryCount,
		devices: deviceListings(records),
	} satisfies HubHead);
}

async function revokeHub(
	hubId: string,
	request: Request,
	access: HubAccessToken,
	deps: HubServiceDependencies,
): Promise<Response> {
	const deviceId = expectDeviceId(request);
	if (!deviceId) return json({ error: "X-OMP-Device-Id header required" }, 400);
	const key = hubObjectKey(access.accountId, hubId, deviceId);
	const existing = await deps.hubs.get(key);
	if (!existing) return json({ error: "hub device not found" }, 404);
	await deps.hubs.delete(key);
	return json({ hubId, deviceId, revoked: true });
}

async function listHubs(access: HubAccessToken, deps: HubServiceDependencies): Promise<Response> {
	const records = await listHubRecordsForAccount(access.accountId, deps);
	const groups = new Map<string, HubStoredValue[]>();
	for (const record of records) {
		const group = groups.get(record.hubId) ?? [];
		group.push(record);
		groups.set(record.hubId, group);
	}
	const entries: HubListingEntry[] = [...groups.entries()]
		.map(([hubId, group]) => {
			const head = latestRecord(group);
			return {
				hubId,
				title: head.title,
				devices: group.length,
				lastPublishedAt: head.uploaded.toISOString(),
				entryCount: head.entryCount,
				resumable: true,
			};
		})
		.sort((left, right) => right.lastPublishedAt.localeCompare(left.lastPublishedAt));
	return json({ entries });
}

function hubObjectKey(accountId: string, hubId: string, deviceId: string): string {
	return `${HUB_KEY_PREFIX}${accountId}/${hubId}/${deviceId}`;
}

async function listHubRecords(
	hubId: string,
	accountId: string,
	deps: HubServiceDependencies,
): Promise<HubStoredValue[]> {
	const listings = await listAllHubObjects(deps.hubs, `${HUB_KEY_PREFIX}${accountId}/${hubId}/`, 200);
	const records: HubStoredValue[] = [];
	for (const listing of listings) {
		const value = await deps.hubs.get(listing.key);
		if (value?.accountId === accountId && value.hubId === hubId) records.push(value);
	}
	return records;
}

async function listHubRecordsForAccount(accountId: string, deps: HubServiceDependencies): Promise<HubStoredValue[]> {
	const listings = await listAllHubObjects(deps.hubs, `${HUB_KEY_PREFIX}${accountId}/`, 200);
	const records: HubStoredValue[] = [];
	for (const listing of listings) {
		const value = await deps.hubs.get(listing.key);
		if (value?.accountId === accountId) records.push(value);
	}
	return records;
}

async function listAllHubObjects(hubs: HubBucketBinding, prefix: string, limit: number): Promise<HubStoredObject[]> {
	const objects: HubStoredObject[] = [];
	let cursor: string | undefined;
	let hasMore = true;
	while (hasMore) {
		const page = await hubs.list({ prefix, limit, cursor });
		objects.push(...page.objects);
		hasMore = page.truncated;
		if (hasMore) {
			if (!page.cursor || page.cursor === cursor)
				throw new Error("hub bucket returned an invalid pagination cursor");
			cursor = page.cursor;
		}
	}
	return objects;
}

async function countDevices(hubId: string, accountId: string, deps: HubServiceDependencies): Promise<number> {
	return (await listHubRecords(hubId, accountId, deps)).length;
}

function latestRecord(records: ReadonlyArray<HubStoredValue>): HubStoredValue {
	return records.reduce((latest, current) => (current.uploaded >= latest.uploaded ? current : latest));
}

function deviceListings(records: ReadonlyArray<HubStoredValue>): HubDeviceListing[] {
	return records.map(record => ({
		deviceId: record.deviceId,
		displayName: record.displayName,
		lastPublishedAt: record.uploaded.toISOString(),
		entryCount: record.entryCount,
	}));
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
	const contentLength = Number(request.headers.get("Content-Length") ?? 0);
	if (!Number.isFinite(contentLength) || contentLength > MAX_HUB_BLOB_BYTES || !request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > MAX_HUB_BLOB_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(request: Request, limit: number): Promise<Record<string, unknown> | null> {
	const contentLength = Number(request.headers.get("Content-Length") ?? 0);
	if (!Number.isFinite(contentLength) || contentLength > limit || !request.body) return null;
	const bytes = await readBoundedBodyWithLimit(request, limit);
	if (!bytes) return null;
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

async function readBoundedBodyWithLimit(request: Request, limit: number): Promise<Uint8Array | null> {
	const contentLength = Number(request.headers.get("Content-Length") ?? 0);
	if (!Number.isFinite(contentLength) || contentLength > limit || !request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function normaliseDisplayName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return normalized.length > 0 && normalized.length <= 80 ? normalized : null;
}

function randomBase64Url(bytesLength: number): string {
	const bytes = new Uint8Array(bytesLength);
	crypto.getRandomValues(bytes);
	return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Encode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
export async function pruneHubs(hubs: HubBucketBinding, now: number = Date.now()): Promise<number> {
	const listings = await listAllHubObjects(hubs, HUB_KEY_PREFIX, 1_000);
	const expired = listings
		.filter(listing => now - listing.uploaded.getTime() > HUB_RETENTION_MS)
		.map(listing => listing.key);
	for (let offset = 0; offset < expired.length; offset += 1_000) {
		await hubs.delete(expired.slice(offset, offset + 1_000));
	}
	return expired.length;
}
