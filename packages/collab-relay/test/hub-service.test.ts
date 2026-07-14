import { describe, expect, test } from "bun:test";
import { HUB_RETENTION_MS, type HubServiceDependencies, handleHubRequest, pruneHubs } from "../src/hub-service";
import type {
	HubAccessToken,
	HubBucketBinding,
	HubStoredObject,
	HubStoredValue,
	HubTokenBinding,
} from "../src/hub-types";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const ADMIN_TOKEN = "admin_abcdefghijklmnopqrstuvwxyz1234567890";
const ACCOUNT_TOKEN = "hubt_abcdefghijklmnopqrstuvwxyz1234567890";
const OTHER_ACCOUNT_TOKEN = "hubt_other_abcdefghijklmnopqrstuvwxyz1234";
const ACCOUNT: HubAccessToken = {
	accountId: "acct_alice",
	displayName: "alice",
	createdAt: "2026-07-14T12:00:00.000Z",
};
const OTHER_ACCOUNT: HubAccessToken = {
	accountId: "acct_bob",
	displayName: "bob",
	createdAt: "2026-07-14T12:00:00.000Z",
};
const DEVICE_A = "dev_phone_alpha";
const DEVICE_B = "dev_laptop_beta";

class MemoryHubBucket implements HubBucketBinding {
	readonly objects = new Map<string, HubStoredValue>();
	pageSize = Number.POSITIVE_INFINITY;

	async get(key: string): Promise<HubStoredValue | null> {
		const value = this.objects.get(key);
		return value ? { ...value, sealed: new Uint8Array(value.sealed), uploaded: new Date(value.uploaded) } : null;
	}

	async put(key: string, value: HubStoredValue): Promise<unknown> {
		this.objects.set(key, { ...value, sealed: new Uint8Array(value.sealed), uploaded: new Date(value.uploaded) });
		return undefined;
	}

	async delete(keys: string | string[]): Promise<void> {
		for (const key of typeof keys === "string" ? [keys] : keys) this.objects.delete(key);
	}

	async list(options: { prefix: string; limit: number; cursor?: string }) {
		const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
		const matches = [...this.objects.entries()].filter(([key]) => key.startsWith(options.prefix));
		const pageLimit = Math.min(options.limit, this.pageSize);
		const page = matches.slice(offset, offset + pageLimit);
		const objects: HubStoredObject[] = page.map(([key, value]) => ({ key, uploaded: value.uploaded }));
		const nextOffset = offset + page.length;
		const truncated = nextOffset < matches.length;
		return { objects, truncated, cursor: truncated ? String(nextOffset) : undefined };
	}
}

class MemoryTokenStore implements HubTokenBinding {
	readonly values = new Map<string, HubAccessToken>();

	async get(token: string): Promise<HubAccessToken | null> {
		return this.values.get(token) ?? null;
	}

	async put(token: string, value: HubAccessToken): Promise<void> {
		this.values.set(token, value);
	}
}

function testDeps(bucket: MemoryHubBucket, tokens: MemoryTokenStore): HubServiceDependencies {
	return {
		hubs: bucket,
		tokens,
		claimUpload: async () => null,
		adminToken: ADMIN_TOKEN,
		now: () => NOW,
	};
}

function seededDeps(): { bucket: MemoryHubBucket; tokens: MemoryTokenStore; deps: HubServiceDependencies } {
	const bucket = new MemoryHubBucket();
	const tokens = new MemoryTokenStore();
	tokens.values.set(ACCOUNT_TOKEN, ACCOUNT);
	tokens.values.set(OTHER_ACCOUNT_TOKEN, OTHER_ACCOUNT);
	return { bucket, tokens, deps: testDeps(bucket, tokens) };
}

function request(path: string, init: RequestInit = {}, token = ACCOUNT_TOKEN): Request {
	const headers = new Headers(init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return new Request(`https://collab.pkking.computer${path}`, { ...init, headers });
}

async function handled(requestValue: Request, deps: HubServiceDependencies): Promise<Response> {
	const response = await handleHubRequest(requestValue, deps);
	if (!response) throw new Error(`hub did not handle ${new URL(requestValue.url).pathname}`);
	return response;
}

function publishRequest(hubId: string, deviceId: string, body: Uint8Array, entryCount = 1): Request {
	return request(`/h/${hubId}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/octet-stream",
			"X-OMP-Hub-Id": hubId,
			"X-OMP-Device-Id": deviceId,
			"X-OMP-Entry-Count": String(entryCount),
		},
		body,
	});
}

function provisionPayload(value: unknown): { token: string; accountId: string; displayName: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("expected provision object");
	if (!("token" in value) || !("accountId" in value) || !("displayName" in value))
		throw new Error("missing provision fields");
	const { token, accountId, displayName } = value;
	if (typeof token !== "string" || typeof accountId !== "string" || typeof displayName !== "string") {
		throw new Error("invalid provision fields");
	}
	return { token, accountId, displayName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
	const value: unknown = await response.json();
	if (!isRecord(value)) throw new Error("expected JSON object");
	return value;
}

describe("hub service", () => {
	test("provisions a token only with the worker administrator secret", async () => {
		const { tokens, deps } = seededDeps();
		const response = await handled(
			request(
				"/h/tokens",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ displayName: "car and laptop" }),
				},
				ADMIN_TOKEN,
			),
			deps,
		);
		expect(response.status).toBe(201);
		const payload = provisionPayload(await response.json());
		expect(payload.token).toMatch(/^hubt_[A-Za-z0-9_-]{43}$/);
		expect(payload.accountId).toMatch(/^acct_[A-Za-z0-9_-]{22}$/);
		expect(payload.displayName).toBe("car and laptop");
		expect(await tokens.get(payload.token)).toEqual({
			accountId: payload.accountId,
			displayName: "car and laptop",
			createdAt: "2026-07-14T12:00:00.000Z",
		});

		const denied = await handled(
			request(
				"/h/tokens",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ displayName: "attacker" }),
				},
				"wrong",
			),
			deps,
		);
		expect(denied.status).toBe(403);
	});

	test("lets every linked device publish and retrieve the account's latest snapshot", async () => {
		const { deps } = seededDeps();
		const phone = await handled(publishRequest("hub_alpha01", DEVICE_A, new Uint8Array(64).fill(7), 500), deps);
		expect(phone.status).toBe(201);
		const laptop = await handled(publishRequest("hub_alpha01", DEVICE_B, new Uint8Array(64).fill(9), 700), deps);
		expect(laptop.status).toBe(201);

		const devices = await handled(request("/h/hub_alpha01/devices"), deps);
		expect(await responseRecord(devices)).toEqual({
			hubId: "hub_alpha01",
			devices: [
				{ deviceId: DEVICE_A, displayName: "alice", lastPublishedAt: "2026-07-14T12:00:00.000Z", entryCount: 500 },
				{ deviceId: DEVICE_B, displayName: "alice", lastPublishedAt: "2026-07-14T12:00:00.000Z", entryCount: 700 },
			],
		});

		const head = await handled(request("/h/hub_alpha01/head"), deps);
		expect(await responseRecord(head)).toEqual({
			hubId: "hub_alpha01",
			sealed: btoa(String.fromCharCode(...new Uint8Array(64).fill(9))),
			lastPublishedAt: "2026-07-14T12:00:00.000Z",
			entryCount: 700,
			devices: [
				{ deviceId: DEVICE_A, displayName: "alice", lastPublishedAt: "2026-07-14T12:00:00.000Z", entryCount: 500 },
				{ deviceId: DEVICE_B, displayName: "alice", lastPublishedAt: "2026-07-14T12:00:00.000Z", entryCount: 700 },
			],
		});

		const listing = await handled(request("/h"), deps);
		expect(await responseRecord(listing)).toEqual({
			entries: [
				{
					hubId: "hub_alpha01",
					title: "OMP session",
					devices: 2,
					lastPublishedAt: "2026-07-14T12:00:00.000Z",
					entryCount: 700,
					resumable: true,
				},
			],
		});
	});

	test("does not expose one account's hub data to another account", async () => {
		const { deps } = seededDeps();
		await handled(publishRequest("hub_alpha01", DEVICE_A, new Uint8Array(64).fill(7)), deps);

		const other = await handled(request("/h/hub_alpha01/head", {}, OTHER_ACCOUNT_TOKEN), deps);
		expect(other.status).toBe(404);
		const listing = await handled(request("/h", {}, OTHER_ACCOUNT_TOKEN), deps);
		expect(await responseRecord(listing)).toEqual({ entries: [] });
	});

	test("rejects browser-safelisted uploads and unauthenticated requests", async () => {
		const { deps } = seededDeps();
		const wrongMedia = await handled(
			request("/h/hub_alpha01", {
				method: "POST",
				headers: { "Content-Type": "text/plain", "X-OMP-Device-Id": DEVICE_A },
				body: "drive-by upload",
			}),
			deps,
		);
		const missingEntryCount = await handled(
			request("/h/hub_alpha01", {
				method: "POST",
				headers: {
					"Content-Type": "application/octet-stream",
					"X-OMP-Device-Id": DEVICE_A,
				},
				body: new Uint8Array(64),
			}),
			deps,
		);
		expect(missingEntryCount.status).toBe(400);

		expect(wrongMedia.status).toBe(415);

		const noToken = await handled(new Request("https://collab.pkking.computer/h/hub_alpha01/head"), deps);
		expect(noToken.status).toBe(401);
	});

	test("returns 405 with Allow for unsupported read-route methods", async () => {
		const { deps } = seededDeps();
		for (const [path, method] of [
			["/h", "POST"],
			["/h/hub_alpha01/head", "DELETE"],
			["/h/hub_alpha01/devices", "POST"],
		] as const) {
			const response = await handled(request(path, { method }), deps);
			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("GET");
		}
	});

	test("revoke removes only the current device snapshot", async () => {
		const { deps } = seededDeps();
		await handled(publishRequest("hub_alpha01", DEVICE_A, new Uint8Array(64).fill(7)), deps);
		await handled(publishRequest("hub_alpha01", DEVICE_B, new Uint8Array(64).fill(9)), deps);

		const revoke = await handled(
			request("/h/hub_alpha01", { method: "DELETE", headers: { "X-OMP-Device-Id": DEVICE_A } }),
			deps,
		);
		expect(revoke.status).toBe(200);
		const devices = await handled(request("/h/hub_alpha01/devices"), deps);
		expect(await responseRecord(devices)).toEqual({
			hubId: "hub_alpha01",
			devices: [
				{
					deviceId: DEVICE_B,
					displayName: "alice",
					lastPublishedAt: "2026-07-14T12:00:00.000Z",
					entryCount: 1,
				},
			],
		});
	});

	test("reads and prunes every paginated bucket page", async () => {
		const { bucket, deps } = seededDeps();
		bucket.pageSize = 1;
		await handled(publishRequest("hub_alpha01", DEVICE_A, new Uint8Array(64), 3), deps);
		await handled(publishRequest("hub_beta002", DEVICE_B, new Uint8Array(64), 4), deps);
		const listing = await handled(request("/h"), deps);
		const payload = await responseRecord(listing);
		expect(Array.isArray(payload.entries) ? payload.entries.length : 0).toBe(2);
		for (const [key, value] of bucket.objects) {
			bucket.objects.set(key, { ...value, uploaded: new Date(NOW - HUB_RETENTION_MS - 1) });
		}
		expect(await pruneHubs(bucket, NOW)).toBe(2);
		expect(bucket.objects.size).toBe(0);
	});

	test("prunes expired device records", async () => {
		const { bucket } = seededDeps();
		await bucket.put("hubs/acct_alice/old/dev_a", {
			accountId: "acct_alice",
			hubId: "old",
			deviceId: "dev_a",
			displayName: "alice",
			title: "old",
			sealed: new Uint8Array(64),
			entryCount: 1,
			uploaded: new Date(NOW - HUB_RETENTION_MS - 1),
		});
		await bucket.put("hubs/acct_alice/fresh/dev_b", {
			accountId: "acct_alice",
			hubId: "fresh",
			deviceId: "dev_b",
			displayName: "alice",
			title: "fresh",
			sealed: new Uint8Array(64),
			entryCount: 1,
			uploaded: new Date(NOW),
		});

		expect(await pruneHubs(bucket, NOW)).toBe(1);
		expect(await bucket.get("hubs/acct_alice/old/dev_a")).toBeNull();
		expect(await bucket.get("hubs/acct_alice/fresh/dev_b")).not.toBeNull();
	});
});
