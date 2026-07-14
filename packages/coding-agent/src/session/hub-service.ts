/**
 * Cloud-durable OMP hub client.
 *
 * Hub blobs contain a gzip-compressed `snapshotForReplication()` payload and
 * are sealed client-side with AES-256-GCM. The relay receives a bearer token
 * for account authorization, but never the AES key: it remains in the #key
 * fragment of the hub link and in the operator's local settings.
 */
import type { SessionEntry, SessionHeader } from "./session-entries";

export const HUB_MAX_SEALED_BYTES = 1_000_000;
export const HUB_MAX_PLAINTEXT_BYTES = 16_000_000;
const HUB_KEY_BYTES = 32;
const HUB_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const HUB_PATH_RE = /^\/h\/([A-Za-z0-9_-]{10,64})\/?$/;
const HUB_SNAPSHOT_VERSION = 1;

export interface HubSnapshotSource {
	snapshotForReplication(): HubSessionSnapshot;
}

export interface HubLink {
	readonly hubId: string;
	readonly keyText: string;
}

export interface HubDeviceSummary {
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

export interface HubPublishResult extends HubLink {
	readonly url: string;
	readonly method: "hub";
	readonly devices: number;
	readonly deviceId: string;
}

export interface HubResumeResult {
	readonly hubId: string;
	readonly devices: ReadonlyArray<HubDeviceSummary>;
	readonly lastPublishedAt: string;
	readonly entryCount: number;
	readonly snapshot: HubSessionSnapshot;
}

export interface HubSessionSnapshot {
	readonly header: SessionHeader;
	readonly entries: SessionEntry[];
	readonly leafId: string | null;
}

export interface HubProvisionResult {
	readonly token: string;
	readonly accountId: string;
	readonly displayName: string;
	readonly createdAt: string;
}

export interface HubPublishOptions {
	/** Continue an existing hub; omit to allocate a new hub id. */
	hubId?: string;
	/** Reuse the current hub key; omit only when allocating a new hub. */
	keyText?: string;
	deviceId?: string;
}

export interface HubServiceOptions {
	baseUrl?: string;
	token?: string;
	deviceId?: string;
}

export class HubService {
	readonly #baseUrl: string;
	#token: string | undefined;
	#deviceId: string | undefined;

	constructor(options: HubServiceOptions = {}) {
		this.#baseUrl = normaliseBaseUrl(options.baseUrl);
		this.#token = options.token;
		this.#deviceId = options.deviceId;
	}

	get baseUrl(): string {
		return this.#baseUrl;
	}

	get deviceId(): string | undefined {
		return this.#deviceId;
	}

	async provision(adminToken: string, displayName: string): Promise<HubProvisionResult> {
		if (!adminToken) throw new HubError("OMP_HUB_ADMIN_TOKEN is required to provision hub access");
		const response = await fetch(`${this.#baseUrl}/tokens`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${adminToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ displayName }),
		});
		const payload = await responseRecord(response);
		if (!response.ok) throw new HubError(`hub provisioning failed (${response.status}): ${errorText(payload)}`);
		const token = stringValue(payload, "token");
		const accountId = stringValue(payload, "accountId");
		const resolvedName = stringValue(payload, "displayName");
		const createdAt = stringValue(payload, "createdAt");
		if (!token || !accountId || !resolvedName || !createdAt)
			throw new HubError("hub provisioning response was incomplete");
		return { token, accountId, displayName: resolvedName, createdAt };
	}

	async publish(sessionManager: HubSnapshotSource, options: HubPublishOptions = {}): Promise<HubPublishResult> {
		const token = this.#token;
		if (!token) throw new HubError("hub.token is required to publish a session");
		const hubId = options.hubId ?? generateHubId();
		if (!HUB_ID_RE.test(hubId)) throw new HubError(`invalid hub id: ${hubId}`);
		const deviceId = options.deviceId ?? this.#ensureDeviceId();
		const snapshot = sessionManager.snapshotForReplication();
		const leafId = snapshot.leafId;
		const entries = activeBranchEntries(snapshot.entries, leafId);
		const plaintext = new TextEncoder().encode(
			JSON.stringify({
				version: HUB_SNAPSHOT_VERSION,
				header: snapshot.header,
				entries,
				leafId,
			}),
		);
		if (plaintext.byteLength > HUB_MAX_PLAINTEXT_BYTES) {
			throw new HubError(
				`session snapshot is ${plaintext.byteLength} bytes plaintext; hub maximum is ${HUB_MAX_PLAINTEXT_BYTES}`,
			);
		}
		const sealed = await sealSnapshot(plaintext, options.keyText);
		if (sealed.bytes.byteLength > HUB_MAX_SEALED_BYTES) {
			throw new HubError(
				`session snapshot is ${sealed.bytes.byteLength} bytes sealed; hub maximum is ${HUB_MAX_SEALED_BYTES}`,
			);
		}
		const response = await fetch(this.#hubUrl(hubId), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/octet-stream",
				"X-OMP-Hub-Id": hubId,
				"X-OMP-Entry-Count": String(entries.length),
			},
			body: sealed.bytes,
		});
		const payload = await responseRecord(response);
		if (!response.ok) throw new HubError(`hub publish failed (${response.status}): ${errorText(payload)}`);
		const devices = numberValue(payload, "devices") ?? 1;
		return {
			hubId,
			keyText: sealed.keyText,
			url: `${this.#baseUrl}/${hubId}#${sealed.keyText}`,
			method: "hub",
			devices,
			deviceId,
		};
	}

	async list(): Promise<ReadonlyArray<HubListingEntry>> {
		const response = await this.#authorisedFetch(this.#baseUrl);
		const payload = await responseRecord(response);
		if (!response.ok) throw new HubError(`hub list failed (${response.status}): ${errorText(payload)}`);
		const entries = Array.isArray(payload.entries) ? payload.entries : [];
		return entries
			.filter(isRecord)
			.map(entry => ({
				hubId: stringValue(entry, "hubId") ?? "",
				title: stringValue(entry, "title") ?? "",
				devices: numberValue(entry, "devices") ?? 0,
				lastPublishedAt: stringValue(entry, "lastPublishedAt") ?? "",
				entryCount: numberValue(entry, "entryCount") ?? 0,
				resumable: booleanValue(entry, "resumable") ?? false,
			}))
			.filter(entry => HUB_ID_RE.test(entry.hubId));
	}

	async devices(hubId: string): Promise<ReadonlyArray<HubDeviceSummary>> {
		if (!HUB_ID_RE.test(hubId)) throw new HubError(`invalid hub id: ${hubId}`);
		const response = await this.#authorisedFetch(this.#hubUrl(hubId, "devices"));
		const payload = await responseRecord(response);
		if (!response.ok) throw new HubError(`hub devices failed (${response.status}): ${errorText(payload)}`);
		return parseDevices(payload);
	}

	async resume(link: HubLink): Promise<HubResumeResult> {
		if (!HUB_ID_RE.test(link.hubId)) throw new HubError(`invalid hub id: ${link.hubId}`);
		const response = await this.#authorisedFetch(this.#hubUrl(link.hubId, "head"));
		const payload = await responseRecord(response);
		if (response.status === 404) throw new HubError(`hub ${link.hubId} was not found`, 404);
		if (!response.ok) throw new HubError(`hub resume failed (${response.status}): ${errorText(payload)}`);
		const sealed = stringValue(payload, "sealed");
		if (!sealed) throw new HubError("hub head response was missing its sealed snapshot");
		const snapshot = await decryptSnapshot(base64Decode(sealed), link.keyText);
		return {
			hubId: link.hubId,
			snapshot,
			devices: parseDevices(payload),
			lastPublishedAt: stringValue(payload, "lastPublishedAt") ?? "",
			entryCount: numberValue(payload, "entryCount") ?? 0,
		};
	}

	async revoke(hubId: string): Promise<void> {
		if (!HUB_ID_RE.test(hubId)) throw new HubError(`invalid hub id: ${hubId}`);
		const deviceId = this.#deviceId;
		if (!deviceId) throw new HubError("hub.deviceId is required to revoke this device's snapshot");
		const response = await this.#authorisedFetch(this.#hubUrl(hubId), {
			method: "DELETE",
			headers: { "X-OMP-Device-Id": deviceId },
		});
		if (!response.ok && response.status !== 404) {
			const payload = await responseRecord(response);
			throw new HubError(`hub revoke failed (${response.status}): ${errorText(payload)}`);
		}
	}

	#ensureDeviceId(): string {
		if (this.#deviceId) return this.#deviceId;
		this.#deviceId = `dev_${randomBase64Url(16)}`;
		return this.#deviceId;
	}

	#hubUrl(hubId: string, suffix?: string): string {
		const base = `${this.#baseUrl}/${hubId}`;
		return suffix ? `${base}/${suffix}` : base;
	}

	async #authorisedFetch(url: string, init: RequestInit = {}): Promise<Response> {
		if (!this.#token) throw new HubError("hub.token is required");
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.#token}`);
		return fetch(url, { ...init, headers });
	}
}

export class HubError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "HubError";
		this.status = status;
	}
}

export function parseHubLink(value: string): HubLink {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new HubError("paste the complete hub link, including its #key fragment");
	}
	const match = HUB_PATH_RE.exec(url.pathname);
	const keyText = url.hash.slice(1);
	if (!match || !keyText) throw new HubError("hub link must be https://…/h/<hubId>#<key>");
	validateKey(keyText);
	return { hubId: match[1]!, keyText };
}

function normaliseBaseUrl(input: string | undefined): string {
	const value = input?.trim() || "https://collab.pkking.computer/h";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new HubError("hub.relayUrl must be an absolute URL");
	}
	if (url.search || url.hash) throw new HubError("hub.relayUrl must not include a query string or fragment");
	const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (url.protocol !== "https:" && !localHttp)
		throw new HubError("hub.relayUrl must use HTTPS unless it targets localhost");
	return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/h"}`;
}

function generateHubId(): string {
	return `hub_${randomBase64Url(16)}`;
}

function activeBranchEntries(entries: ReadonlyArray<SessionEntry>, leafId: string | null): SessionEntry[] {
	if (leafId === null) return [];
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	if (byId.size !== entries.length) throw new HubError("session snapshot contains duplicate entry ids");
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let cursor = byId.get(leafId);
	while (cursor) {
		if (seen.has(cursor.id)) throw new HubError("active session branch contains a cycle");
		seen.add(cursor.id);
		branch.unshift(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	if (branch.at(-1)?.id !== leafId) throw new HubError("active session leaf is missing from the replication snapshot");
	if (branch[0]?.parentId !== null) throw new HubError("active session branch has a missing parent");
	return structuredClone(branch) as SessionEntry[];
}

function arrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
async function sealSnapshot(plaintext: Uint8Array, keyText?: string): Promise<{ bytes: Uint8Array; keyText: string }> {
	const keyBytes = arrayBufferBytes(keyText ? validateKey(keyText) : randomBytes(HUB_KEY_BYTES));
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
	const iv = arrayBufferBytes(randomBytes(12));
	const compressed = arrayBufferBytes(Bun.gzipSync(arrayBufferBytes(plaintext)));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, compressed));
	const bytes = new Uint8Array(iv.byteLength + ciphertext.byteLength);
	bytes.set(iv);
	bytes.set(ciphertext, iv.byteLength);
	return { bytes, keyText: keyText ?? base64UrlEncode(keyBytes) };
}

async function decryptSnapshot(sealed: Uint8Array, keyText: string): Promise<HubSessionSnapshot> {
	if (sealed.byteLength <= 12) throw new HubError("hub snapshot is truncated");
	const key = await crypto.subtle.importKey("raw", arrayBufferBytes(validateKey(keyText)), "AES-GCM", false, [
		"decrypt",
	]);
	let compressed: ArrayBuffer;
	try {
		compressed = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: arrayBufferBytes(sealed.subarray(0, 12)) },
			key,
			arrayBufferBytes(sealed.subarray(12)),
		);
	} catch {
		throw new HubError("hub decryption failed: the link key is incorrect or the snapshot is corrupted");
	}
	let value: unknown;
	try {
		const plaintext = await gunzipBounded(new Uint8Array(compressed), HUB_MAX_PLAINTEXT_BYTES);
		value = JSON.parse(new TextDecoder().decode(plaintext));
	} catch (error) {
		if (error instanceof HubError) throw error;
		throw new HubError("hub snapshot is not valid compressed session data");
	}
	return parseSnapshot(value);
}

async function gunzipBounded(compressed: Uint8Array, limit: number): Promise<Uint8Array> {
	const stream = new Blob([arrayBufferBytes(compressed)]).stream().pipeThrough(new DecompressionStream("gzip"));
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new HubError(`hub snapshot exceeds the ${limit}-byte plaintext limit`);
		}
		chunks.push(value);
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function parseSnapshot(value: unknown): HubSessionSnapshot {
	if (
		!isRecord(value) ||
		value.version !== HUB_SNAPSHOT_VERSION ||
		!isSessionHeader(value.header) ||
		!Array.isArray(value.entries) ||
		(value.leafId !== null && typeof value.leafId !== "string")
	) {
		throw new HubError("hub snapshot has an unsupported session shape");
	}
	const header = value.header;
	if (!value.entries.every(isSessionEntry)) {
		throw new HubError("hub snapshot contains an invalid session entry");
	}
	if (value.leafId && !value.entries.some(entry => entry.id === value.leafId)) {
		throw new HubError("hub snapshot active leaf is missing");
	}
	return {
		header: structuredClone(header),
		entries: structuredClone(value.entries),
		leafId: value.leafId,
	};
}

function isSessionHeader(value: unknown): value is SessionHeader {
	return (
		isRecord(value) &&
		value.type === "session" &&
		typeof value.id === "string" &&
		typeof value.timestamp === "string" &&
		typeof value.cwd === "string"
	);
}

function isSessionEntry(value: unknown): value is SessionEntry {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		typeof value.id === "string" &&
		(value.parentId === null || typeof value.parentId === "string") &&
		typeof value.timestamp === "string"
	);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (!text) return {};
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : {};
	} catch {
		return { error: text.slice(0, 240) };
	}
}

function parseDevices(payload: Record<string, unknown>): HubDeviceSummary[] {
	const devices = Array.isArray(payload.devices) ? payload.devices : [];
	return devices
		.filter(isRecord)
		.map(entry => ({
			deviceId: stringValue(entry, "deviceId") ?? "",
			displayName: stringValue(entry, "displayName") ?? "",
			lastPublishedAt: stringValue(entry, "lastPublishedAt") ?? "",
			entryCount: numberValue(entry, "entryCount") ?? 0,
		}))
		.filter(entry => entry.deviceId.length > 0);
}

function validateKey(keyText: string): Uint8Array {
	const key = base64UrlDecode(keyText);
	if (key.byteLength !== HUB_KEY_BYTES) throw new HubError("hub link key must decode to 32 bytes");
	return key;
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function randomBase64Url(length: number): string {
	return base64UrlEncode(randomBytes(length));
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const base64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
	try {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		throw new HubError("hub link key is not valid base64url");
	}
}

function base64Decode(value: string): Uint8Array {
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		throw new HubError("hub head returned invalid base64 data");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function errorText(payload: Record<string, unknown>): string {
	return stringValue(payload, "error") ?? "unexpected response";
}
