import { describe, expect, test, vi } from "bun:test";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createExactSecurityOAuthResolver, createSecurityAuthResolver, selectSecurityAuth } from "../../src/security";
import type { AuthStorage } from "../../src/session/auth-storage";

function model() {
	const value = getBundledModel("openai-codex", "gpt-5.6-sol");
	if (!value) throw new Error("Expected bundled Codex model");
	return value;
}

describe("exact security OAuth resolver", () => {
	test("selects an explicit credential without account rotation", () => {
		const listOAuthAccounts = vi.fn(() => [
			{ credentialId: 11, position: 0, active: true, accountId: "workspace-a" },
			{ credentialId: 42, position: 1, active: false, accountId: "workspace-b" },
		]);
		const selected = selectSecurityAuth(
			{ oauth: { accounts: listOAuthAccounts } } as unknown as AuthStorage,
			model(),
			42,
			"session-a",
		);
		expect(selected).toEqual({ provider: "openai-codex", credentialId: 42, accountId: "workspace-b" });
		expect(listOAuthAccounts).toHaveBeenCalledWith("openai-codex", "session-a");
	});

	test("plans provider-owned authentication for recognized Bedrock routes without OAuth", () => {
		const authStorage = { oauth: { accounts: vi.fn(() => []) } } as unknown as AuthStorage;
		for (const [provider, modelId, api] of [
			["amazon-bedrock", "us.anthropic.claude-opus-4-8", "bedrock-converse-stream"],
			["bedrock-mantle", "openai.gpt-5.6-terra", "openai-responses"],
		] as const) {
			const bedrockModel = getBundledModel(provider, modelId);
			if (!bedrockModel) throw new Error(`Expected bundled model ${provider}/${modelId}`);
			expect(selectSecurityAuth(authStorage, bedrockModel)).toEqual({ provider, api });
		}
	});

	test("rejects unsupported provider-owned authentication routes", () => {
		const authStorage = { oauth: { accounts: vi.fn(() => []) } } as unknown as AuthStorage;
		expect(() => selectSecurityAuth(authStorage, { provider: "openai", api: "openai-responses" })).toThrow(
			"require a stored OAuth account",
		);
		expect(() => selectSecurityAuth(authStorage, { provider: "amazon-bedrock", api: "openai-responses" })).toThrow(
			"do not support provider authentication",
		);
	});

	test("provider-owned resolver stays within the pinned provider and API", () => {
		const bedrockModel = getBundledModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		const mantleModel = getBundledModel("bedrock-mantle", "openai.gpt-5.6-terra");
		if (!bedrockModel || !mantleModel) throw new Error("Expected bundled Bedrock models");
		const providerResolver = vi.fn(() => "provider-owned");
		const resolver = createSecurityAuthResolver({
			authStorage: {} as unknown as AuthStorage,
			auth: { provider: bedrockModel.provider, api: bedrockModel.api },
			providerResolver,
		});
		expect(resolver(bedrockModel)).toBe("provider-owned");
		expect(() => resolver(mantleModel)).toThrow("provider mismatch");
		expect(() => resolver({ ...bedrockModel, api: "openai-responses" })).toThrow("API mismatch");
		expect(providerResolver).toHaveBeenCalledTimes(1);
	});

	test("resolves and refreshes only the pinned durable row", async () => {
		const getOAuthAccessByCredentialId = vi.fn(async (_provider, credentialId, options) => ({
			ok: true as const,
			accessToken: options?.forceRefresh ? "refreshed" : "initial",
			credentialId,
			accountId: "workspace-a",
		}));
		const authStorage = { oauth: { accessById: getOAuthAccessByCredentialId } } as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
		});
		const apiKey = resolver(model());
		expect(typeof apiKey).toBe("function");
		const exact = apiKey as ApiKeyResolver;
		expect(await exact({ lastChance: false, error: undefined })).toBe("initial");
		expect(await exact({ lastChance: false, error: new Error("401") })).toBe("refreshed");
		expect(await exact({ lastChance: true, error: new Error("401") })).toBeUndefined();
		expect(getOAuthAccessByCredentialId.mock.calls.map(call => call[1])).toEqual([42, 42]);
	});

	test("rejects a model whose provider crosses the pinned OAuth boundary", async () => {
		const getOAuthAccessByCredentialId = vi.fn(async () => ({
			ok: true as const,
			accessToken: "must-not-be-requested",
			credentialId: 42,
			accountId: "workspace-a",
		}));
		const authStorage = { oauth: { accessById: getOAuthAccessByCredentialId } } as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
		});
		const wrongProviderModel = { ...model(), provider: "anthropic" } as unknown as Parameters<typeof resolver>[0];
		expect(() => resolver(wrongProviderModel)).toThrow("provider mismatch");
		expect(getOAuthAccessByCredentialId).not.toHaveBeenCalled();
	});

	test("fails closed when any durable account identity changes", async () => {
		const account = {
			provider: "openai-codex",
			credentialId: 42,
			accountId: "workspace-a",
			email: "owner@example.com",
			organizationId: "org-a",
			organizationName: "Workspace A",
		};
		const resolved = {
			credentialId: 42,
			accountId: "workspace-a",
			email: "owner@example.com",
			orgId: "org-a",
			orgName: "Workspace A",
		};
		for (const mismatch of [
			{ credentialId: 99 },
			{ accountId: "workspace-b" },
			{ email: "other@example.com" },
			{ orgId: "org-b" },
			{ orgName: "Workspace B" },
		]) {
			const authStorage = {
				oauth: {
					accessById: async () => ({
						ok: true as const,
						accessToken: "token",
						...resolved,
						...mismatch,
					}),
				},
			} as unknown as AuthStorage;
			const resolver = createExactSecurityOAuthResolver({ authStorage, account });
			const exact = resolver(model()) as ApiKeyResolver;
			await expect(exact({ lastChance: false, error: undefined })).rejects.toThrow("identity mismatch");
		}
	});

	test("fails closed when the refreshed row loses its workspace identity", async () => {
		const authStorage = {
			oauth: {
				accessById: async () => ({
					ok: true as const,
					accessToken: "token",
					credentialId: 42,
					accountId: undefined,
				}),
			},
		} as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
		});
		const exact = resolver(model()) as ApiKeyResolver;
		let caught: unknown;
		try {
			await exact({ lastChance: false, error: undefined });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		if (!(caught instanceof Error)) throw new Error("expected identity mismatch");
		expect(caught.message).toContain("identity mismatch");
		expect(caught.message).not.toContain("workspace-a");
		expect(caught.message).not.toContain("undefined");
	});
});
