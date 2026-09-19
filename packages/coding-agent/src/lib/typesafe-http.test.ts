import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { systemOne, TypeSafeApiError, withTypeSafeRequestTimeout } from "./typesafe-http";

const ENV_KEYS = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL"] as const;

let savedEnv: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof spyOn>;

function okResponse(): Response {
	return new Response(
		JSON.stringify({
			model: "jev-1.13.0",
			answers: { goal_met: { type: "noul", noul: 0.91 } },
			usage: { input_tokens: 120, output_tokens: 4 },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
	fetchSpy.mockRestore();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("systemOne", () => {
	it("posts state, model, and questions with bearer auth", async () => {
		process.env.TYPESAFE_API_KEY = "ts-key";
		fetchSpy.mockImplementation(() => Promise.resolve(okResponse()));

		const result = await systemOne(
			{ page: "checkout complete" },
			{ goal_met: { type: "noul", instructions: "Did the checkout succeed?" } },
		);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ts-key");
		const body = JSON.parse(init.body as string) as {
			state: unknown;
			model: string;
			questions: Record<string, { type: string }>;
		};
		expect(body.model).toBe("jev-1.13.0");
		expect(body.questions.goal_met.type).toBe("noul");
		expect(result.answers.goal_met).toEqual({ type: "noul", noul: 0.91 });
	});

	it("throws without calling fetch when TYPESAFE_API_KEY is unset", async () => {
		await expect(systemOne("state", {})).rejects.toThrow("TYPESAFE_API_KEY");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not retry non-retryable statuses", async () => {
		process.env.TYPESAFE_API_KEY = "ts-key";
		fetchSpy.mockImplementation(() => Promise.resolve(new Response("bad request", { status: 422 })));

		const failure = systemOne("state", {});
		await expect(failure).rejects.toBeInstanceOf(TypeSafeApiError);
		await expect(failure).rejects.toMatchObject({ status: 422, retryable: false });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("retries 529 overload then returns the response", async () => {
		process.env.TYPESAFE_API_KEY = "ts-key";
		fetchSpy
			.mockImplementationOnce(() => Promise.resolve(new Response("overloaded", { status: 529 })))
			.mockImplementation(() => Promise.resolve(okResponse()));

		const result = await systemOne("state", {});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(result.answers.goal_met).toEqual({ type: "noul", noul: 0.91 });
	});
});

describe("withTypeSafeRequestTimeout", () => {
	it("aborts a stalled request with a timeout error", async () => {
		const stalled = (signal: AbortSignal): Promise<Response> => {
			const { promise, reject } = Promise.withResolvers<Response>();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		};

		await expect(withTypeSafeRequestTimeout(undefined, 10, stalled)).rejects.toThrow("timed out");
	});
});
