import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	grokbotMetadataHeaders,
	grokbotInferenceContextHeaders,
	takeGrokbotInferenceAuthenticationJwt,
} from "../src/providers/grokbot/inference-auth";

function fixtureJwt(exp = Math.floor(Date.now() / 1000) + 60): string {
	return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ exp, jti: crypto.randomUUID() })).toString("base64url")}.fixture`;
}

describe("Grokbot optional workload authorization", () => {
	test("workload header injection is rejected before transport", () => {
		expect(() =>
			grokbotInferenceContextHeaders({ workload: "bad\r\nheader", jobId: "fixture-job", user: "fixture-user" }),
		).toThrow("Invalid Grok Bot inference workload context");
	});
	test("a supplier is reevaluated without imposing an unsupported single-use rule", async () => {
		const tokens = [fixtureJwt(), fixtureJwt()];
		let index = 0;
		const options = { grokbotInferenceAuthenticationJwt: () => tokens[index++]! };
		expect(await takeGrokbotInferenceAuthenticationJwt(options, {}, {})).toBe(tokens[0]);
		expect(await takeGrokbotInferenceAuthenticationJwt(options, {}, {})).toBe(tokens[1]);
		expect(
			await takeGrokbotInferenceAuthenticationJwt({ grokbotInferenceAuthenticationJwt: tokens[0] }, {}, {}),
		).toBe(tokens[0]);
	});
	test("an issuer-provided environment token is not consumed or mutated by resolution", async () => {
		const env = { INFERENCE_PROXY_JWT: fixtureJwt() };
		expect(await takeGrokbotInferenceAuthenticationJwt({}, {}, env)).toBe(env.INFERENCE_PROXY_JWT);
		expect(await takeGrokbotInferenceAuthenticationJwt({}, {}, env)).toBe(env.INFERENCE_PROXY_JWT);
	});
	test("explicit supplier wins over ambient launcher tokens without consuming the ambient token", async () => {
		const ambient = fixtureJwt();
		const explicit = fixtureJwt();
		expect(
			await takeGrokbotInferenceAuthenticationJwt(
				{ grokbotInferenceAuthenticationJwt: () => explicit },
				{},
				{ INFERENCE_PROXY_JWT: ambient },
			),
		).toBe(explicit);
		expect(await takeGrokbotInferenceAuthenticationJwt({}, {}, { INFERENCE_PROXY_JWT: ambient })).toBe(ambient);
	});
	test("a one-shot secret file is claimed by exactly one concurrent request and removed", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-attestation-"));
		try {
			const file = path.join(dir, "attestation");
			const jwt = fixtureJwt();
			await Bun.write(file, jwt);
			const options = { grokbotInferenceAuthenticationJwtFile: file };
			const outcomes = await Promise.allSettled([
				takeGrokbotInferenceAuthenticationJwt(options, {}, {}),
				takeGrokbotInferenceAuthenticationJwt(options, {}, {}),
			]);
			expect(outcomes.filter(r => r.status === "fulfilled")).toEqual([{ status: "fulfilled", value: jwt }]);
			expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
			expect(await fs.readdir(dir)).toEqual([]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	test("attestation is stripped from metadata headers case-insensitively while proxy headers survive", () => {
		expect(
			grokbotMetadataHeaders(
				{ "X-Inference-Authentication-Jwt": "fixture", "x-tenant": "one" },
				{ "x-inference-authentication-jwt": "other", "x-tenant": "two" },
			),
		).toEqual({ "x-tenant": "two" });
	});
	test("expired tokens and header injection fail without revealing token contents", async () => {
		await expect(
			takeGrokbotInferenceAuthenticationJwt({ grokbotInferenceAuthenticationJwt: fixtureJwt(1) }, {}, {}),
		).rejects.toThrow("expired");
		await expect(
			takeGrokbotInferenceAuthenticationJwt({ grokbotInferenceAuthenticationJwt: "fixture\r\nheader" }, {}, {}),
		).rejects.toThrow("Invalid Grok Bot inference attestation token");
	});
});
