/**
 * Reviewed package exclusions gate every route that can load or execute a package root.
 * The decision is a real `excludeReviewedResources` record over real package directories, so
 * these tests also prove the fail-open rule: changed contents on either reviewed copy keep both
 * visible.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { listOmpExtensionRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import {
	applyExclusionsToPreloadedPluginRoots,
	getPreloadedPluginRoots,
	injectPluginDirRoots,
	listClaudePluginRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { discoverExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { discoverCustomToolPaths } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { ResourceExclusions } from "@oh-my-pi/pi-coding-agent/discovery/resource-exclusions";
import { snapshotResource } from "@oh-my-pi/pi-coding-agent/extensibility/resource-snapshot";
import { excludeReviewedResources } from "@oh-my-pi/pi-coding-agent/extensibility/resource-decisions";
import { cfgUserResourceExclusions } from "@oh-my-pi/pi-coding-agent/extensibility/resource-settings";
import { getAgentDir, getProjectAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { filterUserScoped } from "./utils/filter-user-extensions";

const extensionCode = "export default function (pi) {}\n";

// Plugin providers have no toggle; only package roots reach the assertions below.
const noBuiltinSkillSources = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
};

describe("reviewed package exclusions in discovery", () => {
	let tempDir: TempDir;
	let cwd: string;
	let home: string;
	let extensionsDir: string;
	let keepRoot: string;
	let hideRoot: string;

	async function writePackage(root: string, body: string): Promise<void> {
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "index.ts"), body);
		await Bun.write(path.join(root, "tool.ts"), "export default function () {}\n");
	}

	/** Give each package one skill named after it. */
	async function writePackageSkills(): Promise<void> {
		for (const root of [keepRoot, hideRoot]) {
			const name = path.basename(root);
			await Bun.write(
				path.join(root, "skills", name, "SKILL.md"),
				`---\nname: ${name}\ndescription: Skill of ${name}\n---\nBody\n`,
			);
		}
	}

	/** Review two copies and keep the first (default: the extension packages); returns the live settings record. */
	async function reviewPair(
		settings = Settings.isolated({}),
		keep = keepRoot,
		hide = hideRoot,
		kind: "extension" | "skill" = "extension",
	) {
		const snapshots = await Promise.all(
			[keep, hide].map(async root =>
				snapshotResource({ id: root, label: path.basename(root), kind, root: await fs.realpath(root) }),
			),
		);
		await excludeReviewedResources(snapshots, snapshots[0].candidate.id, settings);
		return { settings, exclusions: cfgUserResourceExclusions.get(settings) };
	}

	const discoverNative = async (exclusions: ResourceExclusions) =>
		filterUserScoped(
			(await discoverExtensionPaths([], cwd, [], { ambient: true, resourceExclusions: exclusions })).map(p => ({
				path: p,
			})),
			[cwd],
		).map(entry => entry.path);

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-exclusion-gate-");
		cwd = tempDir.path();
		home = path.join(cwd, "home");
		await fs.mkdir(home, { recursive: true });
		extensionsDir = path.join(getProjectAgentDir(cwd), "extensions");
		keepRoot = path.join(extensionsDir, "keep-pkg");
		hideRoot = path.join(extensionsDir, "hide-pkg");
		await writePackage(keepRoot, extensionCode);
		await writePackage(hideRoot, extensionCode);
	});
	afterEach(async () => {
		await injectPluginDirRoots(home, [], cwd);
		resetSettingsForTest();
		tempDir.removeSync();
	});

	it("shows every copy when nothing was reviewed", async () => {
		expect(await discoverNative({})).toEqual(
			[path.join(keepRoot, "index.ts"), path.join(hideRoot, "index.ts")].sort(),
		);
	});

	it("stops the hidden copy's native extension module from loading and keeps the preferred one", async () => {
		const { exclusions } = await reviewPair();
		const paths = await discoverNative(exclusions);
		expect(paths).toContain(path.join(keepRoot, "index.ts"));
		expect(paths).not.toContain(path.join(hideRoot, "index.ts"));
	});

	it("hides one native extension file without suppressing its siblings or the extensions directory", async () => {
		const keepFile = path.join(extensionsDir, "keep.ts");
		const hideFile = path.join(extensionsDir, "hide.ts");
		await Bun.write(keepFile, extensionCode);
		await Bun.write(hideFile, "export default function (pi) { /* hide */ }\n");
		const { exclusions } = await reviewPair(undefined, keepFile, hideFile);
		expect(Object.keys(exclusions)).toEqual([await fs.realpath(hideFile)]);
		const paths = await discoverNative(exclusions);
		expect(paths).toContain(keepFile);
		expect(paths).not.toContain(hideFile);
		// Unreviewed packages in the same directory keep loading.
		expect(paths).toContain(path.join(keepRoot, "index.ts"));
		expect(paths).toContain(path.join(hideRoot, "index.ts"));
	});

	it("fails open when the hidden copy changed after review", async () => {
		const { exclusions } = await reviewPair();
		await Bun.write(path.join(hideRoot, "index.ts"), "export default function (pi) { /* updated */ }\n");
		expect(await discoverNative(exclusions)).toContain(path.join(hideRoot, "index.ts"));
	});

	it("fails open when the kept copy changed after review", async () => {
		const { exclusions } = await reviewPair();
		await Bun.write(path.join(keepRoot, "index.ts"), "export default function (pi) { /* updated */ }\n");
		expect(await discoverNative(exclusions)).toContain(path.join(hideRoot, "index.ts"));
	});

	it("fails open when the hidden copy is gone or unreadable", async () => {
		const { exclusions } = await reviewPair();
		await fs.rm(hideRoot, { recursive: true });
		expect(await discoverNative(exclusions)).toEqual([path.join(keepRoot, "index.ts")]);
	});

	it("honors a confirmed exclusion for both ambient and explicit-only loading", async () => {
		const { exclusions } = await reviewPair();
		const ambient = await discoverExtensionPaths([hideRoot], cwd, [], {
			ambient: true,
			resourceExclusions: exclusions,
		});
		expect(ambient).not.toContain(path.join(hideRoot, "index.ts"));
		const explicitOnly = await discoverExtensionPaths([hideRoot], cwd, [], {
			ambient: false,
			resourceExclusions: exclusions,
		});
		expect(explicitOnly).toEqual([]);
	});

	it("falls back to the global settings when no session value is supplied", async () => {
		const settings = await Settings.init({ inMemory: true, cwd });
		await reviewPair(settings);
		const paths = filterUserScoped(
			(await discoverExtensionPaths([], cwd, [], { ambient: true })).map(p => ({ path: p })),
			[cwd],
		).map(entry => entry.path);
		expect(paths).toContain(path.join(keepRoot, "index.ts"));
		expect(paths).not.toContain(path.join(hideRoot, "index.ts"));
	});

	it("removes a confirmed hidden package from both ambient and explicit sub-discovery", async () => {
		const { exclusions } = await reviewPair();
		const context = (mode: "merge" | "explicit-only") => ({
			cwd,
			home,
			repoRoot: null,
			extensionRoots: {
				explicit: [keepRoot, hideRoot],
				mode,
				configured: [],
				configuredLevel: "user" as const,
				resourceExclusions: exclusions,
			},
		});
		const names = async (mode: "merge" | "explicit-only") =>
			(await listOmpExtensionRoots(context(mode)))
				.map(root => path.basename(root.path))
				.filter(name => name.endsWith("-pkg"));
		expect(await names("merge")).toEqual(["keep-pkg"]);
		expect(await names("explicit-only")).toEqual(["keep-pkg"]);
	});

	it("removes a hidden marketplace or --plugin-dir root", async () => {
		const { exclusions } = await reviewPair();
		await injectPluginDirRoots(home, [keepRoot, hideRoot], cwd);
		const listed = await listClaudePluginRoots(home, cwd, exclusions);
		const names = listed.roots.map(root => path.basename(root.path)).filter(name => name.endsWith("-pkg"));
		expect(names).toEqual(["keep-pkg"]);
		const unfiltered = await listClaudePluginRoots(home, cwd, {});
		expect(
			unfiltered.roots
				.map(root => path.basename(root.path))
				.filter(name => name.endsWith("-pkg"))
				.sort(),
		).toEqual(["hide-pkg", "keep-pkg"]);
	});

	it("keeps a hidden package's skills out of skill discovery until the package changes", async () => {
		await writePackageSkills();
		for (const root of [keepRoot, hideRoot]) {
			await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: path.basename(root) }));
		}
		const { exclusions } = await reviewPair();
		const packageSkills = async () => {
			const { skills } = await loadSkills({
				...noBuiltinSkillSources,
				cwd,
				extensionRoots: {
					explicit: [keepRoot, hideRoot],
					mode: "merge",
					configured: [],
					configuredLevel: "user",
					resourceExclusions: exclusions,
				},
			});
			return skills
				.map(skill => skill.name)
				.filter(name => name.endsWith("-pkg"))
				.sort();
		};
		expect(await packageSkills()).toEqual(["keep-pkg"]);
		await Bun.write(
			path.join(hideRoot, "skills", "hide-pkg", "SKILL.md"),
			"---\nname: hide-pkg\ndescription: Updated\n---\nNew body\n",
		);
		expect(await packageSkills()).toEqual(["hide-pkg", "keep-pkg"]);
	});

	it("hides skills inside an excluded package however they are reached", async () => {
		await writePackageSkills();
		const { exclusions } = await reviewPair();
		const nativeSkills = path.join(getProjectAgentDir(cwd), "skills");
		await fs.mkdir(nativeSkills, { recursive: true });
		await fs.symlink(path.join(hideRoot, "skills", "hide-pkg"), path.join(nativeSkills, "linked-hide"));
		// Explicit-only roots: the package's skills arrive only through the routes below, not as a package root.
		const options = {
			...noBuiltinSkillSources,
			enablePiProject: true,
			cwd,
			extensionRoots: {
				explicit: [],
				mode: "explicit-only" as const,
				configured: [],
				configuredLevel: "user" as const,
			},
		};
		const names = async (resourceExclusions: ResourceExclusions, customDirectories: string[]) =>
			(await loadSkills({ ...options, customDirectories, resourceExclusions })).skills
				.map(skill => skill.name)
				.filter(name => name.endsWith("-pkg"))
				.sort();
		const custom = [path.join(hideRoot, "skills"), path.join(keepRoot, "skills")];
		expect(await names({}, custom)).toEqual(["hide-pkg", "keep-pkg"]);
		expect(await names(exclusions, custom)).toEqual(["keep-pkg"]);
		// The project skill directory reaches the hidden package only through a symlink.
		expect(await names({}, [])).toEqual(["hide-pkg"]);
		expect(await names(exclusions, [])).toEqual([]);
	});

	it("hides the reviewed provider skill directory and keeps its twin", async () => {
		const nativeDir = path.join(getProjectAgentDir(cwd), "skills", "gate-dup");
		const claudeDir = path.join(cwd, ".claude", "skills", "gate-dup");
		await Bun.write(path.join(nativeDir, "SKILL.md"), "---\nname: gate-dup\ndescription: Native copy\n---\nNative\n");
		await Bun.write(path.join(claudeDir, "SKILL.md"), "---\nname: gate-dup\ndescription: Claude copy\n---\nClaude\n");
		const { exclusions } = await reviewPair(undefined, claudeDir, nativeDir, "skill");
		const loaded = async (resourceExclusions: ResourceExclusions) =>
			(
				await loadSkills({
					...noBuiltinSkillSources,
					enablePiProject: true,
					enableClaudeProject: true,
					cwd,
					resourceExclusions,
				})
			).skills.filter(skill => skill.name.endsWith("gate-dup"));
		expect(await loaded({})).toHaveLength(2);
		const remaining = await loaded(exclusions);
		expect(await Promise.all(remaining.map(skill => fs.realpath(skill.filePath)))).toEqual([
			await fs.realpath(path.join(claudeDir, "SKILL.md")),
		]);
	});

	it("hides a reviewed managed skill", async () => {
		const originalAgentDir = getAgentDir();
		setAgentDir(path.join(cwd, "agent"));
		try {
			const managedDir = path.join(getManagedSkillsDir(), "gate-solo");
			const otherDir = path.join(cwd, "other-skills", "gate-other");
			await Bun.write(path.join(managedDir, "SKILL.md"), "---\nname: gate-solo\ndescription: Managed\n---\nBody\n");
			await Bun.write(path.join(otherDir, "SKILL.md"), "---\nname: gate-other\ndescription: Other\n---\nBody\n");
			const { exclusions } = await reviewPair(undefined, otherDir, managedDir, "skill");
			const names = async (resourceExclusions: ResourceExclusions) =>
				(
					await loadSkills({
						...noBuiltinSkillSources,
						cwd,
						customDirectories: [path.join(cwd, "other-skills")],
						resourceExclusions,
					})
				).skills
					.map(skill => skill.name)
					.filter(name => name.startsWith("gate-"))
					.sort();
			expect(await names({})).toEqual(["gate-other", "gate-solo"]);
			expect(await names(exclusions)).toEqual(["gate-other"]);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});

	it("keeps a hidden package's agents out of task discovery", async () => {
		for (const root of [keepRoot, hideRoot]) {
			await Bun.write(
				path.join(root, "agents", `${path.basename(root)}.md`),
				`---\nname: ${path.basename(root)}\ndescription: Agent\n---\nPrompt\n`,
			);
		}
		const { exclusions } = await reviewPair();
		const { searchedDirs } = await discoverAgents(cwd, home, {
			explicit: [keepRoot, hideRoot],
			mode: "merge",
			configured: [],
			configuredLevel: "user",
			resourceExclusions: exclusions,
		});
		expect(searchedDirs).toContain(path.join(keepRoot, "agents"));
		expect(searchedDirs).not.toContain(path.join(hideRoot, "agents"));
	});

	it("filters the synchronously preloaded plugin roots read by LSP/DAP config", async () => {
		const { exclusions } = await reviewPair();
		// Startup preloads before the session's settings exist, so nothing is filtered yet.
		await injectPluginDirRoots(home, [keepRoot, hideRoot], cwd);
		const names = () =>
			getPreloadedPluginRoots()
				.map(root => path.basename(root.path))
				.filter(name => name.endsWith("-pkg"));
		expect(names().sort()).toEqual(["hide-pkg", "keep-pkg"]);
		await applyExclusionsToPreloadedPluginRoots(exclusions);
		expect(names()).toEqual(["keep-pkg"]);
		// A later session whose decision no longer applies restores the hidden copy from the raw list.
		await applyExclusionsToPreloadedPluginRoots({});
		expect(names().sort()).toEqual(["hide-pkg", "keep-pkg"]);
	});

	it("keeps a hidden package's tool modules from loading", async () => {
		const settings = await Settings.init({ inMemory: true, cwd });
		await reviewPair(settings);
		const tools = await discoverCustomToolPaths(
			[path.join(keepRoot, "tool.ts"), path.join(hideRoot, "tool.ts")],
			cwd,
		);
		const paths = tools.map(tool => tool.path);
		expect(paths).toContain(path.join(keepRoot, "tool.ts"));
		expect(paths).not.toContain(path.join(hideRoot, "tool.ts"));
	});
});
