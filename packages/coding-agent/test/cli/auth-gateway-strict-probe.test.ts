import { afterEach, describe, expect, test, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { CompletionProbeInput, Provider } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as catalogModels from "@oh-my-pi/pi-catalog/models";
import { decodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro";
import { createStrictCompletionProbe } from "../../src/cli/auth-gateway-cli";
import { Settings } from "../../src/config/settings";

afterEach(() => {
	vi.restoreAllMocks();
});

function oauthProbeInput(provider: Provider): CompletionProbeInput {
	return {
		provider,
		credentialId: 1,
		credential: {
			type: "oauth",
			accessToken: "access-token",
			refreshToken: "refresh-token",
			expiresAt: 1_900_000_000_000,
			projectId: "project-1",
		},
		signal: new AbortController().signal,
	};
}

/** Runs one strict probe and returns the apiKey the chat request received. */
async function probeApiKey(provider: Provider): Promise<string | undefined> {
	const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: [{ type: "text", text: "pong" }],
	} as never);
	const result = await createStrictCompletionProbe(Settings.isolated())(oauthProbeInput(provider));
	expect(result.ok).toBe(true);
	const apiKey = complete.mock.calls[0]?.[2]?.apiKey;
	return typeof apiKey === "string" ? apiKey : undefined;
}

describe("auth-gateway check --strict completion probe", () => {
	test("sends the structured credential blob for a structured-format OAuth provider", async () => {
		const apiKey = await probeApiKey("alibaba-coding-plan" as Provider);
		expect(JSON.parse(apiKey ?? "")).toMatchObject({ token: "access-token", projectId: "project-1" });
	});

	test("sends the raw access token for a bearer-format OAuth provider", async () => {
		expect(await probeApiKey("anthropic" as Provider)).toBe("access-token");
	});

	test("probes a Kiro login with the key its requests send", async () => {
		const runtime = "https://runtime.us-east-1.kiro.dev/";
		const model = buildModel({
			id: "auto",
			name: "Auto",
			api: "kiro-api",
			provider: "kiro",
			baseUrl: runtime,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_000,
		});
		// Kiro's roster is discovered per account, never bundled; give the probe a model to try.
		vi.spyOn(catalogModels, "getBundledModels").mockImplementation((() => [model]) as never);
		const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "pong" }],
		} as never);
		const storage = await AuthStorage.create(":memory:");
		try {
			await storage.credentials.set("kiro", {
				type: "oauth",
				access: "kiro-access",
				refresh: "kiro-refresh",
				expires: Date.now() + 3_600_000,
				region: "us-east-1",
				accountId: "login-a",
			});
			const [result] = await storage.health.check({
				completionProbe: createStrictCompletionProbe(Settings.isolated()),
			});
			expect(result?.completion?.ok).toBe(true);
			const apiKey = complete.mock.calls[0]?.[2]?.apiKey;
			expect(decodeKiroCredential(typeof apiKey === "string" ? apiKey : "", {})).toEqual({
				kind: "oauth",
				token: "kiro-access",
				region: "us-east-1",
				loginId: "login-a",
			});
		} finally {
			storage.close();
		}
	});
});

describe("auth-gateway check --strict with disabledModels", () => {
	test("never probes a denied model, and skips the probe when every candidate is denied", async () => {
		const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "pong" }],
		} as never);
		const allDenied = await createStrictCompletionProbe(Settings.isolated({ disabledModels: ["anthropic/*"] }))(
			oauthProbeInput("anthropic" as Provider),
		);
		expect(allDenied.ok).toBeNull();
		expect(complete).not.toHaveBeenCalled();

		// With no rules the probe stops at its first candidate; deny exactly that one.
		await createStrictCompletionProbe(Settings.isolated())(oauthProbeInput("anthropic" as Provider));
		const first = complete.mock.calls[0]?.[0] as { provider: string; id: string };
		complete.mockClear();
		const rule = `${first.provider}/${first.id}`;
		const partial = await createStrictCompletionProbe(Settings.isolated({ disabledModels: [rule] }))(
			oauthProbeInput("anthropic" as Provider),
		);
		expect(partial.ok).toBe(true);
		const probed = complete.mock.calls.map(call => {
			const model = call[0] as { provider: string; id: string };
			return `${model.provider}/${model.id}`;
		});
		expect(probed.length).toBeGreaterThan(0);
		expect(probed).not.toContain(rule);
	});
});
