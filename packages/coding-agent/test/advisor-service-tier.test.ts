/**
 * Contract: the advisor's service tier is resolved from the advisor's OWN
 * per-request reasoning — the effort/disable state its loop actually sends —
 * never the parent session's UI thinking selection.
 *
 * - Exact `tier.modelOverrides` rules (`provider/model:effort`) bind on the
 *   advisor's request effort, ahead of the `tier.advisor` baseline.
 * - A disabled (`:off`) advisor binds no effort rule; a model-wide exact rule
 *   still applies.
 * - `tier.advisor: none` keeps omitting the wire parameter unless an exact
 *   rule matches; `inherit` tracks the host session's live family baseline.
 *
 * Observable at the advisor's stream call (`opts.serviceTier` next to the
 * `reasoning`/`disableReasoning` the loop resolved for that request). The
 * parent session sits at `max` throughout: any leak of the parent effort into
 * advisor matching would flip these assertions to the `:max` rule instead.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model, ServiceTier, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** openai/gpt-5.6: bundled, reasoning, efforts `low`…`max`, openai tier family. */
const MODEL_SPEC = "openai/gpt-5.6";

interface CaptureOptions {
	/** `tier.modelOverrides` entries, e.g. `{ "openai/gpt-5.6:high": "priority" }`. */
	overrides?: Record<string, string>;
	/** `tier.advisor` setting; defaults to the `none` baseline when omitted. */
	advisorTier?: string;
	/** Advisor model selector, with optional `:level` thinking suffix. */
	advisorModel: string;
	/** OpenAI family baseline handed to the host session (for `inherit`). */
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
				// Fail the stream immediately — only the resolved options matter.
				throw new Error("capture-stop");
			},
			// Parent UI thinking at max: the advisor must never inherit it.
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
		// Default advisor effort is the model's medium — neither exact rule
		// matches, so the parameter is omitted; a parent-max leak would return
		// the `:max` rule's tier instead.
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
