/**
 * Manifest-declared skill directories for `omp` extension packages (PR #9379).
 *
 * An extension package may declare `omp.skills` (or legacy `pi.skills`) in its
 * `package.json`. Those directories replace the conventional `skills/` sub-tree
 * for that package, may point directly at a single skill directory, and are
 * subject to plugin-root containment — including for the one-level namespace
 * descent, which must prove containment before enumerating.
 *
 * The provider is invoked directly so the `LoadContext` uses a tempdir as
 * `home` instead of `os.homedir()`. Module-level CLI injection state is
 * reset between cases so they cannot poison each other.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { LoadContext, Provider } from "@oh-my-pi/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const PROVIDER_ID = "omp-plugins";

let tempDir: string;
let home: string;
let project: string;
let ext: string;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function pluginProvider(capabilityId: string): Provider<unknown> {
	const cap = getCapability(capabilityId);
	if (!cap) throw new Error(`capability ${capabilityId} missing`);
	const provider = cap.providers.find(p => p.id === PROVIDER_ID);
	if (!provider) throw new Error(`provider ${PROVIDER_ID} not registered for ${capabilityId}`);
	return provider as Provider<unknown>;
}

async function loadFromPlugin<T>(capabilityId: string, ctx: LoadContext): Promise<T[]> {
	const result = await pluginProvider(capabilityId).load(ctx);
	return result.items as T[];
}

/** Baseline package: a conventional `skills/my-skill` the manifest cases replace. */
function buildExtensionPackage(packageDir: string, skillName = "my-skill"): void {
	writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: path.basename(packageDir), omp: { extensions: ["./src/main.ts"] } }),
	);
	writeFile(path.join(packageDir, "src", "main.ts"), "export default function (_pi) {}\n");
	writeFile(
		path.join(packageDir, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: Hello from extension skill\n---\nbody\n`,
	);
}

beforeEach(() => {
	clearCache();
	clearOmpExtensionCliRoots();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-plugins-manifest-skills-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	ext = path.join(tempDir, "my-extension");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	buildExtensionPackage(ext);
	setAgentDir(path.join(home, ".omp", "agent"));
});

afterEach(() => {
	clearCache();
	clearOmpExtensionCliRoots();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(tempDir);
});

function ctx(): LoadContext {
	return { cwd: project, home, repoRoot: project };
}

test("omp manifest skills directories replace the conventional skills directory", async () => {
	writeFile(
		path.join(ext, "package.json"),
		JSON.stringify({
			name: path.basename(ext),
			omp: { extensions: ["./src/main.ts"], skills: ["./.opencode/skills"] },
		}),
	);
	writeFile(
		path.join(ext, ".opencode", "skills", "manifest-skill", "SKILL.md"),
		"---\nname: manifest-skill\ndescription: Hello from manifest skill\n---\nbody\n",
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(skill => skill.name)).toContain("manifest-skill");
	expect(skills.map(skill => skill.name)).not.toContain("my-skill");
});

test("omp manifest skills entry pointing directly at a skill directory is loaded", async () => {
	writeFile(
		path.join(ext, "package.json"),
		JSON.stringify({
			name: path.basename(ext),
			omp: { extensions: ["./src/main.ts"], skills: ["./skills/direct-skill"] },
		}),
	);
	writeFile(
		path.join(ext, "skills", "direct-skill", "SKILL.md"),
		"---\nname: direct-skill\ndescription: Hello from a directly-declared skill dir\n---\nbody\n",
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(skill => skill.name)).toContain("direct-skill");
});

test("manifest skills directories outside the plugin root are rejected", async () => {
	const outsideSkills = path.join(tempDir, "outside-skills");
	writeFile(
		path.join(ext, "package.json"),
		JSON.stringify({
			name: path.basename(ext),
			omp: { extensions: ["./src/main.ts"], skills: ["../outside-skills"] },
		}),
	);
	writeFile(
		path.join(outsideSkills, "escaped-skill", "SKILL.md"),
		"---\nname: escaped-skill\ndescription: Outside plugin root\n---\nbody\n",
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(skill => skill.name)).not.toContain("escaped-skill");
});

test("a directly-declared skill directory is a leaf: nested fixture SKILL.md files stay invisible", async () => {
	writeFile(
		path.join(ext, "package.json"),
		JSON.stringify({
			name: path.basename(ext),
			omp: { extensions: ["./src/main.ts"], skills: ["./skills/leaf-skill"] },
		}),
	);
	writeFile(
		path.join(ext, "skills", "leaf-skill", "SKILL.md"),
		"---\nname: leaf-skill\ndescription: The declared skill itself\n---\nbody\n",
	);
	// Internal fixture nested inside the skill — must not surface as a skill.
	writeFile(
		path.join(ext, "skills", "leaf-skill", "examples", "demo", "SKILL.md"),
		"---\nname: demo\ndescription: Fixture inside the skill\n---\nbody\n",
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	const names = skills.map(skill => skill.name);
	expect(names).toContain("leaf-skill");
	expect(names).not.toContain("demo");
	expect(names).not.toContain("examples");
});

test("a child skill symlinked outside the plugin root is rejected by containment", async () => {
	const outside = path.join(tempDir, "outside-linked-skill");
	writeFile(
		path.join(outside, "SKILL.md"),
		"---\nname: outside-linked-skill\ndescription: Lives outside the plugin\n---\nbody\n",
	);
	writeFile(
		path.join(ext, "package.json"),
		JSON.stringify({
			name: path.basename(ext),
			omp: { extensions: ["./src/main.ts"], skills: ["./skills"] },
		}),
	);
	writeFile(
		path.join(ext, "skills", "inside-skill", "SKILL.md"),
		"---\nname: inside-skill\ndescription: Legitimately contained\n---\nbody\n",
	);
	fs.symlinkSync(outside, path.join(ext, "skills", "sneaky-link"), "dir");
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	const names = skills.map(skill => skill.name);
	expect(names).toContain("inside-skill");
	expect(names).not.toContain("outside-linked-skill");
	expect(names).not.toContain("sneaky-link");
});

test("a namespace symlink pointing outside the plugin root is rejected before enumeration (PR #9379 round-7 review)", async () => {
	// An external COLLECTION (no top-level SKILL.md): reached only through the
	// one-level namespace descent, which must prove containment BEFORE the
	// readdir that would otherwise traverse the external tree. Pre-fix the
	// external skills were already blocked per-candidate, so the observable
	// contract here is the namespace-level rejection warning (fail-closed
	// before enumeration) replacing silent per-file traversal.
	const outsideCollection = path.join(tempDir, "outside-collection");
	writeFile(
		path.join(outsideCollection, "escaped-ns-skill", "SKILL.md"),
		"---\nname: escaped-ns-skill\ndescription: Reached only through a namespace symlink\n---\nbody\n",
	);
	writeFile(
		path.join(ext, "package.json"),
		JSON.stringify({
			name: path.basename(ext),
			omp: { extensions: ["./src/main.ts"], skills: ["./skills"] },
		}),
	);
	writeFile(
		path.join(ext, "skills", "inside-skill", "SKILL.md"),
		"---\nname: inside-skill\ndescription: Legitimately contained\n---\nbody\n",
	);
	fs.symlinkSync(outsideCollection, path.join(ext, "skills", "sneaky-namespace"), "dir");
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const result = await pluginProvider(skillCapability.id).load(ctx());
	const names = (result.items as Array<{ name: string }>).map(skill => skill.name);
	expect(names).toContain("inside-skill");
	expect(names).not.toContain("escaped-ns-skill");
	expect(result.warnings ?? []).toContainEqual(
		expect.stringContaining("Skipping skill namespace outside the plugin root"),
	);
});

test("legacy pi manifest skills directories replace the conventional skills directory", async () => {
	writeFile(
		path.join(ext, "package.json"),
		JSON.stringify({
			name: path.basename(ext),
			pi: { extensions: ["./src/main.ts"], skills: ["./.opencode/skills"] },
		}),
	);
	writeFile(
		path.join(ext, ".opencode", "skills", "legacy-skill", "SKILL.md"),
		"---\nname: legacy-skill\ndescription: Hello from legacy manifest skill\n---\nbody\n",
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(skill => skill.name)).toContain("legacy-skill");
	expect(skills.map(skill => skill.name)).not.toContain("my-skill");
});
