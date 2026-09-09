import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "../../src/hindsight/client";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("HindsightApi fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("combines caller cancellation with the request timeout", async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ results: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const caller = new AbortController();
		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		await client.recall("bank", "query", { signal: caller.signal });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
		expect(requestSignal).not.toBe(caller.signal);
		caller.abort(new Error("caller aborted"));
		expect(requestSignal?.aborted).toBe(true);
		expect(requestSignal?.reason).toBe(caller.signal.reason);
	});
});

describe("HindsightApi per-op timeouts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports the effective per-op deadline in the timeout error", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (): Promise<Response> => {
					throw new DOMException("The operation timed out.", "TimeoutError");
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			timeouts: { reflect: 90_000, recall: 15_000 },
		});

		await expect(client.reflect("bank", "q")).rejects.toThrow("reflect request timed out after 90s");
		await expect(client.recall("bank", "q")).rejects.toThrow("recall request timed out after 15s");
	});

	it("falls back to the client request default for ops without an override", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (): Promise<Response> => {
					throw new DOMException("The operation timed out.", "TimeoutError");
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			timeouts: { request: 45_000 },
		});

		await expect(client.createBank("bank")).rejects.toThrow("createBank request timed out after 45s");
	});
});
