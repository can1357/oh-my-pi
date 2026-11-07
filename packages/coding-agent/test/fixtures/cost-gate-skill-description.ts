import * as path from "node:path";
import { registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	__providerInFlightForTesting,
	configureProviderMaxInFlightRequests,
	streamSimple,
} from "@oh-my-pi/pi-ai/stream";
import { isBunTestRuntime, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { createSkillDescriptionCompressor } from "../../src/extensibility/skill-descriptions";
import { CostCapError, CostGate } from "../../src/session/cost-gate";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage } from "../helpers/agent-session-setup";

// Run as `bun <this-file> supplied|root|metered|queued`, not under `bun test`:
// the SDK intentionally disables its description store in Bun's test runtime.
const mode = Bun.argv[2];
if (mode !== "supplied" && mode !== "root" && mode !== "metered" && mode !== "queued")
	throw new Error(`Unknown mode: ${mode}`);
// Without the store no compression starts, so `supplied`/`root` would pass vacuously and `metered` would fail.
if (isBunTestRuntime()) throw new Error("Run this fixture outside the test runtime (unset PI_TEST_RUNTIME)");
using dir = TempDir.createSync("@omp-skill-cap-probe-");
let calls = 0;
const originalFetch = globalThis.fetch;
const rejectingFetch = async () => {
	calls++;
	throw new Error("network refused by probe");
};
rejectingFetch.preconnect = originalFetch.preconnect;
if (mode === "supplied" || mode === "root") globalThis.fetch = rejectingFetch;
const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
try {
	const settings = Settings.isolated({
		"session.maxCost": 1,
		// Metered mode's 1.25 response crosses this, so the gate's warning marks the moment it was recorded.
		"session.warnCost": 1,
		"marketplace.autoUpdate": "off",
		"providers.maxInFlightRequests": mode === "queued" ? { denied: 1 } : {},
	});
	settings.setModelRole("default", "denied/probe");
	settings.setModelRole("smol", "denied/probe");
	const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"), { settings });
	const api = mode === "metered" || mode === "queued" ? "test-skill-metered" : "openai-completions";
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	if (mode === "metered" || mode === "queued") {
		registerCustomApi(api, () => {
			calls++;
			const stream = new AssistantMessageEventStream();
			const response = createAssistantMessage("Use when checking attribution.");
			response.usage.cost.total = mode === "metered" ? 1.25 : 0;
			if (mode === "queued" && calls === 1) {
				firstStarted.resolve();
				void releaseFirst.promise.then(() => stream.push({ type: "done", reason: "stop", message: response }));
			} else {
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: response }));
			}
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
	const waiting = Promise.withResolvers<void>();
	if (mode === "queued") {
		__providerInFlightForTesting.setRoot(path.join(dir.path(), "leases"));
		configureProviderMaxInFlightRequests({ denied: 1 });
	}
	const first =
		mode === "queued"
			? streamSimple(
					model,
					{ messages: [{ role: "user", content: "sibling", timestamp: Date.now() }] },
					{
						apiKey: "synthetic-not-a-credential",
					},
				).result()
			: undefined;
	if (first) await firstStarted.promise;
	if (mode === "queued") {
		__providerInFlightForTesting.setWaitObserver(provider => {
			if (provider === "denied") waiting.resolve();
		});
	}
	const sessionManager = SessionManager.inMemory(dir.path());
	if (mode === "root") {
		const previous = createAssistantMessage("Earlier spend");
		previous.usage.cost.total = 1;
		sessionManager.appendMessage(previous);
	}
	const recorded = Promise.withResolvers<void>();
	const gate =
		mode === "root" ? undefined : new CostGate(settings, mode === "supplied" ? 1 : 0, () => recorded.resolve());
	if (mode === "queued") {
		if (!gate) throw new Error("Missing queued request gate");
		const compressor = createSkillDescriptionCompressor(registry, settings, { getCostGate: () => gate });
		const compression = compressor.compress("attribution", "Plan migrations.", "Compress this.").then(
			() => false,
			error => error instanceof CostCapError,
		);
		await waiting.promise;
		gate.record(1);
		releaseFirst.resolve();
		await first;
		if (!(await compression)) throw new Error("Queued compression was not refused by its cost gate");
		console.log(JSON.stringify({ calls, spent: gate.spent }));
	} else {
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
		// Background compression finishes after startup returns; give it a bounded chance to be metered.
		if (mode === "metered") {
			const giveUp = setTimeout(() => recorded.resolve(), 5_000);
			await recorded.promise;
			clearTimeout(giveUp);
		}
		await session.dispose();
		console.log(JSON.stringify({ calls, spent: session.costGate.spent }));
	}
} finally {
	auth.close();
	globalThis.fetch = originalFetch;
}
