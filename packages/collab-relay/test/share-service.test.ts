import { describe, expect, test } from "bun:test";
import {
	handleShareRequest,
	pruneShares,
	SHARE_RETENTION_MS,
	type ShareBucketBinding,
	type ShareListing,
	type SharePutOptions,
	type ShareServiceDependencies,
	type StoredShare,
} from "../src/share-service";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const VIEWER_HTML = "<!doctype html><script>window.__OMP_SESSION_DATA__ = Promise.resolve({});</script>";
const VIEWER_CSP = "default-src 'none'; script-src 'sha256-fake'; img-src 'self' data:";

interface MemoryObject {
	readonly bytes: Uint8Array;
	readonly uploaded: Date;
	readonly options?: SharePutOptions;
}

class MemoryShareBucket implements ShareBucketBinding {
	readonly objects = new Map<string, MemoryObject>();
	readonly deleted: string[] = [];
	uploadedAt = new Date(NOW);

	async get(key: string): Promise<StoredShare | null> {
		const object = this.objects.get(key);
		if (!object) return null;
		return {
			body: new Response(object.bytes.slice().buffer).body!,
			uploaded: object.uploaded,
			httpEtag: `"${key}"`,
			size: object.bytes.byteLength,
		};
	}

	async put(key: string, body: Uint8Array, options: SharePutOptions): Promise<unknown> {
		this.objects.set(key, { bytes: body.slice(), uploaded: new Date(this.uploadedAt), options });
		return undefined;
	}

	async delete(keys: string | string[]): Promise<void> {
		for (const key of typeof keys === "string" ? [keys] : keys) {
			this.deleted.push(key);
			this.objects.delete(key);
		}
	}

	async list(options: {
		readonly prefix: string;
		readonly limit: number;
		readonly cursor?: string;
	}): Promise<ShareListing> {
		const objects = [...this.objects]
			.filter(([key]) => key.startsWith(options.prefix))
			.slice(0, options.limit)
			.map(([key, object]) => ({ key, uploaded: object.uploaded }));
		return { objects, truncated: false };
	}
}

interface TestDependencies {
	readonly deps: ShareServiceDependencies;
	readonly assetPaths: string[];
}

function testDependencies(bucket: MemoryShareBucket): TestDependencies {
	const assetPaths: string[] = [];
	return {
		assetPaths,
		deps: {
			assets: {
				async fetch(request: Request): Promise<Response> {
					const path = new URL(request.url).pathname;
					assetPaths.push(path);
					if (path === "/share-viewer/csp.txt") return new Response(VIEWER_CSP);
					return new Response(VIEWER_HTML, { headers: { "Content-Type": "text/html" } });
				},
			},
			shares: bucket,
			claimUpload: async () => null,
			now: () => NOW,
		},
	};
}

async function route(request: Request, deps: ShareServiceDependencies): Promise<Response> {
	const response = await handleShareRequest(request, deps);
	if (!response) throw new Error(`share route did not handle ${new URL(request.url).pathname}`);
	return response;
}

async function responseId(response: Response): Promise<string> {
	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || !("id" in payload) || typeof payload.id !== "string") {
		throw new Error("share upload response is missing id");
	}
	return payload.id;
}

describe("collab relay share service", () => {
	test("serves the dedicated share viewer at the public share URL", async () => {
		const bucket = new MemoryShareBucket();
		const { deps, assetPaths } = testDependencies(bucket);
		const response = await route(new Request("https://collab.pkking.computer/s/abcdefghij"), deps);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
		expect(response.headers.get("Content-Security-Policy")).toBe(VIEWER_CSP);
		expect(assetPaths).toContain("/share-viewer/csp.txt");
	});

	test("fails closed when the share viewer asset is missing", async () => {
		const bucket = new MemoryShareBucket();
		const { deps: baseDeps } = testDependencies(bucket);
		const deps: ShareServiceDependencies = {
			...baseDeps,
			assets: { fetch: async () => new Response("missing", { status: 404 }) },
		};

		const response = await route(new Request("https://collab.pkking.computer/s/abcdefghij"), deps);

		expect(response.status).toBe(503);
		const payload: unknown = await response.json();
		expect(payload).toEqual({ error: "share viewer unavailable" });
	});

	test("fails closed when the share viewer CSP manifest is missing", async () => {
		const bucket = new MemoryShareBucket();
		const { deps: baseDeps } = testDependencies(bucket);
		const deps: ShareServiceDependencies = {
			...baseDeps,
			assets: {
				async fetch(request: Request): Promise<Response> {
					const path = new URL(request.url).pathname;
					if (path === "/share-viewer/") {
						return new Response(VIEWER_HTML, { headers: { "Content-Type": "text/html" } });
					}
					return new Response("missing", { status: 404 });
				},
			},
		};

		const response = await route(new Request("https://collab.pkking.computer/s/abcdefghij"), deps);

		expect(response.status).toBe(503);
		const payload: unknown = await response.json();
		expect(payload).toEqual({ error: "share viewer unavailable" });
	});

	test("rejects browser-safelisted uploads before claiming quota", async () => {
		const bucket = new MemoryShareBucket();
		const { deps: baseDeps } = testDependencies(bucket);
		let claimed = false;
		const deps: ShareServiceDependencies = {
			...baseDeps,
			claimUpload: async () => {
				claimed = true;
				return null;
			},
		};

		const response = await route(
			new Request("https://collab.pkking.computer/s", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "drive-by upload",
			}),
			deps,
		);

		expect(response.status).toBe(415);
		expect(claimed).toBe(false);
		expect(bucket.objects.size).toBe(0);
	});

	test("uploads and retrieves an opaque sealed share", async () => {
		const bucket = new MemoryShareBucket();
		const { deps } = testDependencies(bucket);
		const sealed = Uint8Array.from({ length: 32 }, (_, index) => index);
		const upload = await route(
			new Request("https://collab.pkking.computer/s", {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: sealed,
			}),
			deps,
		);
		const id = await responseId(upload);

		expect(upload.status).toBe(201);
		expect(id).toMatch(/^r_[A-Za-z0-9_-]{22}$/);
		const stored = bucket.objects.get(`shares/${id}`);
		expect(stored?.bytes).toEqual(sealed);
		expect(stored?.options?.customMetadata.createdAt).toBe("2026-07-13T12:00:00.000Z");

		const download = await route(new Request(`https://collab.pkking.computer/s/${id}/raw`), deps);
		expect(download.status).toBe(200);
		expect(download.headers.get("Cache-Control")).toBe("private, no-store");
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(sealed);
		const trailingSlashDownload = await route(new Request(`https://collab.pkking.computer/s/${id}/raw/`), deps);
		expect(new Uint8Array(await trailingSlashDownload.arrayBuffer())).toEqual(sealed);
	});

	test("returns 410 and removes a share once retention expires", async () => {
		const bucket = new MemoryShareBucket();
		const id = "expiredShare";
		bucket.objects.set(`shares/${id}`, {
			bytes: new Uint8Array(20),
			uploaded: new Date(NOW - SHARE_RETENTION_MS),
		});
		const { deps } = testDependencies(bucket);

		const response = await route(new Request(`https://collab.pkking.computer/s/${id}/raw`), deps);

		expect(response.status).toBe(410);
		expect(await response.text()).toBe("share expired");
		expect(bucket.objects.has(`shares/${id}`)).toBe(false);
		expect(bucket.deleted).toEqual([`shares/${id}`]);
	});

	test("scheduled pruning deletes expired shares and keeps current ones", async () => {
		const bucket = new MemoryShareBucket();
		bucket.objects.set("shares/expired", {
			bytes: new Uint8Array(20),
			uploaded: new Date(NOW - SHARE_RETENTION_MS - 1),
		});
		bucket.objects.set("shares/current", {
			bytes: new Uint8Array(20),
			uploaded: new Date(NOW - SHARE_RETENTION_MS + 1),
		});

		await pruneShares(bucket, NOW);

		expect(bucket.objects.has("shares/expired")).toBe(false);
		expect(bucket.objects.has("shares/current")).toBe(true);
	});

	test("rejects unsupported methods and ignores unrelated paths", async () => {
		const bucket = new MemoryShareBucket();
		const { deps } = testDependencies(bucket);
		const methodResponse = await route(
			new Request("https://collab.pkking.computer/s/abcdefghij", { method: "POST" }),
			deps,
		);

		expect(methodResponse.status).toBe(405);
		expect(methodResponse.headers.get("Allow")).toBe("GET");
		expect(await handleShareRequest(new Request("https://collab.pkking.computer/other"), deps)).toBeNull();
	});
});
