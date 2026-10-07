import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

let dir: string | undefined;
let auth: AuthStorage | undefined;

afterEach(async () => {
	auth?.close();
	auth = undefined;
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	dir = undefined;
});

test("Ultrafast resolves only an entitled Codex account while ordinary turns retain the pin", async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ultrafast-routing-"));
	auth = await AuthStorage.create(":memory:", {
		usageProviderResolver: provider =>
			provider === "openai-codex"
				? {
						id: "openai-codex",
						async fetchUsage() {
							return null;
						},
					}
				: undefined,
	});
	await auth.credentials.set("openai-codex", [
		{
			type: "oauth",
			access: "standard-token",
			refresh: "standard-refresh",
			expires: Date.now() + 86_400_000,
			accountId: "standard",
		},
		{
			type: "oauth",
			access: "ultrafast-token",
			refresh: "ultrafast-refresh",
			expires: Date.now() + 86_400_000,
			accountId: "ultrafast",
		},
	]);
	const astra = getBundledModels("openai-codex").find(model => model.id === "gpt-6-astra");
	if (!astra) throw new Error("Expected bundled Codex Astra");
	writeModelCache(
		resolveModelCacheProviderId("openai-codex"),
		Date.now(),
		[
			{
				...astra,
				serviceTiers: ["priority", "ultrafast"],
				accountAccess: {
					standard: { serviceTiers: ["priority"] },
					ultrafast: { serviceTiers: ["priority", "ultrafast"] },
				},
			},
		],
		true,
		"",
		path.join(dir, "models.db"),
	);
	const registry = new ModelRegistry(auth, path.join(dir, "models.json"));
	const model = registry.find("openai-codex", "gpt-6-astra");
	if (!model) throw new Error("Expected discovered Codex Astra");
	const first = auth.oauth.accounts("openai-codex").find(account => account.accountId === "standard");
	if (!first || !auth.sessions.pin("openai-codex", "normal", first.credentialId))
		throw new Error("Expected standard account pin");

	expect(await resolveApiKeyOnce(registry.resolver(model, { sessionId: "normal" }))).toBe("standard-token");
	expect(await resolveApiKeyOnce(registry.resolver(model, { sessionId: "normal", serviceTier: "ultrafast" }))).toBe(
		"ultrafast-token",
	);

	await auth.credentials.set("openai-codex", [
		{
			type: "oauth",
			access: "standard-token",
			refresh: "standard-refresh",
			expires: Date.now() + 86_400_000,
			accountId: "standard",
		},
	]);
	await expect(
		resolveApiKeyOnce(registry.resolver(model, { sessionId: "unavailable", serviceTier: "ultrafast" })),
	).rejects.toThrow("No Codex account advertising Ultrafast is available for gpt-6-astra");
});
