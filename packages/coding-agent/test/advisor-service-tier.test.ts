import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model, ServiceTier, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** openai/gpt-5.6: bundled, reasoning, efforts `low`…`max`, openai tier family. */
const MODEL_SPEC = "openai/gpt-5.6";

/** Minimal valid 1x1 PNG used as the advisor image-question probe file. */
const PNG_ONE_PX_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface CaptureOptions {
	overrides?: Record<string, string>;
	advisorTier?: string;
	advisorModel: string;
	familyBaseline?: ServiceTier;
	/** Explicit live choice in the primary session; inherited advisors alone follow it. */
	familyOverride?: ServiceTier | null;
}

describe("AgentSession advisor service tier", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("openai", "gpt-5.6");
		if (!bundled) throw new Error("Expected built-in openai gpt-5.6 model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-advisor-tier-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		try {
			await tempDir.remove();
		} catch {}
	});

	async function captureAdvisorStreamOptions(capture: CaptureOptions): Promise<SimpleStreamOptions> {
		const captured: Array<SimpleStreamOptions | undefined> = [];
		const settingsEntries: Record<string, unknown> = { "compaction.enabled": false };
		if (capture.advisorTier !== undefined) settingsEntries["tier.advisor"] = capture.advisorTier;
		if (capture.overrides !== undefined) settingsEntries["tier.modelOverrides"] = capture.overrides;
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(settingsEntries),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_m, _ctx, opts) => {
				captured.push(opts);
				throw new Error("capture-stop");
			},
			thinkingLevel: Effort.Max,
			advisorConfigs: [{ name: "tier-probe", model: capture.advisorModel }],
			serviceTierByFamily: capture.familyBaseline ? { openai: capture.familyBaseline } : undefined,
		});
		if (capture.familyOverride === null) {
			session.setFastMode(false);
		} else if (capture.familyOverride !== undefined) {
			session.setServiceTierFamily("openai", capture.familyOverride);
		}
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		await advisor.prompt("ping").catch(() => {});
		const opts = captured[0];
		if (!opts) throw new Error("Expected captured advisor stream options");
		return opts;
	}

	it("binds the advisor's own :high rule while the parent UI sits at max", async () => {
		const opts = await captureAdvisorStreamOptions({
			overrides: { [`${MODEL_SPEC}:high`]: "priority", [`${MODEL_SPEC}:max`]: "flex" },
			advisorModel: `${MODEL_SPEC}:high`,
		});
		expect(opts.reasoning).toBe(Effort.High);
		expect(opts.serviceTier).toBe("priority");
	});

	it("binds :max when the advisor itself runs at max", async () => {
		const opts = await captureAdvisorStreamOptions({
			overrides: { [`${MODEL_SPEC}:high`]: "priority", [`${MODEL_SPEC}:max`]: "flex" },
			advisorModel: `${MODEL_SPEC}:max`,
		});
		expect(opts.reasoning).toBe(Effort.Max);
		expect(opts.serviceTier).toBe("flex");
	});

	it("binds no effort rule for an advisor without its own effort, despite parent max", async () => {
		const opts = await captureAdvisorStreamOptions({
			overrides: { [`${MODEL_SPEC}:high`]: "priority", [`${MODEL_SPEC}:max`]: "flex" },
			advisorModel: MODEL_SPEC,
		});
		expect(opts.reasoning).toBe(Effort.Medium);
		expect(opts.serviceTier).toBeUndefined();
	});

	it("skips effort rules for a disabled advisor but keeps the model-wide rule", async () => {
		const opts = await captureAdvisorStreamOptions({
			overrides: { [`${MODEL_SPEC}:high`]: "priority", [MODEL_SPEC]: "scale" },
			advisorModel: `${MODEL_SPEC}:off`,
		});
		expect(opts.reasoning).toBeUndefined();
		expect(opts.disableReasoning).toBe(true);
		expect(opts.serviceTier).toBe("scale");
	});

	it("keeps omitting the parameter under the none baseline when no exact rule matches", async () => {
		const opts = await captureAdvisorStreamOptions({
			advisorTier: "none",
			advisorModel: `${MODEL_SPEC}:high`,
		});
		expect(opts.serviceTier).toBeUndefined();
	});

	it("lets an exact model rule win over the none baseline", async () => {
		const opts = await captureAdvisorStreamOptions({
			advisorTier: "none",
			overrides: { [`${MODEL_SPEC}:high`]: "priority" },
			advisorModel: `${MODEL_SPEC}:high`,
		});
		expect(opts.serviceTier).toBe("priority");
	});

	it("inherits the host session's family baseline per request under inherit", async () => {
		const opts = await captureAdvisorStreamOptions({
			advisorTier: "inherit",
			familyBaseline: "scale",
			advisorModel: `${MODEL_SPEC}:high`,
		});
		expect(opts.reasoning).toBe(Effort.High);
		expect(opts.serviceTier).toBe("scale");
	});

	it("keeps non-inheriting advisor rules independent of the primary's live tier", async () => {
		const opts = await captureAdvisorStreamOptions({
			advisorTier: "none",
			familyOverride: "priority",
			overrides: { [`${MODEL_SPEC}:high`]: "flex" },
			advisorModel: `${MODEL_SPEC}:high`,
		});
		expect(opts.serviceTier).toBe("flex");
	});

	it("keeps an inherited explicit off ahead of the advisor's model rule", async () => {
		const opts = await captureAdvisorStreamOptions({
			advisorTier: "inherit",
			familyOverride: null,
			overrides: { [`${MODEL_SPEC}:high`]: "priority" },
			advisorModel: `${MODEL_SPEC}:high`,
		});
		expect(opts.serviceTier).toBeUndefined();
	});
});

describe("SDK advisor tool session tier isolation", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let session: AgentSession | undefined;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("openai", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("openai", "gpt-5.6");
		if (!bundled) throw new Error("Expected built-in openai gpt-5.6 model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-advisor-vision-tier-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
			session = undefined;
		}
		try {
			await tempDir.remove();
		} catch {}
	});

	/**
	 * Run one real advisor `read <png>?q=...` tool call through the SDK's pinned
	 * advisor tool session and return the vision one-shot's stream options. The
	 * vision model is a mock-api model injected via the registry `getAvailable`
	 * seam, so the recorded options carry exactly what the tool session resolved.
	 */
	async function captureVisionRequestOptions(capture: {
		advisorTier?: string;
		overrides?: Record<string, string>;
		/** Explicit live primary choice, as a launch flag would set it. */
		familyOverride?: ServiceTier;
	}): Promise<SimpleStreamOptions> {
		const pngPath = tempDir.join("probe.png");
		await Bun.write(pngPath, Buffer.from(PNG_ONE_PX_BASE64, "base64"));
		await Bun.write(tempDir.join("WATCHDOG.yml"), "advisors:\n  - name: tier-probe\n    tools: [read]\n");
		const settingsEntries: Record<string, unknown> = {
			"compaction.enabled": false,
			"advisor.syncBacklog": "1",
			"tools.approvalMode": "yolo",
		};
		if (capture.advisorTier !== undefined) settingsEntries["tier.advisor"] = capture.advisorTier;
		if (capture.overrides !== undefined) settingsEntries["tier.modelOverrides"] = capture.overrides;
		const settings = Settings.isolated(settingsEntries);
		settings.setModelRole("advisor", MODEL_SPEC);
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			...(capture.familyOverride ? { serviceTierOverrides: { openai: capture.familyOverride } } : {}),
		});
		session = result.session;
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		const readTool = advisor.state.tools.find(tool => tool.name === "read");
		if (!readTool?.execute) throw new Error("Expected the advisor to carry a callable read tool");
		const visionMock = createMockModel({
			provider: "openai",
			id: "vision-probe",
			handler: () => ({ content: ["vision answer"] }),
		});
		registerMockApi();
		Object.assign(visionMock, { input: ["image", "text"] });
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([visionMock]);

		const answer = await readTool.execute("probe-call", { path: `${pngPath}?q=What does this show?` });
		if (answer.isError) {
			throw new Error(`Advisor read tool failed: ${JSON.stringify(answer.content)}`);
		}
		expect(JSON.stringify(answer.content)).toContain("vision answer");
		if (visionMock.calls.length !== 1) throw new Error("Expected exactly one vision request");
		const options = visionMock.calls[0].options;
		if (!options) throw new Error("Expected recorded vision request options");
		return options;
	}

	it("keeps the primary's explicit priority out of pinned advisor image questions", async () => {
		const opts = await captureVisionRequestOptions({ familyOverride: "priority" });
		expect(opts.serviceTier).toBeUndefined();
	});

	it("keeps a pinned advisor tier out of image questions without an exact rule", async () => {
		// The pin projects into the family-baseline views only; the manual
		// overrides channel stays empty so vision requests keep their
		// live-override/exact-rule resolution (never a broadcast tier).
		const opts = await captureVisionRequestOptions({ advisorTier: "priority" });
		expect(opts.serviceTier).toBeUndefined();
	});

	it("lets an exact vision model rule keep pinned advisor image questions untiered", async () => {
		const opts = await captureVisionRequestOptions({
			advisorTier: "priority",
			overrides: { "openai/vision-probe": "none" },
		});
		expect(opts.serviceTier).toBeUndefined();
	});

	it("tracks the session's live tier in pinned advisor image questions under inherit", async () => {
		const opts = await captureVisionRequestOptions({ advisorTier: "inherit", familyOverride: "priority" });
		expect(opts.serviceTier).toBe("priority");
	});
});
