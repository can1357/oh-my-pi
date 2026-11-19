import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	createAgentSession as legacyCreateAgentSession,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Issue #4567: every published version of pi-schedule-prompt (and every pi
// extension spawning subagents) imports `DefaultResourceLoader` at module
// scope from `@earendil-works/pi-coding-agent` and hands it to
// `createAgentSession({ resourceLoader })`. Before the fix the shim never
// exported the class, so those extensions failed to parse; even once exported,
// the shim's `createAgentSession` MUST translate the loader's captured state
// into the SDK's native option surface — otherwise `noExtensions: true` would
// be silently ignored, re-running discovery inside the subagent and reloading
// the very extension the caller passed the loader to prevent recursion for.
// These tests pin both contracts through the public package specifier.

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function mkTempCwd(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

describe("DefaultPackageManager.resolve() (issue #5658)", () => {
	it("enumerates configured extension paths through OMP discovery", async () => {
		const tmp = await mkTempCwd("omp-legacy-default-package-manager-");
		const cwd = path.join(tmp, "project");
		const agentDir = path.join(tmp, "agent");
		const extensionPath = path.join(cwd, "configured-extension.ts");
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(extensionPath, "export default function () {}\n", "utf8");
		const settingsManager = Settings.isolated({ extensions: [extensionPath] });
		const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

		const resolved = await manager.resolve(() => Promise.resolve("skip"));
		const extension = resolved.extensions.find(resource => resource.path === extensionPath);

		expect(extension).toEqual({
			path: extensionPath,
			enabled: true,
			metadata: {
				source: "auto",
				scope: "project",
				origin: "top-level",
			},
		});
		expect(resolved.skills).toEqual([]);
		expect(resolved.prompts).toEqual([]);
		expect(resolved.themes).toEqual([]);
	});
});

describe("DefaultResourceLoader.reload() (issue #4567)", () => {
	it("populates the discovery snapshot honoring no* flags and applying every override", async () => {
		const tmp = await mkTempCwd("omp-legacy-default-resource-loader-reload-");
		const injected: Skill = {
			name: "issue-4567-synthesized",
			description: "injected via skillsOverride",
			filePath: path.join(tmp, "synthesized.md"),
			baseDir: tmp,
			source: "test-injection",
		};

		const loader = new DefaultResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			// Isolated in-memory settings sidestep the global Settings.init()
			// singleton so this test cannot leak state into siblings.
			settingsManager: Settings.isolated(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			skillsOverride: base => ({
				skills: [...base.skills, injected],
				diagnostics: base.diagnostics,
			}),
		});

		// The `loaded` getter starts false; only `reload()` flips it. Guards
		// against a future regression where the constructor pre-marks the
		// loader (which would let `createAgentSession` skip the initial reload
		// and hand an empty snapshot to the SDK).
		expect(loader.loaded).toBe(false);

		await loader.reload();

		expect(loader.loaded).toBe(true);

		// `noExtensions: true` with no factories + no additional paths means
		// the discovery arm returns an empty result — proves the loader
		// actually honors the opt-out instead of scanning cwd.
		expect(loader.getExtensions().extensions).toEqual([]);

		// The skills override callback ran on the (empty) base result and its
		// injected entry survived into the stored snapshot. Proves the
		// override hook is applied even when the discovery arm is disabled,
		// which is the contract pi extensions rely on to inject synthetic
		// entries without touching the filesystem.
		const skillNames = loader.getSkills().skills.map(s => s.name);
		expect(skillNames).toContain(injected.name);

		// Every other disabled arm stays empty — no override was configured
		// for them, so the base empty result is what the getters must report.
		expect(loader.getPrompts().prompts).toEqual([]);
		expect(loader.getThemes().themes).toEqual([]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
	});
	it("loads relative additional skills and prompt templates before override callbacks when discovery is disabled", async () => {
		const tmp = await mkTempCwd("omp-legacy-default-resource-loader-additional-paths-");
		const skillName = "issue-4567-explicit-skill";
		const skillDescription = "Loaded from an explicit additionalSkillPaths directory";
		const skillRoot = path.join(tmp, "extra-skills");
		const skillDir = path.join(skillRoot, "extra-skill");
		const skillFile = path.join(skillDir, "SKILL.md");
		const promptDir = path.join(tmp, "extra-prompts");
		const promptName = "issue-4567-explicit-prompt";
		const promptDescription = "Loaded from an explicit additionalPromptTemplatePaths directory";
		const promptBody = "Use this explicit prompt template body.";
		const promptFile = path.join(promptDir, `${promptName}.md`);
		let skillsOverrideSawExplicit = false;
		let promptsOverrideSawExplicit = false;

		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			skillFile,
			`---\nname: ${skillName}\ndescription: ${skillDescription}\n---\n\n# Explicit Skill\n\nInvoke this explicit skill body.\n`,
			"utf8",
		);
		await fs.mkdir(promptDir, { recursive: true });
		await fs.writeFile(promptFile, `---\ndescription: ${promptDescription}\n---\n\n${promptBody}\n`, "utf8");

		const loader = new DefaultResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			settingsManager: Settings.isolated(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalSkillPaths: ["extra-skills"],
			additionalPromptTemplatePaths: ["extra-prompts"],
			skillsOverride: base => {
				skillsOverrideSawExplicit = base.skills.some(
					skill =>
						skill.name === skillName && skill.description === skillDescription && skill.filePath === skillFile,
				);
				return base;
			},
			promptsOverride: base => {
				promptsOverrideSawExplicit = base.prompts.some(
					prompt =>
						prompt.name === promptName &&
						prompt.description.includes(promptDescription) &&
						prompt.content.includes(promptBody),
				);
				return base;
			},
		});

		await loader.reload();

		expect(loader.getSkills().skills.map(skill => skill.name)).toContain(skillName);
		expect(loader.getPrompts().prompts.map(prompt => prompt.name)).toContain(promptName);
		expect(skillsOverrideSawExplicit).toBe(true);
		expect(promptsOverrideSawExplicit).toBe(true);
	});
});

describe("createAgentSession({ resourceLoader }) (issue #4567)", () => {
	it("translates a DefaultResourceLoader into the SDK's option surface without silently discarding it", async () => {
		const tmp = await mkTempCwd("omp-legacy-default-resource-loader-session-");

		let captured: CreateAgentSessionOptions | undefined;
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockImplementation(async (options?: CreateAgentSessionOptions) => {
				captured = options;
				// Only the caller's `await` needs to resolve; the shim doesn't
				// touch the returned session, so the shape is intentionally
				// minimal and cast through `unknown`.
				return {
					session: {} as never,
					extensionsResult: { extensions: [], errors: [], runtime: undefined as never },
				} as unknown as CreateAgentSessionResult;
			});

		const loader = new DefaultResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			settingsManager: Settings.isolated(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		// Fresh, unloaded loader — the shim MUST reload it before forwarding,
		// otherwise the SDK would receive an empty extensionsResult only by
		// accident of the constructor's default field, and any real discovery
		// arm not gated by an `no*` flag would silently escape.
		expect(loader.loaded).toBe(false);

		await legacyCreateAgentSession({ resourceLoader: loader });

		// The shim invoked the SDK exactly once — proves it did not fall back
		// to a "resourceLoader unrecognized, drop it" path.
		expect(spy).toHaveBeenCalledTimes(1);
		if (!captured) {
			throw new Error("Expected shim to forward session options to the SDK");
		}
		const forwarded = captured;

		// `resourceLoader` is not a field on `CreateAgentSessionOptions`; the
		// shim MUST strip it before delegating. Leaking it through would (a)
		// confuse anyone reading the SDK call site and (b) prove the shim is
		// not actually translating the option.
		expect("resourceLoader" in forwarded ? forwarded.resourceLoader : undefined).toBeUndefined();

		// The loader owns the event bus used while loading extensions. Forwarding
		// that same bus keeps extension event traffic on the session-visible bus
		// instead of marooning loader-created extensions on a private bus.
		expect(forwarded.eventBus).toBeDefined();

		// The reload's already-loaded extension snapshot is routed through
		// the SDK's `preloadedExtensions` seam. Skipping this branch is
		// exactly the bug the shim exists to prevent — the SDK would re-run
		// its own discovery inside the subagent and re-load the caller.
		expect(forwarded.preloadedExtensions).toBeDefined();
		expect(forwarded.preloadedExtensions?.extensions).toEqual([]);

		// The loader's captured `noSkills` / `noPromptTemplates` /
		// `noContextFiles` translate into empty arrays on the SDK options.
		// A `[]` here is meaningful: it overrides the SDK's default
		// (discover-from-filesystem) behavior, whereas `undefined` would let
		// the SDK re-scan and negate the caller's opt-out.
		expect(forwarded.skills).toEqual([]);
		expect(forwarded.promptTemplates).toEqual([]);
		expect(forwarded.contextFiles).toEqual([]);

		// `cwd`/`agentDir` fall through from the loader when the caller did
		// not override them — proves the shim doesn't accidentally re-derive
		// them from `getProjectDir()` inside the SDK, which would resolve to
		// the running test's cwd rather than the temp dir the loader owns.
		expect(forwarded.cwd).toBe(tmp);
		expect(forwarded.agentDir).toBe(tmp);
	});
});
