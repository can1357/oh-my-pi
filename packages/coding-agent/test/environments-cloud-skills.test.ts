import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import {
	ENVIRONMENTS_CLOUD_ROOT_ENV,
	MSI_ENVIRONMENTS_CLOUD_ROOT,
	mergeEnvironmentsCloudSkillDirectories,
	PKS_ENVIRONMENTS_CLOUD_ROOT_ENV,
	resolveEnvironmentsCloudRoot,
	resolveEnvironmentsCloudSkillsRoot,
	resolvePresentEnvironmentsCloudSkillDirectories,
} from "../src/config/environments-cloud-skills";
import { loadSkills } from "../src/extensibility/skills";

const DISABLE_ALL_BUILTIN_SKILLS = {
	enableBuiltinSkills: false,
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

const tempRoots: string[] = [];

afterEach(async () => {
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop();
		if (dir) await removeWithRetries(dir);
	}
});

async function makeCloudSkillsFixture(skillName: string, description: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-cloud-skills-"));
	tempRoots.push(root);
	const skillDir = path.join(root, ".agents", "skills", skillName);
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(
		path.join(skillDir, "SKILL.md"),
		["---", `description: ${description}`, "---", "", `# ${skillName}`].join("\n"),
	);
	return root;
}

describe("environments-cloud skill root resolution", () => {
	it("defaults to the MSI-local canonical root", () => {
		const root = resolveEnvironmentsCloudRoot({ env: {} });
		expect(root).toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
		expect(root).toBe("C:\\dev\\desktop-infra\\environments-cloud");
	});

	it("honors OMPK_ENVIRONMENTS_CLOUD_ROOT", () => {
		const override = path.join("D:", "fixture-cloud");
		expect(resolveEnvironmentsCloudRoot({ env: { [ENVIRONMENTS_CLOUD_ROOT_ENV]: override } })).toBe(
			path.resolve(override),
		);
	});

	it("honors PKS override when OMPK unset", () => {
		const override = path.join("E:", "pks-cloud");
		expect(resolveEnvironmentsCloudRoot({ env: { [PKS_ENVIRONMENTS_CLOUD_ROOT_ENV]: override } })).toBe(
			path.resolve(override),
		);
	});

	it("skills root is .agents/skills under the cloud root", () => {
		expect(resolveEnvironmentsCloudSkillsRoot({ env: {} })).toBe(
			path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "skills"),
		);
	});

	it("merge appends auto dirs without duplicating configured paths", () => {
		const configured = [path.join("C:", "custom", "skills")];
		const auto = [path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "skills"), path.join("C:", "custom", "skills")];
		const merged = mergeEnvironmentsCloudSkillDirectories(configured, auto);
		expect(merged).toHaveLength(2);
		expect(merged[0]).toBe(configured[0]);
		expect(merged[1]).toContain("environments-cloud");
	});

	it("resolvePresent returns skills root only when directory exists", async () => {
		const root = await makeCloudSkillsFixture("mesh-orchestrator", "Mesh routing skill");
		const present = await resolvePresentEnvironmentsCloudSkillDirectories({ root });
		expect(present).toEqual([path.join(root, ".agents", "skills")]);

		const missing = await resolvePresentEnvironmentsCloudSkillDirectories({
			root: path.join(os.tmpdir(), "definitely-missing-env-cloud-xyz"),
		});
		expect(missing).toEqual([]);
	});
});

describe("loadSkills environments-cloud session routing", () => {
	it("auto-loads mesh skills from environments-cloud when checkout is present", async () => {
		const root = await makeCloudSkillsFixture("mesh-orchestrator", "Unified mesh orchestrator for MSI-1");
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-cwd-"));
		tempRoots.push(cwd);
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			cwd,
			environmentsCloudRoot: root,
			customDirectories: [],
		});
		const mesh = skills.find(s => s.name === "mesh-orchestrator");
		expect(mesh).toBeDefined();
		expect(mesh?.filePath).toBe(path.join(root, ".agents", "skills", "mesh-orchestrator", "SKILL.md"));
		expect(mesh?.source).toBe("custom:user");
	});

	it("skips environments-cloud auto-routing when environmentsCloudRoot is null", async () => {
		const root = await makeCloudSkillsFixture("mesh-orchestrator", "Unified mesh orchestrator for MSI-1");
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-cwd-"));
		tempRoots.push(cwd);
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			cwd,
			environmentsCloudRoot: null,
			customDirectories: [],
		});
		expect(skills.some(s => s.name === "mesh-orchestrator")).toBe(false);
		expect(await fs.stat(path.join(root, ".agents", "skills", "mesh-orchestrator", "SKILL.md"))).toBeTruthy();
	});
});
