import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { __resetVertexTokenCache } from "../src/providers/google-auth";
import { stream } from "../src/stream";
import type { Api, DispatchHold, FetchImpl, OptionsForApi } from "../src/types";

/**
 * Round 3 of the PR #17399 review (R3-5) found Bedrock signing a request
 * before the transport's dispatch hold, so a request parked by `/pause` went
 * out on resume with a signature too old to accept. Vertex had the same
 * shape: its access token was minted before the hold, and a token that
 * expired during the pause was still on the request when it left. Every
 * Vertex route — Gemini, and the OpenAI and Anthropic routes stream dispatch
 * authenticates — must take its token where the request leaves: after the
 * holds open.
 */

const MINTED = new Date("2026-10-30T10:00:00Z");
const RESUMED = new Date("2026-10-30T10:10:00Z");
/** Shorter than the pause, so the token minted before it has expired at resume. */
const TOKEN_LIFETIME_S = 120;

const ENV_KEYS = [
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_ACCESS_TOKEN",
	"CLOUDSDK_AUTH_ACCESS_TOKEN",
	"GOOGLE_CLOUD_PROJECT",
	"GCP_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_VERTEX_LOCATION",
	"GOOGLE_CLOUD_LOCATION",
	"VERTEX_LOCATION",
] as const;

const realSetImmediate = globalThis.setImmediate;

/** Lets every pending async chain run to its next I/O wait. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}

/**
 * Lets the async chains run until `ready` holds. A cold provider module load
 * takes real time that `settle` alone does not wait out.
 */
async function settleUntil(ready: () => boolean): Promise<void> {
	const deadline = Bun.nanoseconds() + 5e9;
	while (!ready() && Bun.nanoseconds() < deadline) await settle();
	expect(ready()).toBe(true);
}

/** `/pause`: closed, its hold parks until reopened, and its probe says so. */
function pauseGate() {
	let closed = false;
	let reopened = Promise.withResolvers<void>();
	const hold: DispatchHold = () => (closed ? reopened.promise : undefined);
	hold.isClosed = () => closed;
	return {
		hold,
		close() {
			if (closed) return;
			closed = true;
			reopened = Promise.withResolvers<void>();
		},
		open() {
			closed = false;
			reopened.resolve();
		},
		get closed() {
			return closed;
		},
	};
}

/** `token-minted-HHMM`, named after the moment the token endpoint answered. */
function tokenName(): string {
	const now = new Date();
	return `token-minted-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
}

const common = {
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
};

const ROUTES = [
	{
		name: "Gemini",
		model: buildModel({
			...common,
			id: "gemini-2.5-flash",
			name: "Vertex Gemini",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://us-central1-aiplatform.googleapis.com",
		}),
		options: { project: "p", location: "us-central1" },
	},
	{
		name: "OpenAI",
		model: buildModel({
			...common,
			id: "gemini-2.5-flash",
			name: "Vertex OpenAI",
			api: "openai-completions",
			provider: "google-vertex",
			baseUrl:
				"https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/us-central1/endpoints/openapi",
		}),
		options: { apiKey: "vertex-adc" },
	},
	{
		name: "Anthropic",
		model: buildModel({
			...common,
			id: "claude-sonnet-4-5",
			name: "Vertex Anthropic",
			api: "anthropic-messages",
			provider: "google-vertex",
			baseUrl:
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-5:rawPredict",
		}),
		options: { apiKey: "vertex-adc" },
	},
] as const;

describe("Vertex takes its access token where a held request leaves", () => {
	let tmpDir: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, Bun.env[key]]));
		for (const key of ENV_KEYS) delete Bun.env[key];
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vertex-pause-"));
		const adcPath = path.join(tmpDir, "adc.json");
		await Bun.write(
			adcPath,
			JSON.stringify({
				type: "authorized_user",
				client_id: "pause-fixture",
				client_secret: "not-a-secret",
				refresh_token: "not-a-token",
			}),
		);
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
		__resetVertexTokenCache();
	});

	afterEach(async () => {
		setSystemTime();
		__resetVertexTokenCache();
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	for (const route of ROUTES) {
		it(`${route.name}: a pause that outlasts the token puts a token minted after it on the wire`, async () => {
			setSystemTime(MINTED);
			const pause = pauseGate();
			const minted: string[] = [];
			const wire: { authorization: string | null; paused: boolean }[] = [];
			const fetch: FetchImpl = async (input, init) => {
				if (String(input).includes("oauth2.googleapis.com/token")) {
					const token = tokenName();
					minted.push(token);
					// `/pause` engages while the first token is being minted.
					if (minted.length === 1) pause.close();
					return Response.json({ access_token: token, expires_in: TOKEN_LIFETIME_S, token_type: "Bearer" });
				}
				wire.push({ authorization: new Headers(init?.headers).get("authorization"), paused: pause.closed });
				return new Response("fixture terminal response", { status: 400 });
			};
			const result = stream(route.model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
				...route.options,
				beforeDispatch: pause.hold,
				fetch,
			} as OptionsForApi<Api>).result();

			await settleUntil(() => minted.length > 0);
			await settle();
			expect(minted).toEqual(["token-minted-1000"]);
			expect(wire).toEqual([]);
			setSystemTime(RESUMED);
			pause.open();
			await result;

			expect(wire).toEqual([{ authorization: "Bearer token-minted-1010", paused: false }]);
		});
	}

	it("reuses a token that is still valid when the request leaves", async () => {
		setSystemTime(MINTED);
		const minted: string[] = [];
		const wire: (string | null)[] = [];
		const fetch: FetchImpl = async (input, init) => {
			if (String(input).includes("oauth2.googleapis.com/token")) {
				const token = tokenName();
				minted.push(token);
				return Response.json({ access_token: token, expires_in: 3600, token_type: "Bearer" });
			}
			wire.push(new Headers(init?.headers).get("authorization"));
			return new Response("fixture terminal response", { status: 400 });
		};
		for (const route of ROUTES) {
			await stream(route.model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
				...route.options,
				fetch,
			} as OptionsForApi<Api>).result();
		}

		expect(minted).toEqual(["token-minted-1000"]);
		expect(wire).toEqual(Array(ROUTES.length).fill("Bearer token-minted-1000"));
	});
});
