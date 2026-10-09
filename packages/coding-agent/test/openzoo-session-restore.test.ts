/**
 * A session saved on openzoo/auto has no bundled row. When the discovery
 * cache is empty, resume must refresh the built-in OpenZoo catalog before
 * failing with "Could not restore model openzoo/auto". Bundled providers
 * stay off that path: a missing anthropic id is not a live-only catalog.
 */
import { afterEach, expect, test } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { sessionModelDiscoveryProviders } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ENV_KEYS = ["OPENZOO_BASE_URL", "OPENZOO_API_KEY"] as const;
const ORIGINAL_ENV = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = ORIGINAL_ENV.get(key);
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
});

test("cold session resume refreshes openzoo/auto and keeps advertised capabilities", async () => {
	delete Bun.env.OPENZOO_BASE_URL;
	delete Bun.env.OPENZOO_API_KEY;
	const tmp = await TempDir.create("@openzoo-resume-");
	const authStorage = createInMemoryAuthStorage();
	const settings = Settings.isolated({});
	const urls: string[] = [];
	const registry = new ModelRegistry(authStorage, tmp.join("models.yml"), {
		settings,
		fetch: async input => {
			urls.push(String(input));
			return Response.json({
				data: [
					{
						id: "openzoo/auto",
						owned_by: "openzoo",
						supported_parameters: ["reasoning"],
						architecture: { input_modalities: ["text", "image"] },
					},
				],
			});
		},
	});
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendModelChange("openzoo/auto");
	try {
		expect(registry.find("openzoo", "auto")).toBeUndefined();
		// The built-in live-only catalog is reachable; a bundled provider is not.
		expect(registry.getDiscoveryProviderId("openzoo")).toBe("openzoo");
		expect(registry.getDiscoveryProviderId("OpenZoo")).toBe("openzoo");
		expect(registry.getDiscoveryProviderId("anthropic")).toBeUndefined();
		expect(sessionModelDiscoveryProviders(registry, ["openzoo/auto"], new Set())).toEqual(new Set(["openzoo"]));
		expect(sessionModelDiscoveryProviders(registry, ["openzoo/auto"], new Set(["openzoo"]))).toEqual(new Set());

		const { session } = await createAgentSession({
			cwd: tmp.path(),
			agentDir: tmp.path(),
			authStorage,
			modelRegistry: registry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			expect(session.model?.provider).toBe("openzoo");
			expect(session.model?.id).toBe("auto");
			expect(session.model?.reasoning).toBe(true);
			expect(session.model?.input).toEqual(["text", "image"]);
			expect(urls).toHaveLength(1);
			expect(urls[0]).toEndWith("/v1/models");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await tmp.remove();
	}
});
