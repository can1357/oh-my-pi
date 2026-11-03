import * as path from "node:path";
import { registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { CostGate } from "../../src/session/cost-gate";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage } from "../helpers/agent-session-setup";

// Run as `bun <this-file> supplied|root|metered`, not under `bun test`:
// the SDK intentionally disables its description store in Bun's test runtime.
const mode = Bun.argv[2];
if (mode !== "supplied" && mode !== "root" && mode !== "metered") throw new Error(`Unknown mode: ${mode}`);
using dir = TempDir.createSync("@omp-skill-cap-probe-");
let calls = 0;
const originalFetch = globalThis.fetch;
const rejectingFetch = async () => {
	calls++;
	throw new Error("network refused by probe");
};
rejectingFetch.preconnect = originalFetch.preconnect;
if (mode !== "metered") globalThis.fetch = rejectingFetch;
const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
try {
	const settings = Settings.isolated({ "session.maxCost": 1, "marketplace.autoUpdate": "off" });
	settings.setModelRole("default", "denied/probe");
	settings.setModelRole("smol", "denied/probe");
	const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"), { settings });
	const api = mode === "metered" ? "test-skill-metered" : "openai-completions";
	if (mode === "metered") {
		registerCustomApi(api, () => {
			calls++;
			const stream = new AssistantMessageEventStream();
			const response = createAssistantMessage("Use when checking attribution.");
			response.usage.cost.total = 1.25;
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: response }));
			return stream;
		});
	}
	registry.registerProvider("denied", {
		api,
		baseUrl: "https://provider.invalid/v1",
		apiKey: "synthetic-not-a-credential",
		models: [
			{
				id: "probe",
				name: "Probe",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			},
		],
	});
	const model = registry.find("denied", "probe");
	if (!model) throw new Error("Missing synthetic model");
	const sessionManager = SessionManager.inMemory(dir.path());
	if (mode === "root") {
		const previous = createAssistantMessage("Earlier spend");
		previous.usage.cost.total = 1;
		sessionManager.appendMessage(previous);
	}
	const gate = mode === "root" ? undefined : new CostGate(settings, mode === "supplied" ? 1 : 0, () => {});
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		sessionManager,
		authStorage: auth,
		modelRegistry: registry,
		settings,
		model,
		costGate: gate,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		cacheWarming: false,
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		skills: [
			{
				name: "attribution",
				description:
					"An uncached synthetic skill description to trigger background compression without any provider network admission.",
				filePath: path.join(dir.path(), "SKILL.md"),
				baseDir: dir.path(),
				source: "native:project",
			},
		],
	});
	await session.dispose();
	console.log(JSON.stringify({ calls, spent: session.costGate.spent }));
} finally {
	auth.close();
	globalThis.fetch = originalFetch;
}
