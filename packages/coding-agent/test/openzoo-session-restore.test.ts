/**
 * A session saved on openzoo/auto has no bundled row. When the discovery
 * cache is empty, resume must refresh the built-in OpenZoo catalog before
 * failing with "Could not restore model openzoo/auto". Bundled providers
 * stay off that path: a missing anthropic id is not a live-only catalog.
 *
 * The proxy URL and bearer live in this session's models.yml. Discovery
 * must use that scoped config; the test does not touch process env, so a
 * concurrent suite still sees the caller's OPENZOO_BASE_URL and
 * OPENZOO_API_KEY.
 */
import { expect, test } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { sessionModelDiscoveryProviders } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Distinct from the localhost:8402 default so a hit on the env fallback fails. */
const SCOPED_BASE_URL = "http://127.0.0.1:18402/v1";
const SCOPED_API_KEY = "oz_scoped-restore";

test("cold session resume refreshes openzoo/auto and keeps advertised capabilities", async () => {
	const envBefore = {
		baseUrl: Bun.env.OPENZOO_BASE_URL,
		apiKey: Bun.env.OPENZOO_API_KEY,
	};
	const tmp = await TempDir.create("@openzoo-resume-");
	await Bun.write(
		tmp.join("models.yml"),
		["providers:", "  openzoo:", `    baseUrl: ${SCOPED_BASE_URL}`, `    apiKey: ${SCOPED_API_KEY}`, ""].join("\n"),
	);
	const authStorage = createInMemoryAuthStorage();
	const settings = Settings.isolated({});
	const urls: string[] = [];
	const authorization: (string | null)[] = [];
	const registry = new ModelRegistry(authStorage, tmp.join("models.yml"), {
		settings,
		fetch: async (input, init) => {
			urls.push(String(input));
			authorization.push(new Headers(init?.headers).get("Authorization"));
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
			expect(urls).toEqual([`${SCOPED_BASE_URL}/models`]);
			expect(authorization).toEqual([`Bearer ${SCOPED_API_KEY}`]);
			expect(Bun.env.OPENZOO_BASE_URL).toBe(envBefore.baseUrl);
			expect(Bun.env.OPENZOO_API_KEY).toBe(envBefore.apiKey);
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await tmp.remove();
	}
});
