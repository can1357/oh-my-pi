import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAvailableThemesWithPaths, getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * `resources_discover` contract: skill, prompt-template, and theme paths returned by an
 * extension join discovery after `session_start`, a reload that drops them removes them,
 * and unusable paths surface as extension warnings without breaking the session.
 */
describe("extension resources_discover", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let authStorage!: AuthStorage;
	let registryAuthDir: string;

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `omp-resources-discover-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		authStorage = await discoverAuthStorage(registryAuthDir);
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(registryAuthDir);
	});

	/** Project dir holding one skill, one prompt template, and one theme under `ext/`. */
	function makeProject(): string {
		const dir = path.join(os.tmpdir(), `omp-resources-discover-${Snowflake.next()}`);
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, "ext", "skills", "ext-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "ext", "skills", "ext-skill", "SKILL.md"),
			"---\nname: ext-skill\ndescription: Skill contributed by resources_discover.\n---\nbody\n",
		);
		fs.mkdirSync(path.join(dir, "ext", "prompts"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "ext", "prompts", "ext-prompt.md"),
			"---\ndescription: Prompt contributed by resources_discover\n---\nReview $1 carefully.\n",
		);
		fs.mkdirSync(path.join(dir, "ext", "themes"), { recursive: true });
		fs.writeFileSync(path.join(dir, "ext", "themes", "ext-theme.json"), JSON.stringify(getBuiltinThemes().dark));
		return dir;
	}

	function sessionOptions(cwd: string): CreateAgentSessionOptions {
		return {
			cwd,
			agentDir: cwd,
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			// Only extension-contributed skills should be discoverable.
			settings: Settings.isolated({
				"skills.enableCodexUser": false,
				"skills.enableClaudeUser": false,
				"skills.enableClaudeProject": false,
				"skills.enablePiUser": false,
				"skills.enablePiProject": false,
				"skills.enableAgentsUser": false,
				"skills.enableAgentsProject": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		};
	}

	async function start(session: AgentSession): Promise<string[]> {
		const runner = session.extensionRunner;
		if (!runner) throw new Error("expected extension runner");
		const errors: string[] = [];
		runner.onError(error => {
			errors.push(`${error.event}: ${error.error}`);
		});
		await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
		return errors;
	}

	it("exposes contributed skills, prompts, and themes, and a reload that drops them removes them", async () => {
		const cwd = makeProject();
		const reasons: string[] = [];
		let contribute = true;
		const extension: ExtensionFactory = pi => {
			pi.on("resources_discover", event => {
				reasons.push(event.reason);
				if (!contribute) return {};
				return {
					// Relative paths resolve against the session cwd; the duplicate spellings collapse.
					skillPaths: ["ext/skills", "./ext/skills", path.join(cwd, "ext", "skills")],
					promptPaths: ["ext/prompts/ext-prompt.md"],
					themePaths: ["ext/themes"],
				};
			});
		};
		const { session } = await createAgentSession({ ...sessionOptions(cwd), extensions: [extension] });
		try {
			expect(session.skills.map(skill => skill.name)).not.toContain("ext-skill");

			const errors = await start(session);

			expect(errors).toEqual([]);
			expect(reasons).toEqual(["startup"]);
			const skill = session.skills.find(candidate => candidate.name === "ext-skill");
			expect(skill?.filePath).toBe(path.join(cwd, "ext", "skills", "ext-skill", "SKILL.md"));
			expect(session.skills.filter(candidate => candidate.name === "ext-skill")).toHaveLength(1);
			const template = session.promptTemplates.find(candidate => candidate.name === "ext-prompt");
			expect(template?.content).toContain("Review $1 carefully.");
			expect(await getAvailableThemesWithPaths()).toContainEqual({
				name: "ext-theme",
				path: path.join(cwd, "ext", "themes", "ext-theme.json"),
			});
			expect(await getThemeByName("ext-theme")).toBeDefined();

			contribute = false;
			await session.reload();

			expect(reasons).toEqual(["startup", "reload"]);
			expect(session.skills.map(candidate => candidate.name)).not.toContain("ext-skill");
			expect(session.promptTemplates.map(candidate => candidate.name)).not.toContain("ext-prompt");
			expect((await getAvailableThemesWithPaths()).map(theme => theme.name)).not.toContain("ext-theme");
			expect(await getThemeByName("ext-theme")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	for (const backing of ["in-memory", "file-backed"] as const) {
		it(`reload() on a ${backing} session re-runs discovery but keeps host-supplied slash commands`, async () => {
			const cwd = makeProject();
			const reasons: string[] = [];
			let contribute = true;
			const extension: ExtensionFactory = pi => {
				pi.on("resources_discover", event => {
					reasons.push(event.reason);
					return contribute ? { skillPaths: ["ext/skills"] } : {};
				});
			};
			const hostCommand = { name: "hostcmd", description: "Host command", content: "host", source: "host" };
			const { session } = await createAgentSession({
				...sessionOptions(cwd),
				sessionManager:
					backing === "in-memory"
						? SessionManager.inMemory(cwd)
						: SessionManager.create(cwd, path.join(cwd, "sessions")),
				slashCommands: [hostCommand],
				extensions: [extension],
			});
			try {
				await start(session);
				expect(session.skills.map(skill => skill.name)).toContain("ext-skill");
				if (backing === "file-backed") {
					await session.sessionManager.flush();
					expect(session.sessionFile).toBeDefined();
				} else {
					expect(session.sessionFile).toBeUndefined();
				}

				contribute = false;
				await session.reload();

				expect(reasons).toEqual(["startup", "reload"]);
				expect(session.skills.map(skill => skill.name)).not.toContain("ext-skill");
				// Disk/embedded command rediscovery would replace the host list (e.g. with `init`).
				expect(session.slashCommands.map(command => command.name)).toEqual(["hostcmd"]);
			} finally {
				await session.dispose();
			}
		});
	}

	it("does not run resources_discover in subagent sessions, which inherit the parent's resources", async () => {
		const cwd = makeProject();
		const reasons: string[] = [];
		const extension: ExtensionFactory = pi => {
			pi.on("resources_discover", event => {
				reasons.push(event.reason);
				return { skillPaths: ["ext/skills"], promptPaths: ["ext/prompts"] };
			});
		};
		const { session } = await createAgentSession({
			...sessionOptions(cwd),
			taskDepth: 1,
			parentTaskPrefix: "0-Parent",
			extensions: [extension],
		});
		try {
			await start(session);
			await session.refreshSkillsAndCommands();
			await session.reload();

			expect(reasons).toEqual([]);
			expect(session.skills.map(skill => skill.name)).not.toContain("ext-skill");
			expect(session.promptTemplates.map(template => template.name)).not.toContain("ext-prompt");
		} finally {
			await session.dispose();
		}
	});

	it("logs malformed handler entries even when the host registered no onError listener (ACP)", async () => {
		const cwd = makeProject();
		const extension: ExtensionFactory = pi => {
			pi.on("resources_discover", () => ({ skillPaths: "ext/skills" as unknown as string[] }));
		};
		const { session } = await createAgentSession({ ...sessionOptions(cwd), extensions: [extension] });
		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const warn = vi.spyOn(logger, "warn");

			const discovered = await runner.emitResourcesDiscover(cwd, "startup");

			expect(discovered.skillPaths).toEqual([]);
			expect(warn).toHaveBeenCalledWith(
				"resources_discover result entry skipped",
				expect.objectContaining({ message: "Ignoring skillPaths: expected an array of paths" }),
			);
		} finally {
			await session.dispose();
		}
	});

	it("warns about unusable paths and keeps the valid contributions", async () => {
		const cwd = makeProject();
		fs.writeFileSync(path.join(cwd, "ext", "notes.txt"), "not a skill");
		fs.mkdirSync(path.join(cwd, "bad-themes"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "bad-themes", "broken.json"), "{ not json");
		const extension: ExtensionFactory = pi => {
			pi.on("resources_discover", () => ({
				skillPaths: ["missing-skills", "ext/notes.txt", "ext/skills"],
				promptPaths: [42 as unknown as string, "ext/prompts"],
				themePaths: ["bad-themes", "ext/themes"],
			}));
		};
		const { session } = await createAgentSession({ ...sessionOptions(cwd), extensions: [extension] });
		try {
			const errors = await start(session);

			expect(errors).toEqual([
				expect.stringContaining("Ignoring promptPaths entry 42"),
				`resources_discover: skill path not found: ${path.join(cwd, "missing-skills")}`,
				`resources_discover: Ignoring skill path ${path.join(cwd, "ext", "notes.txt")}: expected a directory or a SKILL.md file`,
				expect.stringContaining(`Ignoring theme ${path.join(cwd, "bad-themes", "broken.json")}`),
			]);
			expect(session.skills.map(skill => skill.name)).toContain("ext-skill");
			expect(session.promptTemplates.map(template => template.name)).toContain("ext-prompt");
			expect((await getAvailableThemesWithPaths()).map(theme => theme.name)).toEqual(
				expect.arrayContaining(["ext-theme"]),
			);
			expect((await getAvailableThemesWithPaths()).map(theme => theme.name)).not.toContain("broken");
		} finally {
			await session.dispose();
		}
	});

	it("serves a legacy pi extension's contributions through the compat shim", async () => {
		const cwd = makeProject();
		const extensionPath = path.join(cwd, "pi-extension.ts");
		fs.writeFileSync(
			extensionPath,
			[
				'import { defineTool } from "@earendil-works/pi-coding-agent";',
				"export default function (pi) {",
				"\tif (typeof defineTool !== 'function') throw new Error('legacy shim missing');",
				'\tpi.on("resources_discover", async () => ({ skillPaths: ["ext/skills/ext-skill/SKILL.md"] }));',
				"}",
			].join("\n"),
		);
		const { session } = await createAgentSession({
			...sessionOptions(cwd),
			additionalExtensionPaths: [extensionPath],
		});
		try {
			const errors = await start(session);

			expect(errors).toEqual([]);
			expect(session.skills.map(skill => skill.name)).toContain("ext-skill");
		} finally {
			await session.dispose();
		}
	});

	/** Available theme name → file path, limited to `names`. */
	async function themeFiles(...names: string[]): Promise<Record<string, string | undefined>> {
		const available = await getAvailableThemesWithPaths();
		return Object.fromEntries(names.map(name => [name, available.find(info => info.name === name)?.path]));
	}

	it("keeps each session's themes when another live session registers themes or is disposed", async () => {
		const cwdA = makeProject();
		const cwdB = makeProject();
		const darkJson = JSON.stringify(getBuiltinThemes().dark);
		fs.writeFileSync(path.join(cwdA, "ext", "themes", "shared-theme.json"), darkJson);
		fs.writeFileSync(path.join(cwdB, "ext", "themes", "shared-theme.json"), darkJson);
		fs.writeFileSync(path.join(cwdB, "ext", "themes", "b-theme.json"), darkJson);
		const themesOf = (cwd: string, name: string) => path.join(cwd, "ext", "themes", `${name}.json`);
		let contributeB = false;
		const { session: sessionA } = await createAgentSession({
			...sessionOptions(cwdA),
			extensions: [pi => pi.on("resources_discover", () => ({ themePaths: ["ext/themes"] }))],
		});
		const { session: sessionB } = await createAgentSession({
			...sessionOptions(cwdB),
			extensions: [pi => pi.on("resources_discover", () => (contributeB ? { themePaths: ["ext/themes"] } : {}))],
		});
		try {
			await start(sessionA);
			await start(sessionB);
			expect(await themeFiles("ext-theme", "shared-theme", "b-theme")).toEqual({
				"ext-theme": themesOf(cwdA, "ext-theme"),
				"shared-theme": themesOf(cwdA, "shared-theme"),
				"b-theme": undefined,
			});

			contributeB = true;
			await sessionB.reload();
			// B's names join; a name both contribute stays with A, which registered first.
			expect(await themeFiles("ext-theme", "shared-theme", "b-theme")).toEqual({
				"ext-theme": themesOf(cwdA, "ext-theme"),
				"shared-theme": themesOf(cwdA, "shared-theme"),
				"b-theme": themesOf(cwdB, "b-theme"),
			});

			await sessionA.dispose();
			expect(await themeFiles("ext-theme", "shared-theme", "b-theme")).toEqual({
				"ext-theme": themesOf(cwdB, "ext-theme"),
				"shared-theme": themesOf(cwdB, "shared-theme"),
				"b-theme": themesOf(cwdB, "b-theme"),
			});

			await sessionB.dispose();
			expect(await themeFiles("ext-theme", "shared-theme", "b-theme")).toEqual({
				"ext-theme": undefined,
				"shared-theme": undefined,
				"b-theme": undefined,
			});
		} finally {
			await sessionA.dispose();
			await sessionB.dispose();
		}
	});

	it("ignores theme paths when the host opts out of themes (ACP)", async () => {
		const cwd = makeProject();
		const { session } = await createAgentSession({
			...sessionOptions(cwd),
			extensions: [
				pi =>
					pi.on("resources_discover", () => ({
						promptPaths: ["ext/prompts"],
						themePaths: ["ext/themes", "missing-themes"],
					})),
			],
		});
		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const errors: string[] = [];
			runner.onError(error => {
				errors.push(error.error);
			});

			await session.discoverExtensionResources({ themes: false });

			expect(session.promptTemplates.map(template => template.name)).toContain("ext-prompt");
			expect(await themeFiles("ext-theme")).toEqual({ "ext-theme": undefined });
			// Theme paths are not even resolved, so the missing one is not reported.
			expect(errors).toEqual([]);
		} finally {
			await session.dispose();
		}
	});

	it("tells contributed directories from files by their type, not their suffix", async () => {
		const cwd = makeProject();
		const odd = path.join(cwd, "odd");
		fs.mkdirSync(path.join(odd, "prompts.md"), { recursive: true });
		fs.writeFileSync(path.join(odd, "prompts.md", "dir-prompt.md"), "Prompt under a directory named like a file.\n");
		fs.mkdirSync(path.join(odd, "themes.json"), { recursive: true });
		fs.writeFileSync(path.join(odd, "themes.json", "dir-theme.json"), JSON.stringify(getBuiltinThemes().dark));
		fs.mkdirSync(path.join(odd, "SKILL.md", "dir-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(odd, "SKILL.md", "dir-skill", "SKILL.md"),
			"---\nname: dir-skill\ndescription: Skill under a directory named SKILL.md.\n---\nbody\n",
		);
		const { session } = await createAgentSession({
			...sessionOptions(cwd),
			extensions: [
				pi =>
					pi.on("resources_discover", () => ({
						skillPaths: ["odd/SKILL.md"],
						promptPaths: ["odd/prompts.md"],
						themePaths: ["odd/themes.json"],
					})),
			],
		});
		try {
			const errors = await start(session);

			expect(errors).toEqual([]);
			expect(session.skills.map(skill => skill.name)).toContain("dir-skill");
			expect(session.promptTemplates.map(template => template.name)).toContain("dir-prompt");
			expect(await themeFiles("dir-theme")).toEqual({
				"dir-theme": path.join(odd, "themes.json", "dir-theme.json"),
			});
		} finally {
			await session.dispose();
		}
	});

	it("skips BigInt and circular entries without dropping the rest of the round", async () => {
		const cwd = makeProject();
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;
		const { session } = await createAgentSession({
			...sessionOptions(cwd),
			extensions: [
				pi =>
					pi.on("resources_discover", () => ({
						promptPaths: [10n, circular, "ext/prompts"] as unknown as string[],
					})),
			],
		});
		try {
			const errors = await start(session);

			expect(errors).toEqual([
				"resources_discover: Ignoring promptPaths entry 10n: expected a non-empty path string",
				`resources_discover: Ignoring promptPaths entry { name: "loop", self: [Circular] }: expected a non-empty path string`,
			]);
			expect(session.promptTemplates.map(template => template.name)).toContain("ext-prompt");
		} finally {
			await session.dispose();
		}
	});

	it("reports unreadable contributed skill and prompt files as errors of the contributing extension", async () => {
		const cwd = makeProject();
		fs.mkdirSync(path.join(cwd, "ext", "skills", "bad-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, "ext", "skills", "bad-skill", "SKILL.md"),
			"---\nname: bad/skill\ndescription: Name with a path separator.\n---\nbody\n",
		);
		const lockedPrompt = path.join(cwd, "ext", "prompts", "locked.md");
		fs.writeFileSync(lockedPrompt, "Locked prompt.\n");
		const realFile = Bun.file.bind(Bun);
		vi.spyOn(Bun, "file").mockImplementation((source, options) => {
			const file = realFile(source as string, options);
			if (source === lockedPrompt) {
				file.text = () => Promise.reject(new Error("EACCES: permission denied"));
			}
			return file;
		});
		const { session } = await createAgentSession({
			...sessionOptions(cwd),
			extensions: [
				pi => pi.on("resources_discover", () => ({ skillPaths: ["ext/skills"], promptPaths: ["ext/prompts"] })),
			],
		});
		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const reported: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(error => {
				reported.push({ extensionPath: error.extensionPath, event: error.event, error: error.error });
			});

			await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });

			const [extensionPath] = runner.getExtensionPaths();
			expect(reported).toEqual([
				{
					extensionPath,
					event: "resources_discover",
					error: expect.stringContaining(`Failed to load prompt template ${lockedPrompt}: Error: EACCES`),
				},
				{
					extensionPath,
					event: "resources_discover",
					error: expect.stringContaining('Skill name "bad/skill" contains a path separator'),
				},
			]);
			expect(session.skills.map(skill => skill.name)).toContain("ext-skill");
			expect(session.promptTemplates.map(template => template.name)).toEqual(expect.arrayContaining(["ext-prompt"]));
			expect(session.promptTemplates.map(template => template.name)).not.toContain("locked");
		} finally {
			await session.dispose();
		}
	});

	it("re-emits resources_discover when a plugin is toggled in /settings", async () => {
		const cwd = makeProject();
		const reasons: string[] = [];
		const { session } = await createAgentSession({
			...sessionOptions(cwd),
			extensions: [
				pi =>
					pi.on("resources_discover", event => {
						reasons.push(event.reason);
						return {};
					}),
			],
		});
		try {
			await start(session);
			const ctx = {
				session,
				sessionManager: session.sessionManager,
				ui: { requestRender: vi.fn() },
			} as unknown as InteractiveModeContext;

			await new SelectorController(ctx).reloadAfterPluginToggle();

			expect(reasons).toEqual(["startup", "reload"]);
		} finally {
			await session.dispose();
		}
	});
});
