import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	HUB_MAX_PLAINTEXT_BYTES,
	HubService,
	type HubSnapshotSource,
	parseHubLink,
} from "../../src/session/hub-service";
import { SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage } from "../../src/session/session-storage";

const restoreCallbacks: Array<() => void> = [];

afterEach(() => {
	for (const restore of restoreCallbacks.splice(0)) restore();
});

const snapshot: HubSnapshotSource = {
	snapshotForReplication: () => ({
		header: {
			type: "session",
			version: 3,
			id: "019f5d54-ef85-7000-b363-2c38e15a9233",
			title: "Car handoff",
			timestamp: "2026-07-14T12:00:00.000Z",
			cwd: "C:/dev/project",
		},
		entries: [
			{
				type: "thinking_level_change",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-07-14T12:01:00.000Z",
				thinkingLevel: "high",
			},
			{
				type: "thinking_level_change",
				id: "entry-2",
				parentId: null,
				timestamp: "2026-07-14T12:02:00.000Z",
				thinkingLevel: "low",
			},
		],
		leafId: "entry-1",
	}),
};

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
	return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

async function sealCompressed(bytes: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ownedBytes(keyBytes), "AES-GCM", false, ["encrypt"]);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, Bun.gzipSync(ownedBytes(bytes))),
	);
	const sealed = new Uint8Array(iv.byteLength + encrypted.byteLength);
	sealed.set(iv);
	sealed.set(encrypted, iv.byteLength);
	return sealed;
}

describe("HubService", () => {
	test("round-trips a replication snapshot using the same hub link key", async () => {
		let storedSealed: Uint8Array | undefined;
		const fetchStub: typeof globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const request =
					input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init);
				if (request.method === "POST") {
					expect(request.headers.get("Authorization")).toBe("Bearer account-token");
					expect(request.headers.get("X-OMP-Hub-Title")).toBeNull();
					expect(request.headers.get("X-OMP-Entry-Count")).toBe("1");
					storedSealed = new Uint8Array(await request.arrayBuffer());
					return new Response(JSON.stringify({ hubId: "hub_alpha01", devices: 1 }), { status: 201 });
				}
				if (request.url.endsWith("/head")) {
					if (!storedSealed) throw new Error("missing published blob");
					return new Response(
						JSON.stringify({
							hubId: "hub_alpha01",
							sealed: base64(storedSealed),
							entryCount: 1,
							devices: [],
						}),
					);
				}
				return new Response("unexpected", { status: 500 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		restoreCallbacks.push(() => fetchSpy.mockRestore());

		const hub = new HubService({
			baseUrl: "https://relay.example/h",
			token: "account-token",
			deviceId: "dev_laptop_alpha",
		});
		const published = await hub.publish(snapshot, { hubId: "hub_alpha01" });
		const resumed = await hub.resume(parseHubLink(published.url));
		const storage = new MemorySessionStorage();
		const imported = await SessionManager.forkFromSnapshot(resumed.snapshot, "C:/dev/project", undefined, storage);

		expect(published.url).toMatch(/^https:\/\/relay\.example\/h\/hub_alpha01#[A-Za-z0-9_-]{43}$/);
		expect(resumed.snapshot).toEqual({
			header: {
				type: "session",
				version: 3,
				id: "019f5d54-ef85-7000-b363-2c38e15a9233",
				title: "Car handoff",
				timestamp: "2026-07-14T12:00:00.000Z",
				cwd: "C:/dev/project",
			},
			entries: [
				{
					type: "thinking_level_change",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-07-14T12:01:00.000Z",
					thinkingLevel: "high",
				},
			],
			leafId: "entry-1",
		});
		expect(imported.getLeafId()).toBe("entry-1");
		const sessionFile = imported.getSessionFile();
		if (!sessionFile) throw new Error("expected imported session file");
		await imported.close();
		const reopened = await SessionManager.open(sessionFile, undefined, storage, { initialCwd: "C:/dev/project" });
		expect(reopened.getLeafId()).toBe("entry-1");
		expect(reopened.getEntries().map(entry => entry.id)).toEqual(["entry-1"]);
		await reopened.close();
	});

	test("rejects duplicate entry ids before selecting an active branch", async () => {
		const duplicate = snapshot.snapshotForReplication();
		duplicate.entries[1] = { ...duplicate.entries[1]!, id: "entry-1" };
		const source: HubSnapshotSource = { snapshotForReplication: () => duplicate };
		const hub = new HubService({
			baseUrl: "https://relay.example/h",
			token: "account-token",
			deviceId: "dev_laptop_alpha",
		});

		await expect(hub.publish(source, { hubId: "hub_alpha01" })).rejects.toThrow("duplicate entry ids");
		await expect(
			SessionManager.forkFromSnapshot(duplicate, "C:/dev/project", undefined, new MemorySessionStorage()),
		).rejects.toThrow("duplicate entry ids");
	});

	test("rejects a compressed snapshot whose plaintext exceeds the resume limit", async () => {
		const keyBytes = crypto.getRandomValues(new Uint8Array(32));
		const sealed = await sealCompressed(new Uint8Array(HUB_MAX_PLAINTEXT_BYTES + 1), keyBytes);
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					sealed: base64(sealed),
					lastPublishedAt: "2026-07-14T12:01:00.000Z",
					entryCount: 1,
					devices: [],
				}),
			),
		);
		restoreCallbacks.push(() => fetchSpy.mockRestore());
		const hub = new HubService({ baseUrl: "https://relay.example/h", token: "account-token" });

		await expect(hub.resume({ hubId: "hub_alpha01", keyText: base64Url(keyBytes) })).rejects.toThrow(
			"plaintext limit",
		);
	});
});
