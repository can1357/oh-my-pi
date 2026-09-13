/**
 * The prompt-rebuild decision a settings refresh makes must (a) survive the
 * later phases of the same refresh and (b) be derived from EVERY setting the
 * system-prompt render actually reads.
 *
 *   - `#doRefresh` runs settings, then roster, then MCP, and rebuilds once at
 *     the end if the accumulated decision says to. The roster phase assigned
 *     `rosterChanged` rather than OR-ing into it, so on the default
 *     `refresh("all")` an unchanged skill/rule roster overwrote the settings
 *     phase's `true` with `false` — the refreshed setting never reached the
 *     model.
 *   - The prompt-settings snapshot tracked only `personality` and the two xdev
 *     device-doc paths, so any other path `rebuildSystemPrompt` reads (starting
 *     with `includeModelInPrompt`, which renders the workstation
 *     model-identification line) compared equal and skipped the rebuild.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "refresh-prompt-settings-model",
		name: "Refresh Prompt Settings Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

interface Harness {
	session: AgentSession;
	cwd: string;
	settingsPath: string;
	/** A high-entropy value the obfuscator accepts as a real configured secret. */
	secretValue: string;
	dispose: () => Promise<void>;
}

async function makeHarness(initialConfig: string, seed?: (cwd: string) => Promise<void>): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-prompt-settings-");
	const cwd = tempDir.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	const settingsPath = path.join(cwd, "config.yml");
	// Staged BEFORE construction so the session starts from these values and the
	// test observes a real transition rather than a first-time application.
	await fs.writeFile(settingsPath, initialConfig);
	if (seed) await seed(cwd);
	const api = `refresh-prompt-settings-${Bun.nanoseconds().toString(36)}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({ cwd, agentDir: cwd }),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});

	return {
		session,
		cwd,
		settingsPath,
		secretValue: `SECRET_VALUE_${Bun.nanoseconds().toString(36)}_abcdef123456`,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh('all'): the settings phase's rebuild decision survives the roster phase", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rebuilds the system prompt when only personality moved and the roster is unchanged", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\npersonality: default\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\npersonality: friendly\n");
			// The DEFAULT scope — settings phase, then roster phase, then MCP.
			const result = await h.session.refresh("all");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the settings phase set the rebuild flag for the moved
			// `personality`, then the roster phase ASSIGNED over it — and with no
			// skill or rule change that assignment was `false`, so the final guard
			// skipped the sole rebuild and the prompt kept the old personality block.
			expect(h.session.systemPrompt.join("\n")).not.toBe(before);
		} finally {
			await h.dispose();
		}
	});

	it("rebuilds the system prompt when only an xdev prompt setting moved and the roster is unchanged", async () => {
		// The second half of the same clobber: `tools.xdevDocs` is the other
		// prompt-affecting path the settings phase already tracked, and it is
		// equally lost when the roster phase overwrites the decision.
		const h = await makeHarness("compaction:\n  enabled: false\ntools:\n  xdevDocs: builtins\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\ntools:\n  xdevDocs: catalog\n");
			const result = await h.session.refresh("all");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.systemPrompt.join("\n")).not.toBe(before);
		} finally {
			await h.dispose();
		}
	});

	it("still keeps the prompt byte-identical on refresh('all') when no prompt-affecting setting moved", async () => {
		// The accumulate fix must not become an unconditional rebuild: an
		// unrelated settings edit with an unchanged roster keeps provider prompt
		// caching hitting.
		const h = await makeHarness("compaction:\n  enabled: false\npersonality: default\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\npersonality: default\nautoCompact: false\n",
			);
			const result = await h.session.refresh("all");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.systemPrompt.join("\n")).toBe(before);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): the prompt-settings snapshot covers what the render reads", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rebuilds the system prompt when includeModelInPrompt is flipped off", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nincludeModelInPrompt: true\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");
			// Guard the premise: the flag is ON, so the model-identification line
			// really is in the rendered prompt and dropping it is observable.
			expect(before).toContain("refresh-prompt-settings-model");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nincludeModelInPrompt: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the snapshot tracked only personality + the xdev paths, so
			// this compared equal, no rebuild fired, and the session kept sending
			// the old model-identification block.
			expect(h.session.systemPrompt.join("\n")).not.toBe(before);
			expect(h.session.systemPrompt.join("\n")).not.toContain("refresh-prompt-settings-model");
		} finally {
			await h.dispose();
		}
	});

	it("rebuilds the system prompt when includeModelInPrompt is flipped back on", async () => {
		// The reverse direction, so the snapshot is proven symmetric rather than
		// only catching a removal.
		const h = await makeHarness("compaction:\n  enabled: false\nincludeModelInPrompt: false\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");
			expect(before).not.toContain("refresh-prompt-settings-model");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nincludeModelInPrompt: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.systemPrompt.join("\n")).toContain("refresh-prompt-settings-model");
		} finally {
			await h.dispose();
		}
	});

	it("rebuilds the system prompt when skillful is flipped off", async () => {
		// A second path the old snapshot missed: `skillful` gates whether the skill
		// roster is advertised at all.
		const h = await makeHarness("compaction:\n  enabled: false\nskillful: true\ntui:\n  renderMermaid: true\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nskillful: true\ntui:\n  renderMermaid: false\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// `tui.renderMermaid` states a rendering contract to the model; pre-fix
			// it was absent from the snapshot and the block went stale.
			expect(h.session.systemPrompt.join("\n")).not.toBe(before);
		} finally {
			await h.dispose();
		}
	});
});

// The `$$HASH$$` prompt block and the obfuscator that MINTS those placeholders
// must move together, and the refresh rebuilds the obfuscator outside the
// settings snapshot — so this prompt input needs its own change signal.
//
// Keyed on the obfuscator's own `hasSecrets()` verdict rather than the
// `secrets.enabled` flag: `hasSecrets()` is what every minting path already
// gates on, so the instruction is present exactly when a placeholder can
// appear. (In practice the two agree while enabled — `buildSecretObfuscator`
// always appends the built-in credential-pattern regex — but the verdict is the
// property that matters, and reading it costs nothing.)
describe("AgentSession refresh('settings'): the secret-placeholder prompt block tracks the obfuscator", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds the placeholder instruction when a refresh enables secrets", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nsecrets:\n  enabled: false\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			// Guard the premise: with secrets off there is no instruction, so its
			// arrival is observable.
			expect(h.session.systemPrompt.join("\n")).not.toContain("$$NAME_HASH:CASE$$");

			// A real configured secret plus the enabling flag, so the rebuilt
			// obfuscator genuinely reports `hasSecrets()`.
			await fs.mkdir(path.join(h.cwd, ".omp"), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "secrets.yml"),
				`- type: plain\n  mode: obfuscate\n  content: ${h.secretValue}\n`,
			);
			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nsecrets:\n  enabled: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the callback rebuilt only the obfuscator, while
			// `rebuildSystemPrompt` kept its construction-time `secretsEnabled`
			// const — so the session started minting `$$HASH$$` placeholders while
			// the prompt still never told the model they were intentional.
			expect(h.session.systemPrompt.join("\n")).toContain("$$NAME_HASH:CASE$$");
		} finally {
			await h.dispose();
		}
	});

	it("keeps the instruction when an enabled secrets.yml gains an entry", async () => {
		// `secrets.enabled` never moves here, so only the file's contents do —
		// and the verdict does NOT move with them: `buildSecretObfuscator` always
		// appends the built-in credential-pattern regex, and `hasSecrets()` is
		// true as soon as any regex entry compiles. So an ENABLED session already
		// reports secrets with an empty `secrets.yml`, and the instruction is
		// correctly present the whole time.
		const h = await makeHarness("compaction:\n  enabled: false\nsecrets:\n  enabled: true\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");
			expect(before).toContain("$$NAME_HASH:CASE$$");

			await fs.mkdir(path.join(h.cwd, ".omp"), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "secrets.yml"),
				`- type: plain\n  mode: obfuscate\n  content: ${h.secretValue}\n`,
			);
			// An unrelated settings edit, so the reload reports `changed` exactly as
			// a real session would while the secrets flag itself stands still.
			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nsecrets:\n  enabled: true\nautoCompact: false\n",
			);
			await h.session.refresh("settings");

			// The instruction stays, and the prompt stays byte-identical: the
			// verdict never moved, so nothing may churn the provider cache.
			expect(h.session.systemPrompt.join("\n")).toBe(before);
		} finally {
			await h.dispose();
		}
	});

	it("removes the instruction when a refresh disables secrets", async () => {
		// The reverse direction: the obfuscator is dropped, so the prompt must
		// stop claiming placeholders are expected.
		const h = await makeHarness("compaction:\n  enabled: false\nsecrets:\n  enabled: true\n", async cwd => {
			await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "secrets.yml"),
				`- type: plain\n  mode: obfuscate\n  content: SECRET_VALUE_FOR_TEARDOWN_abcdef123456\n`,
			);
		});
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).toContain("$$NAME_HASH:CASE$$");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nsecrets:\n  enabled: false\n");
			await h.session.refresh("settings");

			expect(h.session.systemPrompt.join("\n")).not.toContain("$$NAME_HASH:CASE$$");
		} finally {
			await h.dispose();
		}
	});

	it("keeps the prompt byte-identical when the secrets verdict does not move", async () => {
		// The rebuild is keyed on the VERDICT, not on the refresh re-reading
		// `secrets.yml`: an unrelated edit with secrets steady must keep provider
		// prompt caching hitting.
		const h = await makeHarness("compaction:\n  enabled: false\nsecrets:\n  enabled: true\n", async cwd => {
			await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "secrets.yml"),
				`- type: plain\n  mode: obfuscate\n  content: SECRET_VALUE_FOR_STEADY_abcdef123456\n`,
			);
		});
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");
			expect(before).toContain("$$NAME_HASH:CASE$$");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nsecrets:\n  enabled: true\nautoCompact: false\n",
			);
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.systemPrompt.join("\n")).toBe(before);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): includeWorkspaceTree reaches the prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the workspace tree after a refresh turns the setting on", async () => {
		// The setting and the tree scan were both captured at construction, so a
		// session started with it OFF could never gain the tree: the refresh
		// reported success while the model kept seeing no tree at all.
		const h = await makeHarness("compaction:\n  enabled: false\nincludeWorkspaceTree: false\n", async cwd => {
			await fs.mkdir(path.join(cwd, "src", "deep"), { recursive: true });
			await fs.writeFile(path.join(cwd, "src", "deep", "marker-file.ts"), "export const marker = 1;\n");
		});
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).not.toContain("marker-file.ts");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nincludeWorkspaceTree: true\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			// The scan runs on the off→on flip, so the tree is both enabled AND
			// populated — a live flag with a frozen empty scan would still be blank.
			expect(h.session.systemPrompt.join("\n")).toContain("marker-file.ts");
		} finally {
			await h.dispose();
		}
	});

	it("drops the workspace tree after a refresh turns the setting off", async () => {
		// The inverse: started ON, the frozen capture kept rendering the tree.
		const h = await makeHarness("compaction:\n  enabled: false\nincludeWorkspaceTree: true\n", async cwd => {
			await fs.mkdir(path.join(cwd, "src", "deep"), { recursive: true });
			await fs.writeFile(path.join(cwd, "src", "deep", "marker-file.ts"), "export const marker = 1;\n");
		});
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).toContain("marker-file.ts");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nincludeWorkspaceTree: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.systemPrompt.join("\n")).not.toContain("marker-file.ts");
		} finally {
			await h.dispose();
		}
	});

	it("rescans the workspace tree after the session moves to another project", async () => {
		// The scan was cached behind a "have scanned" flag and built from the
		// construction-time cwd, so a session that moved kept advertising the
		// ORIGINAL project's files — and because the flag never reset, a later
		// off->on flip resurrected that same stale tree rather than rescanning.
		const h = await makeHarness("compaction:\n  enabled: false\nincludeWorkspaceTree: true\n", async cwd => {
			await fs.mkdir(path.join(cwd, "src", "deep"), { recursive: true });
			await fs.writeFile(path.join(cwd, "src", "deep", "marker-file.ts"), "export const marker = 1;\n");
		});
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).toContain("marker-file.ts");

			// A second project, with a file the first one does not have.
			const moved = path.join(path.dirname(h.cwd), "moved-project");
			await fs.mkdir(path.join(moved, "lib"), { recursive: true });
			await fs.writeFile(path.join(moved, "lib", "moved-marker.ts"), "export const moved = 1;\n");
			h.session.sessionManager.setCwdWithoutRelocation(moved);

			await h.session.refreshBaseSystemPrompt();

			const prompt = h.session.systemPrompt.join("\n");
			expect(prompt).toContain("moved-marker.ts");
			expect(prompt).not.toContain("marker-file.ts");
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): bash.autoBackground.enabled reaches the prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The line `bash.md` and `eval.md` gate on `autoBackgroundEnabled`. Asserted
	// as prompt TEXT rather than by spying on the rebuild, because the defect was
	// that the model kept reading retired guidance — execution and the tool
	// property already followed the setting live.
	const GUIDANCE = "auto-background by the configured threshold";

	it("advertises auto-background after a refresh turns the setting on", async () => {
		// The setting is read live by `BashTool.description`, but under
		// `inlineToolDescriptors` that description is rendered INTO the system
		// prompt, and only a rebuild moves it. The path was missing from the
		// prompt-settings snapshot, so the refresh compared equal and skipped the
		// rebuild: the model kept being told long calls never auto-background.
		const h = await makeHarness(
			"compaction:\n  enabled: false\ninlineToolDescriptors: true\nbash:\n  autoBackground:\n    enabled: false\n",
		);
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).not.toContain(GUIDANCE);

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\ninlineToolDescriptors: true\nbash:\n  autoBackground:\n    enabled: true\n",
			);
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.systemPrompt.join("\n")).toContain(GUIDANCE);
		} finally {
			await h.dispose();
		}
	});

	it("withdraws the auto-background guidance after a refresh turns the setting off", async () => {
		// The inverse, which is the worse direction: the model keeps being offered
		// a behaviour the policy has withdrawn.
		const h = await makeHarness(
			"compaction:\n  enabled: false\ninlineToolDescriptors: true\nbash:\n  autoBackground:\n    enabled: true\n",
		);
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).toContain(GUIDANCE);

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\ninlineToolDescriptors: true\nbash:\n  autoBackground:\n    enabled: false\n",
			);
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.systemPrompt.join("\n")).not.toContain(GUIDANCE);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): eval's own description settings reach the prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// `EvalTool.description` passes `eval.autoBackground.enabled` — its OWN key,
	// never the bash one — so tracking only `bash.autoBackground.enabled` left
	// the embedded eval description advertising the retired contract.
	const GUIDANCE = "auto-background by the configured threshold";

	it("withdraws eval's auto-background guidance after a refresh turns it off", async () => {
		const h = await makeHarness(
			"compaction:\n  enabled: false\ninlineToolDescriptors: true\nbash:\n  autoBackground:\n    enabled: false\neval:\n  autoBackground:\n    enabled: true\n",
		);
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).toContain(GUIDANCE);

			// Only the EVAL key moves; the bash one is already off and stays off,
			// so a snapshot tracking just the bash key compares equal here.
			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\ninlineToolDescriptors: true\nbash:\n  autoBackground:\n    enabled: false\neval:\n  autoBackground:\n    enabled: false\n",
			);
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.systemPrompt.join("\n")).not.toContain(GUIDANCE);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): a memory injection limit reaches the prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rebuilds the prompt when only mnemopi.injectionTokenLimit moves", async () => {
		// Both memory backends TRUNCATE their rendered instructions to the limit,
		// so the limit is prompt TEXT. The backend here renders the live value for
		// the same reason: a stub returning a constant could not distinguish a
		// rebuild that re-read settings from one that did not.
		const backend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions(_agentDir, settings) {
				return `memory budget ${settings.get("mnemopi.injectionTokenLimit")}`;
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				return undefined;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);

		const h = await makeHarness(
			"compaction:\n  enabled: false\nmemory:\n  backend: mnemopi\nmnemopi:\n  injectionTokenLimit: 5000\n",
		);
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");
			expect(before).toContain("memory budget 5000");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nmemory:\n  backend: mnemopi\nmnemopi:\n  injectionTokenLimit: 9000\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix the snapshot omitted the limit, so it compared equal and the
			// final rebuild was skipped — leaving the old-sized memory block.
			expect(h.session.systemPrompt.join("\n")).toContain("memory budget 9000");
		} finally {
			await h.dispose();
		}
	});

	it("rebuilds the prompt when only task.eager moves", async () => {
		// `rebuildSystemPrompt` reads this live, which fixes what a rebuild
		// RENDERS — but a rebuild still has to be triggered, and this setting can
		// be the only thing on disk that moved. Nothing else sets `rosterChanged`,
		// so the prompt kept stating the previous delegation posture.
		const h = await makeHarness("compaction:\n  enabled: false\ntask:\n  eager: always\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).toContain("Delegation default.");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\ntask:\n  eager: preferred\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			const after = h.session.systemPrompt.join("\n");
			expect(after).toContain("Delegation preferred.");
			expect(after).not.toContain("Delegation default.");
		} finally {
			await h.dispose();
		}
	});
});
