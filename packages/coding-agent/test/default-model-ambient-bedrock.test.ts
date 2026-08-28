/**
 * Regression: issue #9967.
 *
 * On a machine whose only real login is Anthropic OAuth but which also carries
 * an ambient AWS credential *source* (a stray `~/.aws` profile, an EC2 instance
 * role, static keys exported for unrelated tooling), `amazon-bedrock` passed the
 * default-model availability gate via the self-resolving `AUTHENTICATED_SENTINEL`
 * and — because its default model leads the bundled catalog order — won the
 * startup default over the provider the user actually signed into. The session
 * then 403'd on the first turn. The fix teaches auto-selection to prefer a
 * provider with a *concrete* credential over a sentinel-only ambient one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("issue #9967 default model with ambient Bedrock credentials", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let savedAccessKey: string | undefined;
	let savedSecret: string | undefined;
	let savedBearerToken: string | undefined;

	beforeEach(async () => {
		savedAccessKey = process.env.AWS_ACCESS_KEY_ID;
		savedSecret = process.env.AWS_SECRET_ACCESS_KEY;
		savedBearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
		delete process.env.AWS_ACCESS_KEY_ID;
		delete process.env.AWS_SECRET_ACCESS_KEY;
		delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		tempDir = path.join(os.tmpdir(), `pi-9967-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		// The user's only real login: an Anthropic credential.
		await authStorage.set("anthropic", [{ type: "api_key", key: "sk-test-anthropic" }]);
		registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterEach(() => {
		authStorage.close();
		if (savedAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
		else process.env.AWS_ACCESS_KEY_ID = savedAccessKey;
		if (savedSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
		else process.env.AWS_SECRET_ACCESS_KEY = savedSecret;
		if (savedBearerToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		else process.env.AWS_BEARER_TOKEN_BEDROCK = savedBearerToken;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("prefers the concretely-authed provider over an ambient Bedrock default", () => {
		// Without any AWS credentials, Bedrock is not available and Anthropic wins.
		expect(authStorage.hasAuth("amazon-bedrock")).toBe(false);
		const baseline = pickDefaultAvailableModel(registry.getAvailable(), provider =>
			registry.hasConcreteAuth(provider),
		);
		expect(baseline?.provider).toBe("anthropic");

		// Ambient AWS source with no usable Bedrock access (would 403 on request).
		process.env.AWS_ACCESS_KEY_ID = "AKIAJUNKJUNKJUNKJUNK";
		process.env.AWS_SECRET_ACCESS_KEY = "junksecretjunksecretjunksecretjunksecret";

		// The ambient source makes Bedrock *available* but not *concretely* authed.
		expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
		expect(registry.hasConcreteAuth("amazon-bedrock")).toBe(false);
		expect(registry.hasConcreteAuth("anthropic")).toBe(true);

		const available = registry.getAvailable();
		const bedrockIdx = available.findIndex(model => model.provider === "amazon-bedrock");
		const anthropicIdx = available.findIndex(model => model.provider === "anthropic");
		// Catalog order leads with Bedrock — the ordering that produced the bug.
		expect(bedrockIdx).toBeGreaterThanOrEqual(0);
		expect(bedrockIdx).toBeLessThan(anthropicIdx);

		// Old behavior (no credential hint) regresses onto the unusable Bedrock default.
		expect(pickDefaultAvailableModel(available)?.provider).toBe("amazon-bedrock");

		// Fixed behavior: the provider the user signed into wins.
		const picked = pickDefaultAvailableModel(available, provider => registry.hasConcreteAuth(provider));
		expect(picked?.provider).toBe("anthropic");
		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER.anthropic);
	});

	test("treats a dedicated Bedrock bearer token as concrete auth", () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-test-token";

		expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
		expect(registry.hasConcreteAuth("amazon-bedrock")).toBe(true);

		const picked = pickDefaultAvailableModel(registry.getAvailable(), provider => registry.hasConcreteAuth(provider));
		expect(picked?.provider).toBe("amazon-bedrock");
	});
});
