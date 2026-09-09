import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";

function captureRequestBodies(): string[] {
	const bodies: string[] = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			bodies.push(String(init?.body ?? ""));
			return new Response("{}", { status: 200 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return bodies;
}

function firstTimestamp(bodyText: string): string | undefined {
	const body: unknown = JSON.parse(bodyText);
	if (typeof body !== "object" || body === null) return undefined;

	const items = Object.getOwnPropertyDescriptor(body, "items")?.value;
	if (!Array.isArray(items)) return undefined;

	const first = items[0];
	if (typeof first !== "object" || first === null) return undefined;

	const timestamp = Object.getOwnPropertyDescriptor(first, "timestamp")?.value;
	return typeof timestamp === "string" ? timestamp : undefined;
}

describe("HindsightApi timestamp serialization", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("serializes Date timestamps with the local timezone offset", async () => {
		const bodies = captureRequestBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		await client.retain("omp", "evening memory", {
			timestamp: new Date(2026, 5, 12, 19, 17, 0),
		});

		const timestamp = firstTimestamp(bodies[0] ?? "{}");
		if (timestamp === undefined) throw new Error("Missing serialized timestamp");
		expect(timestamp).toMatch(/^2026-06-12T19:17:00[+-]\d{2}:\d{2}$/);
		expect(timestamp.endsWith("Z")).toBe(false);
	});

	it("preserves caller-provided timestamp strings", async () => {
		const bodies = captureRequestBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		await client.retain("omp", "evening memory", {
			timestamp: "2026-06-12T19:17:00+08:00",
		});

		expect(firstTimestamp(bodies[0] ?? "{}")).toBe("2026-06-12T19:17:00+08:00");
	});
});
