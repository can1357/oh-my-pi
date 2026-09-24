import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAuthStorage, loadAuthAccountPolicyConfig, resolveAuthBrokerConfig } from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthAccountPolicies,
	DEFAULT_HOT_WINDOW_FRACTION,
	DEFAULT_USAGE_RESERVE_PCT,
} from "@oh-my-pi/pi-ai/auth-storage";
import { writeAuthBrokerSnapshotCache } from "@oh-my-pi/pi-ai/auth-broker/snapshot-cache";
import type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker/types";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_AUTH_BROKER_ENV = {
	OMP_AUTH_BROKER_URL: undefined,
	OMP_AUTH_BROKER_TOKEN: undefined,
	OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: undefined,
} as const;

describe("resolveAuthBrokerConfig config discovery", () => {
	let agentDir = "";

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-broker-config-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (agentDir) {
			await removeWithRetries(agentDir);
			agentDir = "";
		}
	});

	test("resolves broker URL and token from config.yaml when config.yml is absent", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yaml-broker.example/v1",
				token: "yaml-token",
			});
		});
	});

	test("prefers config.yml over config.yaml when both exist", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: https://yml-broker.example/v1\nauth.broker.token: yml-token\n",
		);

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yml-broker.example/v1",
				token: "yml-token",
			});
		});
	});

	test("loads account policy config with the configured or default global reserve", async () => {
		const accountPolicies = [
			{
				provider: "anthropic",
				account: { email: "policy@example.com" },
				reservePct: 25,
			},
		] satisfies AuthAccountPolicies;
		await Bun.write(
			path.join(agentDir, "config.yml"),
			["auth:", `  accountPolicies: ${JSON.stringify(accountPolicies)}`, "retry:", "  usageReservePct: 17", ""].join(
				"\n",
			),
		);

		await expect(loadAuthAccountPolicyConfig({ agentDir })).resolves.toEqual({
			accountPolicies,
			defaultReservePct: 17,
			hotWindowFraction: DEFAULT_HOT_WINDOW_FRACTION,
		});

		await Bun.write(path.join(agentDir, "config.yml"), "auth: {}\n");
		await expect(loadAuthAccountPolicyConfig({ agentDir })).resolves.toEqual({
			accountPolicies: [],
			defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
			hotWindowFraction: DEFAULT_HOT_WINDOW_FRACTION,
		});
	});
	test("parses per-account hotWindowFraction override", async () => {
		const accountPolicies: AuthAccountPolicies = [
			{
				provider: "anthropic",
				account: { email: "worker@example.com" },
				hotWindowFraction: 1.0,
			},
		];
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`auth:\n  accountPolicies: ${JSON.stringify(accountPolicies)}\n`,
		);
		await expect(loadAuthAccountPolicyConfig({ agentDir })).resolves.toEqual({
			accountPolicies,
			defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
			hotWindowFraction: DEFAULT_HOT_WINDOW_FRACTION,
		});
	});

	test("treats an empty or comment-only config.yml as no configuration", async () => {
		for (const content of ["", "# nothing configured yet\n"]) {
			await Bun.write(path.join(agentDir, "config.yml"), content);
			await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
				await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toBeNull();
				await expect(loadAuthAccountPolicyConfig({ agentDir })).resolves.toEqual({
					accountPolicies: [],
					defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
					hotWindowFraction: DEFAULT_HOT_WINDOW_FRACTION,
				});
			});
		}
	});

	test("strictly validates effective policy overrides without parsing superseded main-config values", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), ["auth:", "  accountPolicies: null", ""].join("\n"));
		const invalidPolicies = [
			{
				provider: "openai-codex",
				account: { email: "policy@example.com" },
				reservePercent: 25,
			},
		];

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			const storage = await discoverAuthStorage({
				agentDir,
				accountPolicies: [],
				authStorageOptions: { defaultReservePct: 17 },
			});
			storage.close();

			await expect(
				discoverAuthStorage({
					agentDir,
					accountPolicies: invalidPolicies,
					authStorageOptions: { defaultReservePct: 17 },
				}),
			).rejects.toThrow("auth.accountPolicies[0] has unknown fields: reservePercent");
			await expect(
				discoverAuthStorage({
					agentDir,
					accountPolicies: [],
					authStorageOptions: { defaultReservePct: Number.NaN },
				}),
			).rejects.toThrow("retry.usageReservePct must be a finite number");
		});
	});

	test("applies selector-list account priority from config.yml during credential selection", async () => {
		const accountPolicies = [
			{
				provider: "openai-codex",
				account: { email: "preferred@example.com", accountId: "preferred" },
				priority: 100,
			},
			{
				provider: "openai-codex",
				account: { accountId: "fallback" },
				priority: 10,
			},
		] satisfies AuthAccountPolicies;
		await Bun.write(
			path.join(agentDir, "config.yml"),
			["auth:", `  accountPolicies: ${JSON.stringify(accountPolicies)}`, ""].join("\n"),
		);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"];
			return credential ? { apiKey: credential.access, newCredentials: credential } : null;
		});

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			const storage = await discoverAuthStorage({ agentDir });
			try {
				await storage.credentials.set("openai-codex", [
					{
						type: "oauth",
						access: "preferred-access",
						refresh: "preferred-refresh",
						expires: Date.now() + 60 * 60_000,
						accountId: "preferred",
						email: "preferred@example.com",
					},
					{
						type: "oauth",
						access: "fallback-access",
						refresh: "fallback-refresh",
						expires: Date.now() + 60 * 60_000,
						accountId: "fallback",
						email: "fallback@example.com",
					},
				]);

				const selected = await storage.oauth.access("openai-codex", "fresh-session");

				expect(selected?.email).toBe("preferred@example.com");
			} finally {
				storage.close();
			}
		});
	});

	test("strictly rejects malformed account policy config", async () => {
		const invalidConfigs = [
			{
				yaml: "auth: [",
				error: "contains invalid YAML",
			},
			{
				yaml: "[]\n",
				error: "must contain a YAML object",
			},
			{
				yaml: ["auth:", "  accountPolicies: null", ""].join("\n"),
				error: "auth.accountPolicies must be an array",
			},
			{
				yaml: ["auth:", "  accountPolicies:", "    openai-codex: {}", ""].join("\n"),
				error: "auth.accountPolicies must be an array",
			},
			{
				yaml: [
					"auth:",
					"  accountPolicies:",
					"    - provider: openai-codex",
					"      account:",
					"        orgId: org-only",
					"",
				].join("\n"),
				error: "auth.accountPolicies[0].account must include at least one of email, accountId, or projectId",
			},
			{
				yaml: [
					"auth:",
					"  accountPolicies:",
					"    - provider: openai-codex",
					"      account:",
					"        email: preferred@example.com",
					"        tenantId: unknown",
					"",
				].join("\n"),
				error: "auth.accountPolicies[0].account has unknown fields: tenantId",
			},
			{
				yaml: [
					"auth:",
					"  accountPolicies:",
					"    - provider: openai-codex",
					"      account:",
					"        email: preferred@example.com",
					"      reservePct: 101",
					"",
				].join("\n"),
				error: "auth.accountPolicies[0].reservePct must be between 0 and 100",
			},
			{
				yaml: [
					"auth:",
					"  accountPolicies:",
					'    - provider: " openai-codex"',
					"      account:",
					"        email: preferred@example.com",
					"",
				].join("\n"),
				error: "auth.accountPolicies[0].provider must not contain surrounding whitespace",
			},
			{
				yaml: ["retry:", "  usageReservePct: .inf", ""].join("\n"),
				error: "retry.usageReservePct must be a finite number",
			},
		] as const;

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			for (const { yaml, error } of invalidConfigs) {
				await Bun.write(path.join(agentDir, "config.yml"), yaml);
				await expect(loadAuthAccountPolicyConfig({ agentDir })).rejects.toThrow(error);
			}
		});
	});

	test("starts from a fresh snapshot cache while an unreachable broker revalidates in background", async () => {
		const token = "cached-token";
		const url = "http://127.0.0.1:1";
		const cachePath = path.join(agentDir, "snapshot.enc");
		const now = Date.now();
		const snapshot: SnapshotResponse = {
			generation: 3,
			generatedAt: now,
			serverNowMs: now,
			refresher: {
				enabled: true,
				intervalMs: 60_000,
				skewMs: 300_000,
				nextSweepInMs: 10_000,
			},
			credentials: [
				{
					id: 1,
					provider: "anthropic",
					credential: { type: "api_key", key: "cached-key" },
					identityKey: null,
					rotatesInMs: null,
				},
			],
		};
		await writeAuthBrokerSnapshotCache({ path: cachePath, token, url, snapshot });

		await withEnv(
			{
				...SUPPRESS_AUTH_BROKER_ENV,
				OMP_AUTH_BROKER_URL: url,
				OMP_AUTH_BROKER_TOKEN: token,
			},
			async () => {
				const storage = await discoverAuthStorage({ agentDir, cachePath });
				try {
					expect(storage.keys.source("anthropic") !== undefined).toBeTrue();
				} finally {
					storage.close();
				}
			},
		);
	});

	test("rejects unreadable or malformed account-pool files before connecting", async () => {
		const poolPath = path.join(agentDir, "account-pool.json");
		const brokerEnv = {
			...SUPPRESS_AUTH_BROKER_ENV,
			OMP_AUTH_BROKER_URL: "http://127.0.0.1:1",
			OMP_AUTH_BROKER_TOKEN: "test-token",
			OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: poolPath,
		} as const;

		await withEnv(brokerEnv, async () => {
			await expect(discoverAuthStorage({ agentDir })).rejects.toThrow(
				"Unable to read OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
			);

			const invalidFiles = [
				["[]", "must contain a JSON object"],
				['{"anthropic":"email:a@example.com"}', "must be an array of identity keys"],
				['{"anthropic":[42]}', "contains an invalid identity key"],
				['{" anthropic":["email:a@example.com"]}', "provider id with surrounding whitespace"],
				['{"anthropic":[" email:a@example.com"]}', "identity key with surrounding whitespace"],
			] as const;
			for (const [content, expectedError] of invalidFiles) {
				await Bun.write(poolPath, content);
				await expect(discoverAuthStorage({ agentDir })).rejects.toThrow(expectedError);
			}
		});
	});
});
