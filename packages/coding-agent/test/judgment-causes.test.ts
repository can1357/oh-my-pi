import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ChainJudge } from "../src/judgment";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const primarySpec: ModelSpec<"typesafe"> = {
	id: "synthetic-primary", name: "Synthetic", provider: "typesafe", api: "typesafe",
	baseUrl: "https://judge.example.test", kind: "judge", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
};
const primary = buildModel(primarySpec);
const backup = buildModel({ ...primarySpec, id: "synthetic-backup" });

afterEach(() => vi.restoreAllMocks());

async function withChain(run: (judge: ChainJudge, registry: ModelRegistry) => Promise<void>): Promise<void> {
	const auth = createInMemoryAuthStorage();
	try {
		auth.keys.setRuntime("typesafe", "synthetic-key");
		const registry = new ModelRegistry(auth, "/nonexistent/judgment-causes-models.yml");
		vi.spyOn(registry, "getAvailable").mockReturnValue([primary, backup]);
		const settings = Settings.isolated({
			modelRoles: { judge: "typesafe/synthetic-primary" },
			"retry.fallbackChains": { judge: ["typesafe/synthetic-backup"] },
		});
		await run(new ChainJudge({ settings, registry, purpose: "test" }), registry);
	} finally {
		auth.close();
	}
}

async function failure(execution: Promise<unknown>): Promise<unknown> {
	try { await execution; } catch (error) { return error; }
	throw new Error("Expected candidate failure");
}

describe("ChainJudge structured failure causes", () => {
	it("retains each original typed cause rather than only the last message", () => withChain(async judge => {
		const causes = [Object.assign(new Error("transport"), { code: "ECONNRESET" }), Object.assign(new Error("request"), { status: 400 })];
		let next = 0;
		const error = await failure(judge.withCandidate(async () => { throw causes[next++]; }));
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual(causes);
	}));

	it("includes unavailable credentials so a transport failure cannot hide permanent configuration", () => withChain(async (judge, registry) => {
		vi.spyOn(registry, "getApiKey").mockImplementation(async model => model.id === primary.id ? undefined : "synthetic-key");
		const transport = Object.assign(new Error("transport"), { status: 503 });
		const error = await failure(judge.withCandidate(async () => { throw transport; }));
		expect(error).toBeInstanceOf(AggregateError);
		const causes: unknown[] = (error as AggregateError).errors;
		expect(causes).toHaveLength(2);
		expect(causes[0]).toBeInstanceOf(Error);
		expect((causes[0] as Error).message).toContain("no API key");
		expect(causes[1]).toBe(transport);
	}));

	it("retains account cooldown as a permanent cause alongside a later outage", () => withChain(async judge => {
		const rejected = Object.assign(new Error("account"), { status: 402 });
		const transport = Object.assign(new Error("transport"), { code: "ECONNRESET" });
		let next = 0;
		await failure(judge.withCandidate(async () => { throw next++ === 0 ? rejected : transport; }));
		const attempt = vi.fn(async () => { throw transport; });
		const error = await failure(judge.withCandidate(attempt));
		expect(attempt).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(AggregateError);
		const causes: unknown[] = (error as AggregateError).errors;
		expect(causes).toHaveLength(2);
		expect((causes[0] as Error).message).toContain("rejected the account recently");
		expect(causes[1]).toBe(transport);
	}));

	it("does not erase a permanent failure when the next candidate times out", () => withChain(async judge => {
		const causes = [Object.assign(new Error("request"), { status: 400 }), Object.assign(new Error("deadline"), { name: "TimeoutError" })];
		let next = 0;
		const error = await failure(judge.withCandidate(async () => { throw causes[next++]; }));
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual(causes);
	}));

	it("propagates caller cancellation without aggregating it or attempting another candidate", () => withChain(async judge => {
		const controller = new AbortController();
		const reason = new Error("caller cancellation");
		const attempt = vi.fn(async () => { controller.abort(reason); throw reason; });
		expect(await failure(judge.withCandidate(attempt, { signal: controller.signal }))).toBe(reason);
		expect(attempt).toHaveBeenCalledTimes(1);
	}));
});
