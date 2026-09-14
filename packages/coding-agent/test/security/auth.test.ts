import { describe, expect, test, vi } from "bun:test";
import { AUTHENTICATED_SENTINEL, type Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	createExactSecurityOAuthResolver,
	createProviderNativeSecurityResolver,
	selectSecurityAccount,
	selectSecurityAccountForModel,
} from "../../src/security";
import type { AuthStorage } from "../../src/session/auth-storage";

function model() {
	const value = getBundledModel("openai-codex", "gpt-5.6-sol");
	if (!value) throw new Error("Expected bundled Codex model");
	return value;
}

function bedrockModel(): Model {
	return {
		...model(),
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	} as Model;
}

describe("exact security OAuth resolver", () => {
	test("selects an explicit credential without account rotation", () => {
		const listOAuthAccounts = vi.fn(() => [
			{ credentialId: 11, position: 0, active: true, accountId: "workspace-a" },
			{ credentialId: 42, position: 1, active: false, accountId: "workspace-b" },
		]);
		const selected = selectSecurityAccount(
			{ listOAuthAccounts } as unknown as AuthStorage,
			"openai-codex",
			42,
			"session-a",
		);
		expect(selected).toEqual({
			provider: "openai-codex",
			authMode: "oauth",
			credentialId: 42,
			accountId: "workspace-b",
		});
		expect(listOAuthAccounts).toHaveBeenCalledWith("openai-codex", "session-a");
	});

	test("resolves and refreshes only the pinned durable row", async () => {
		const getOAuthAccessByCredentialId = vi.fn(async (_provider, credentialId, options) => ({
			ok: true as const,
			accessToken: options?.forceRefresh ? "refreshed" : "initial",
			credentialId,
			accountId: "workspace-a",
		}));
		const authStorage = { getOAuthAccessByCredentialId } as unknown as AuthStorage;
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

	test("selects the upstream Bedrock provider-native mode without an OAuth row", async () => {
		const selected = await selectSecurityAccountForModel({
			authStorage: { listOAuthAccounts: vi.fn(() => []) } as unknown as AuthStorage,
			model: bedrockModel(),
			resolveApiKey: async () => AUTHENTICATED_SENTINEL,
		});
		expect(selected).toEqual({
			provider: "amazon-bedrock",
			authMode: "provider-native",
			credentialSource: "aws",
		});
	});

	test("rejects an unsupported provider without a pinned OAuth account", () => {
		expect(() =>
			selectSecurityAccount({ listOAuthAccounts: vi.fn(() => []) } as unknown as AuthStorage, "unsupported"),
		).toThrow("stored OAuth account");
	});

	test("keeps provider-native resolution on the pinned Bedrock provider", async () => {
		const resolve = vi.fn(async () => "resolved");
		const apiKeyResolver = vi.fn(() => resolve);
		const resolver = createProviderNativeSecurityResolver({
			modelRegistry: { resolver: apiKeyResolver },
			account: { provider: "amazon-bedrock", authMode: "provider-native", credentialSource: "aws" },
			sessionId: "security-session",
		});
		const returned = resolver(bedrockModel());
		expect(returned).toBe(resolve);
		expect(apiKeyResolver).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "amazon-bedrock" }),
			"security-session",
		);
		const wrongProviderModel = { ...bedrockModel(), provider: "anthropic" } as unknown as Parameters<
			typeof resolver
		>[0];
		expect(() => resolver(wrongProviderModel)).toThrow("provider mismatch");
	});

	test("rejects a model whose provider crosses the pinned OAuth boundary", async () => {
		const getOAuthAccessByCredentialId = vi.fn(async () => ({
			ok: true as const,
			accessToken: "must-not-be-requested",
			credentialId: 42,
			accountId: "workspace-a",
		}));
		const authStorage = { getOAuthAccessByCredentialId } as unknown as AuthStorage;
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
				getOAuthAccessByCredentialId: async () => ({
					ok: true as const,
					accessToken: "token",
					...resolved,
					...mismatch,
				}),
			} as unknown as AuthStorage;
			const resolver = createExactSecurityOAuthResolver({ authStorage, account });
			const exact = resolver(model()) as ApiKeyResolver;
			await expect(exact({ lastChance: false, error: undefined })).rejects.toThrow("identity mismatch");
		}
	});

	test("fails closed when the refreshed row loses its workspace identity", async () => {
		const authStorage = {
			getOAuthAccessByCredentialId: async () => ({
				ok: true as const,
				accessToken: "token",
				credentialId: 42,
				accountId: undefined,
			}),
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
