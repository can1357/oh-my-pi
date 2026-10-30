import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clearAwsCredentialCache } from "../src/providers/aws-credentials";
import { stream } from "../src/stream";
import type { Api, Context, DispatchHold, FetchImpl, Model, OptionsForApi } from "../src/types";
import { fetchAuthorizedAtWire, transportFetch, type WireAuthorization } from "../src/utils/transport-fetch";
import { withEnv } from "./helpers";

/**
 * Round 3 of the PR #17399 review (R3-5): Bedrock signed each request with
 * SigV4 before the transport's dispatch hold, so a request parked by `/pause`
 * went out on resume carrying the time it was signed. AWS rejects a signature
 * more than five minutes old, so any longer pause failed the resumed request
 * with `Signature expired`. The request must be signed where it leaves: after
 * the holds open, on every attempt.
 */

const BEFORE_PAUSE = new Date("2026-10-30T10:00:00Z");
const AFTER_PAUSE = new Date("2026-10-30T10:10:00Z");

const CLEAN_AWS_ENV: Record<string, string | undefined> = {
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_SESSION_TOKEN: undefined,
	AWS_PROFILE: undefined,
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_BEDROCK_SKIP_AUTH: undefined,
	AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
	AWS_ROLE_ARN: undefined,
	AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
	AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
	AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
	AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
	AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/bedrock-pause-signature/credentials",
	AWS_CONFIG_FILE: "/nonexistent/bedrock-pause-signature/config",
	AWS_EC2_METADATA_DISABLED: "true",
	AWS_REGION: "us-east-1",
	AWS_DEFAULT_REGION: undefined,
};

const STATIC_CREDENTIALS = {
	...CLEAN_AWS_ENV,
	AWS_ACCESS_KEY_ID: "AKIDSTATIC",
	AWS_SECRET_ACCESS_KEY: "static-secret",
};

const CONTAINER_CREDENTIALS_URL = "http://127.0.0.1:9911/credentials";

const common = {
	name: "pause signature fixture",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
};

const converseModel = buildModel({
	...common,
	id: "amazon.nova-lite-v1:0",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
});

const mantleModel = buildModel({
	...common,
	id: "openai.gpt-5.6-sol",
	api: "openai-responses",
	provider: "bedrock-mantle",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const realSetImmediate = globalThis.setImmediate;

/** Lets every pending async chain run to its next I/O wait. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}

/** `/pause` engaged after the first `passes` holds: every later hold parks until `release`. */
function pauseAfter(passes: number) {
	let calls = 0;
	let open = false;
	const parked = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	return {
		hold: (): Promise<void> | undefined => {
			calls++;
			if (open || calls <= passes) return undefined;
			parked.resolve();
			return gate.promise;
		},
		parked: parked.promise,
		release: () => {
			open = true;
			gate.resolve();
		},
	};
}

interface WireRequest {
	amzDate: string | null;
	authorization: string | null;
	securityToken: string | null;
}

/** Records every request that reaches the inference host and answers it with `respond`. */
function recordingFetch(wire: WireRequest[], respond: (attempt: number) => Response, credentials?: () => Response) {
	const fetch: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === CONTAINER_CREDENTIALS_URL && credentials) return credentials();
		const headers = new Headers(init?.headers);
		wire.push({
			amzDate: headers.get("x-amz-date"),
			authorization: headers.get("authorization"),
			securityToken: headers.get("x-amz-security-token"),
		});
		return respond(wire.length);
	};
	return fetch;
}

const terminal = () => new Response("fixture terminal response", { status: 400 });

afterEach(() => {
	setSystemTime();
	clearAwsCredentialCache();
});

describe("Bedrock signs a held request when it leaves", () => {
	it("Converse: a pause longer than a signature's lifetime puts a current signature on the wire", async () => {
		await withEnv(STATIC_CREDENTIALS, async () => {
			clearAwsCredentialCache();
			setSystemTime(BEFORE_PAUSE);
			const pause = pauseAfter(1);
			const wire: WireRequest[] = [];
			const result = stream(converseModel, context, {
				beforeDispatch: pause.hold,
				fetch: recordingFetch(wire, terminal),
			} as OptionsForApi<Api>).result();

			await pause.parked;
			await settle();
			expect(wire).toEqual([]);
			setSystemTime(AFTER_PAUSE);
			pause.release();
			await result;

			expect(wire.map(request => request.amzDate)).toEqual(["20261030T101000Z"]);
			expect(wire[0]?.authorization).toStartWith(
				"AWS4-HMAC-SHA256 Credential=AKIDSTATIC/20261030/us-east-1/bedrock/aws4_request,",
			);
		});
	});

	it("Converse: temporary credentials that expire during the pause are looked up again", async () => {
		await withEnv({ ...CLEAN_AWS_ENV, AWS_CONTAINER_CREDENTIALS_FULL_URI: CONTAINER_CREDENTIALS_URL }, async () => {
			clearAwsCredentialCache();
			setSystemTime(BEFORE_PAUSE);
			const pause = pauseAfter(1);
			const wire: WireRequest[] = [];
			let lookups = 0;
			const credentials = () => {
				lookups++;
				return Response.json({
					AccessKeyId: `AKIDLOOKUP${lookups}`,
					SecretAccessKey: `secret-${lookups}`,
					Token: `session-${lookups}`,
					// Valid for three minutes: the pause outlasts them.
					Expiration: new Date(Date.now() + 3 * 60_000).toISOString(),
				});
			};
			const result = stream(converseModel, context, {
				beforeDispatch: pause.hold,
				fetch: recordingFetch(wire, terminal, credentials),
			} as OptionsForApi<Api>).result();

			await pause.parked;
			await settle();
			expect(lookups).toBe(1);
			setSystemTime(AFTER_PAUSE);
			pause.release();
			await result;

			expect(lookups).toBe(2);
			expect(wire).toHaveLength(1);
			expect(wire[0]?.authorization).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDLOOKUP2/20261030/");
			expect(wire[0]?.securityToken).toBe("session-2");
		});
	});

	it("Converse: every retried attempt is signed for its own moment", async () => {
		await withEnv(STATIC_CREDENTIALS, async () => {
			clearAwsCredentialCache();
			setSystemTime(BEFORE_PAUSE);
			const wire: WireRequest[] = [];
			await stream(converseModel, context, {
				fetch: recordingFetch(wire, attempt => {
					if (attempt > 1) return terminal();
					// The retry goes out six minutes later, past the first signature's lifetime.
					setSystemTime(new Date(BEFORE_PAUSE.getTime() + 6 * 60_000));
					return new Response("throttled", { status: 503, headers: { "retry-after-ms": "0" } });
				}),
			} as OptionsForApi<Api>).result();

			expect(wire.map(request => request.amzDate)).toEqual(["20261030T100000Z", "20261030T100600Z"]);
		});
	});

	it("Mantle: a pause longer than a signature's lifetime puts a current signature on the wire", async () => {
		await withEnv(STATIC_CREDENTIALS, async () => {
			clearAwsCredentialCache();
			setSystemTime(BEFORE_PAUSE);
			const pause = pauseAfter(1);
			const wire: WireRequest[] = [];
			const result = stream(mantleModel, context, {
				beforeDispatch: pause.hold,
				fetch: recordingFetch(wire, terminal),
				maxTokens: 16,
			} as OptionsForApi<Api>).result();

			await pause.parked;
			await settle();
			expect(wire).toEqual([]);
			setSystemTime(AFTER_PAUSE);
			pause.release();
			await result;

			expect(wire.map(request => request.amzDate)).toEqual(["20261030T101000Z"]);
			expect(wire[0]?.authorization).toStartWith(
				"AWS4-HMAC-SHA256 Credential=AKIDSTATIC/20261030/us-east-1/bedrock-mantle/aws4_request,",
			);
		});
	});
});

describe("fetchAuthorizedAtWire", () => {
	const model: Model<Api> = buildModel({
		...common,
		id: "authorized-fixture",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid/v1",
	});

	it("authorizes again after a gate that closed while the request was being authorized", async () => {
		let closed = false;
		const gate = Promise.withResolvers<void>();
		const hold: DispatchHold = Object.assign(() => (closed ? gate.promise : undefined), { isClosed: () => closed });
		const wire: (string | null)[] = [];
		const fetchImpl = transportFetch(
			model,
			async (_input, init) => {
				wire.push(new Headers(init?.headers).get("x-signed"));
				return new Response("ok");
			},
			hold,
		);
		let signings = 0;
		const authorize: WireAuthorization = async init => {
			signings++;
			// The pause lands while the first signature is being made.
			if (signings === 1) closed = true;
			const headers = new Headers(init.headers);
			headers.set("x-signed", `signature ${signings}`);
			return { ...init, headers };
		};
		const sent = fetchAuthorizedAtWire(
			fetchImpl,
			"https://example.invalid/v1/responses",
			{ method: "POST" },
			authorize,
		);

		await settle();
		expect(signings).toBe(1);
		expect(wire).toEqual([]);
		closed = false;
		gate.resolve();
		await sent;

		expect(signings).toBe(2);
		expect(wire).toEqual(["signature 2"]);
	});

	it("authorizes just before the call through a fetch that holds nothing", async () => {
		const wire: (string | null)[] = [];
		const plain: FetchImpl = async (_input, init) => {
			wire.push(new Headers(init?.headers).get("x-signed"));
			return new Response("ok");
		};

		await fetchAuthorizedAtWire(plain, "https://example.invalid/v1/responses", { method: "POST" }, async init => ({
			...init,
			headers: { "x-signed": "signature 1" },
		}));

		expect(wire).toEqual(["signature 1"]);
	});
});
