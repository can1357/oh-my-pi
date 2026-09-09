import { afterEach, describe, expect, it, vi } from "bun:test";
import { searchSmitheryRegistry } from "../../src/mcp/smithery-registry";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("searchSmitheryRegistry fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds timeout signals to search and detail requests", async () => {
		const signals: AbortSignal[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, init?: FetchInit) => {
				if (init?.signal instanceof AbortSignal) signals.push(init.signal);
				const url = String(input);
				if (url.includes("?")) {
					return Response.json({
						servers: [
							{
								id: "srv_1",
								namespace: "smithery-ai",
								slug: "filesystem",
								qualifiedName: "@smithery-ai/filesystem",
								displayName: "Filesystem",
								description: "File access",
								useCount: 1,
							},
						],
					});
				}
				return Response.json({
					qualifiedName: "@smithery-ai/filesystem",
					displayName: "Filesystem",
					description: "File access",
					connections: [{ type: "http", deploymentUrl: "https://mcp.example" }],
					tools: [],
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const results = await searchSmitheryRegistry("filesystem", { limit: 1 });

		expect(results[0]?.name).toBe("smithery-ai/filesystem");
		expect(signals).toHaveLength(2);
		expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true);
	});
});
