import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	ENVIRONMENTS_CLOUD_ROOT_ENV,
	ENVIRONMENTS_CLOUD_SKILLS,
	ENVIRONMENTS_CLOUD_SOT,
	environmentsCloudSkillCustomDirectories,
	MESH_ENTRYPOINTS,
	MSI_ENVIRONMENTS_CLOUD_ROOT,
	PKS_ENVIRONMENTS_CLOUD_ROOT_ENV,
	resolveEnvironmentsCloudBinRoot,
	resolveEnvironmentsCloudRoot,
	resolveEnvironmentsCloudSkill,
	resolveEnvironmentsCloudSkillsRoot,
	resolveMeshHandoff,
	summarizeEnvironmentsCloudRoute,
} from "../src/environments-cloud";

describe("environments-cloud root resolution", () => {
	test("defaults to MSI-local canonical root when env is empty", () => {
		const root = resolveEnvironmentsCloudRoot({ env: {} });
		expect(root).toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
		expect(root).toBe("C:\\dev\\desktop-infra\\environments-cloud");
	});

	test("honors OMPK_ENVIRONMENTS_CLOUD_ROOT over MSI default", () => {
		const override = path.join("D:", "tmp", "envs-cloud-fixture");
		const root = resolveEnvironmentsCloudRoot({
			env: { [ENVIRONMENTS_CLOUD_ROOT_ENV]: override },
		});
		expect(root).toBe(path.resolve(override));
		expect(root).not.toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
	});

	test("honors PKS_ENVIRONMENTS_CLOUD_ROOT when OMPK override unset", () => {
		const override = path.join("E:", "pks", "cloud");
		const root = resolveEnvironmentsCloudRoot({
			env: { [PKS_ENVIRONMENTS_CLOUD_ROOT_ENV]: override },
		});
		expect(root).toBe(path.resolve(override));
	});

	test("OMPK override wins over PKS override", () => {
		const ompk = path.join("D:", "ompk-root");
		const pks = path.join("E:", "pks-root");
		const root = resolveEnvironmentsCloudRoot({
			env: {
				[ENVIRONMENTS_CLOUD_ROOT_ENV]: ompk,
				[PKS_ENVIRONMENTS_CLOUD_ROOT_ENV]: pks,
			},
		});
		expect(root).toBe(path.resolve(ompk));
	});

	test("explicit root option wins over env", () => {
		const explicit = path.join("F:", "explicit-root");
		const root = resolveEnvironmentsCloudRoot({
			root: explicit,
			env: { [ENVIRONMENTS_CLOUD_ROOT_ENV]: path.join("D:", "ignored") },
		});
		expect(root).toBe(path.resolve(explicit));
	});

	test("blank override falls back to MSI root", () => {
		const root = resolveEnvironmentsCloudRoot({
			env: { [ENVIRONMENTS_CLOUD_ROOT_ENV]: "   " },
		});
		expect(root).toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
	});
});

describe("session/skill routing", () => {
	test("skills root is .agents/skills under environments-cloud", () => {
		const skillsRoot = resolveEnvironmentsCloudSkillsRoot({ env: {} });
		expect(skillsRoot).toBe(path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "skills"));
	});

	test("customDirectories entry points at environments-cloud skills", () => {
		const dirs = environmentsCloudSkillCustomDirectories({ env: {} });
		expect(dirs).toEqual([path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "skills")]);
	});

	test("mesh-orchestrator skill route resolves under environments-cloud", () => {
		const route = resolveEnvironmentsCloudSkill("mesh-orchestrator", { env: {} });
		expect(route.root).toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
		expect(route.skillName).toBe("mesh-orchestrator");
		expect(route.known).toBe(true);
		expect(route.skillDir).toBe(path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "skills", "mesh-orchestrator"));
		expect(route.skillMd).toBe(
			path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "skills", "mesh-orchestrator", "SKILL.md"),
		);
		expect(route.skillMd.endsWith(`${path.sep}SKILL.md`)).toBe(true);
	});

	test("colab-warmup skill route is known", () => {
		const route = resolveEnvironmentsCloudSkill("colab-warmup", { env: {} });
		expect(route.known).toBe(true);
		expect(route.skillDir).toContain("colab-warmup");
	});

	test("unknown skill name still routes under skills root", () => {
		const route = resolveEnvironmentsCloudSkill("future-mesh-skill", { env: {} });
		expect(route.known).toBe(false);
		expect(route.skillDir).toBe(path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "skills", "future-mesh-skill"));
	});

	test("empty skill name is rejected", () => {
		expect(() => resolveEnvironmentsCloudSkill("  ", { env: {} })).toThrow(/non-empty/);
	});

	test("override root relocates skill routes", () => {
		const root = path.join("G:", "cloud-sot");
		const route = resolveEnvironmentsCloudSkill("mesh-orchestrator", { root });
		expect(route.root).toBe(path.resolve(root));
		expect(route.skillMd).toBe(path.join(path.resolve(root), ".agents", "skills", "mesh-orchestrator", "SKILL.md"));
	});
});

describe("mesh handoff for auth/cloud/codespace-style flows", () => {
	test("mesh status handoff targets environments-cloud bin", () => {
		const handoff = resolveMeshHandoff("mesh", ["status"], { env: {}, platform: "win32" });
		expect(handoff.root).toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
		expect(handoff.entrypoint).toBe("mesh");
		expect(handoff.cwd).toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
		expect(handoff.binPath).toBe(path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "bin", "mesh.cmd"));
		expect(handoff.scriptPath).toBe(path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "bin", "mesh.py"));
		expect(handoff.argv).toEqual([handoff.binPath, "status"]);
		expect(handoff.purpose).toMatch(/status|routing|warmup/i);
	});

	test("cloud status handoff is the auth/status entrypoint", () => {
		const handoff = resolveMeshHandoff("cloud", ["status"], { env: {}, platform: "win32" });
		expect(handoff.entrypoint).toBe("cloud");
		expect(handoff.binPath.endsWith("cloud.cmd")).toBe(true);
		expect(handoff.purpose).toMatch(/auth|status|cloud/i);
		expect(handoff.argv).toEqual([handoff.binPath, "status"]);
	});

	test("mesh-run handoff is codespace-style remote dispatch", () => {
		const handoff = resolveMeshHandoff("mesh-run", ["--node", "mac", "--", "npm", "test"], {
			env: {},
			platform: "win32",
		});
		expect(handoff.entrypoint).toBe("mesh-run");
		expect(handoff.purpose).toMatch(/codespace|dispatch|remote/i);
		expect(handoff.argv).toEqual([handoff.binPath, "--node", "mac", "--", "npm", "test"]);
	});

	test("non-win32 handoff uses python3 + .py script", () => {
		const handoff = resolveMeshHandoff("mesh", ["status"], { env: {}, platform: "linux" });
		expect(handoff.binPath.endsWith("mesh.py")).toBe(true);
		expect(handoff.argv[0]).toBe("python3");
		expect(handoff.argv[1]).toBe(handoff.scriptPath);
		expect(handoff.argv[2]).toBe("status");
	});

	test("unknown entrypoint is rejected with known list", () => {
		expect(() => resolveMeshHandoff("not-a-tool", [], { env: {} })).toThrow(/Unknown mesh entrypoint/);
		expect(() => resolveMeshHandoff("not-a-tool", [], { env: {} })).toThrow(/mesh-run/);
	});

	test("bin root is .agents/bin under resolved root", () => {
		expect(resolveEnvironmentsCloudBinRoot({ env: {} })).toBe(
			path.join(MSI_ENVIRONMENTS_CLOUD_ROOT, ".agents", "bin"),
		);
	});

	test("every declared entrypoint resolves without throw", () => {
		for (const name of Object.keys(MESH_ENTRYPOINTS)) {
			const handoff = resolveMeshHandoff(name, [], { env: {}, platform: "win32" });
			expect(handoff.binPath.includes(".agents")).toBe(true);
			expect(handoff.binPath.includes("bin")).toBe(true);
		}
	});
});

describe("route summary contract", () => {
	test("summary names pkscloudenvs SoT and MSI root, not local Docker as mesh", () => {
		const summary = summarizeEnvironmentsCloudRoute({ env: {} });
		expect(summary.root).toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
		expect(summary.sot).toEqual(ENVIRONMENTS_CLOUD_SOT);
		expect(summary.sot.github).toContain("pkscloudenvs");
		expect(summary.sot.msiCanonicalRoot).toBe(MSI_ENVIRONMENTS_CLOUD_ROOT);
		expect(summary.skills.map(s => s.skillName)).toEqual([...ENVIRONMENTS_CLOUD_SKILLS]);
		expect(summary.skillCustomDirectories[0]).toContain(".agents");
		expect(summary.localSandboxNote).toMatch(/local sandboxes only/i);
		expect(summary.localSandboxNote).toMatch(/environments-cloud|pkscloudenvs/i);
		expect(summary.entrypoints).toContain("mesh");
		expect(summary.entrypoints).toContain("cloud");
		expect(summary.entrypoints).toContain("mesh-run");
	});
});
