import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { HubService, type HubSnapshotSource, parseHubLink } from "../../src/session/hub-service";

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
		],
	}),
};

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
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
					storedSealed = new Uint8Array(await request.arrayBuffer());
					return new Response(JSON.stringify({ hubId: "hub_alpha01", devices: 1 }), { status: 201 });
				}
				if (request.url.endsWith("/head")) {
					if (!storedSealed) throw new Error("missing published blob");
					return new Response(
						JSON.stringify({
							hubId: "hub_alpha01",
							sealed: base64(storedSealed),
							lastPublishedAt: "2026-07-14T12:01:00.000Z",
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
		const records = resumed.jsonl
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));

		expect(published.url).toMatch(/^https:\/\/relay\.example\/h\/hub_alpha01#[A-Za-z0-9_-]{43}$/);
		expect(records).toEqual([
			{
				type: "session",
				version: 3,
				id: "019f5d54-ef85-7000-b363-2c38e15a9233",
				title: "Car handoff",
				timestamp: "2026-07-14T12:00:00.000Z",
				cwd: "C:/dev/project",
			},
			{
				type: "thinking_level_change",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-07-14T12:01:00.000Z",
				thinkingLevel: "high",
			},
		]);
	});
});
