/**
 * The bundled `builtin-skills` provider ships embedded markdown skills that have
 * no on-disk representation. These tests defend:
 *  - The bundled skills load via loadSkills() with embeddedContent set and hide falsy.
 *  - `disabledExtensions: ["skill:<name>"]` removes only that skill.
 *  - skill:// serves embedded content without touching disk.
 *  - skill://<name>/anything.md throws for embedded skills.
 *  - resolveSkillUrlToPath throws for embedded skills.
 *  - Priority 1 registration — user/project same-named skills win over builtins.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability";
import type { Skill as CapabilitySkill } from "@pk-nerdsaver-ai/pi-coding-agent/capability/skill";
import { BUILTIN_SKILLS_PROVIDER_ID, skillCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/skill";
import type { LoadContext } from "@pk-nerdsaver-ai/pi-coding-agent/capability/types";
import {
	loadSkills,
	resetActiveSkillsForTests,
	setActiveSkills,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import { resolveSkillUrlToPath } from "@pk-nerdsaver-ai/pi-coding-agent/tools/bash-skill-urls";
import { ToolError } from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-errors";

// Register all discovery providers as a side effect.
import "@pk-nerdsaver-ai/pi-coding-agent/discovery";

// ── Helpers ────────────────────────────────────────────────────────────────────

const BUILTIN_NAMES = ["agentic-mapreduce", "ompk-swarm-core", "promptbtw-handoff", "tree-of-thoughts"] as const;

/**
 * Hermetic loadSkills options: disable every filesystem-backed source so real
 * user/home skills on the machine cannot leak into assertions. Builtin
 * (embedded) skills stay enabled — they are what these tests defend.
 */
const ONLY_BUILTIN_SKILLS = {
	enableBuiltinSkills: true,
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
	environmentsCloudRoot: null,
} as const;

function builtinProvider() {
	const cap = getCapability(skillCapability.id);
	if (!cap) throw new Error("skills capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_SKILLS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-skills provider missing");
	return { cap, provider };
}

interface ProviderLoadResult {
	items: CapabilitySkill[];
}

async function loadBuiltinSkills(): Promise<ProviderLoadResult> {
	const { provider } = builtinProvider();
	const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	const fn = provider.load as (ctx: LoadContext) => Promise<ProviderLoadResult>;
	return await fn(ctx);
}

// ── Provider existence ─────────────────────────────────────────────────────────

describe("builtin-skills provider registration", () => {
	it("is registered in the skills capability at priority 1", () => {
		const { cap, provider } = builtinProvider();
		expect(provider).toBeDefined();
		expect(provider.priority).toBe(1);
		const others = cap.providers.filter(p => p.id !== BUILTIN_SKILLS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > 1)).toBe(true);
	});
});

// ── Provider-level loading ─────────────────────────────────────────────────────

describe("builtin-skills provider load", () => {
	it("loads exactly four items with the builtin-skills provider id", async () => {
		const result = await loadBuiltinSkills();
		expect(result.items.length).toBe(4);
		expect(result.items.every(s => s._source.provider === BUILTIN_SKILLS_PROVIDER_ID)).toBe(true);
	});

	it("parses frontmatter name and description correctly for all four skills", async () => {
		const result = await loadBuiltinSkills();
		for (const name of BUILTIN_NAMES) {
			const skill = result.items.find(s => s.name === name);
			expect(skill, `missing skill: ${name}`).toBeDefined();
			expect(typeof skill!.frontmatter?.description).toBe("string");
			expect(skill!.frontmatter!.description!.length).toBeGreaterThan(0);
		}
	});

	it("has virtual paths in the form builtin-skills:<name>/SKILL.md", async () => {
		const result = await loadBuiltinSkills();
		for (const name of BUILTIN_NAMES) {
			const skill = result.items.find(s => s.name === name);
			expect(skill!.path).toBe(`builtin-skills:${name}/SKILL.md`);
		}
	});

	it("has level 'user' for all skills", async () => {
		const result = await loadBuiltinSkills();
		expect(result.items.every(s => s.level === "user")).toBe(true);
	});
});

// ── loadSkills integration ─────────────────────────────────────────────────────

describe("loadSkills with builtin skills", () => {
	afterEach(() => {
		resetActiveSkillsForTests();
	});

	it("includes all four builtin skills with embeddedContent set and hide falsy", async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-test-"));
		try {
			const { skills } = await loadSkills({ cwd: tmpDir, ...ONLY_BUILTIN_SKILLS });
			for (const name of BUILTIN_NAMES) {
				const skill = skills.find(s => s.name === name);
				expect(skill, `missing skill: ${name}`).toBeDefined();
				expect(typeof skill!.embeddedContent).toBe("string");
				expect(skill!.embeddedContent!.length).toBeGreaterThan(0);
				expect(skill!.hide).toBeFalsy();
				expect(skill!.description.length).toBeGreaterThan(0);
			}
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("builtin-skills provider is priority 1 so higher-priority authored skills win name conflicts", async () => {
		// Verify the priority ordering: builtin-skills at priority 1 must be lower than
		// the agents provider (priority 5) so authored skills in agents dirs win.
		const { cap, provider } = builtinProvider();
		expect(provider.priority).toBe(1);
		// All other providers must have priority > 1
		const others = cap.providers.filter(p => p.id !== BUILTIN_SKILLS_PROVIDER_ID);
		expect(others.every(p => p.priority > 1)).toBe(true);
	});

	it('disabledExtensions: ["skill:agentic-mapreduce"] removes it while tree-of-thoughts stays', async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-disable-"));
		try {
			const { skills } = await loadSkills({
				cwd: tmpDir,
				...ONLY_BUILTIN_SKILLS,
				disabledExtensions: ["skill:agentic-mapreduce"],
			});
			expect(skills.find(s => s.name === "agentic-mapreduce")).toBeUndefined();
			const tot = skills.find(s => s.name === "tree-of-thoughts");
			expect(tot).toBeDefined();
			expect(tot!.embeddedContent).toBeDefined();
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

// ── skill:// protocol ───────────────────────────────────────────────────────────

describe("skill:// protocol for embedded skills", () => {
	afterEach(() => {
		resetActiveSkillsForTests();
	});

	it("resolves skill://tree-of-thoughts to embedded markdown without disk read", async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-protocol-"));
		try {
			const { skills } = await loadSkills({ cwd: tmpDir, ...ONLY_BUILTIN_SKILLS });
			setActiveSkills(skills);

			const tot = skills.find(s => s.name === "tree-of-thoughts");
			expect(tot).toBeDefined();
			expect(tot!.embeddedContent).toBeDefined();

			const resource = await InternalUrlRouter.instance().resolve("skill://tree-of-thoughts");
			expect(resource.content).toBe(tot!.embeddedContent!);
			expect(resource.contentType).toBe("text/markdown");
			expect(resource.size).toBe(Buffer.byteLength(tot!.embeddedContent!, "utf-8"));
			expect(resource.sourcePath).toBe("builtin-skills:tree-of-thoughts/SKILL.md");
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("resolves skill://agentic-mapreduce embedded content", async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-protocol2-"));
		try {
			const { skills } = await loadSkills({ cwd: tmpDir, ...ONLY_BUILTIN_SKILLS });
			setActiveSkills(skills);

			const skill = skills.find(s => s.name === "agentic-mapreduce");
			expect(skill!.embeddedContent).toBeDefined();
			const resource = await InternalUrlRouter.instance().resolve("skill://agentic-mapreduce");
			expect(resource.content).toBe(skill!.embeddedContent!);
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("resolves skill://promptbtw-handoff embedded content", async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-protocol3-"));
		try {
			const { skills } = await loadSkills({ cwd: tmpDir, ...ONLY_BUILTIN_SKILLS });
			setActiveSkills(skills);

			const skill = skills.find(s => s.name === "promptbtw-handoff");
			expect(skill!.embeddedContent).toBeDefined();
			expect(skill!.embeddedContent).toContain("Fable 5.1 auto-adaptation");
			const resource = await InternalUrlRouter.instance().resolve("skill://promptbtw-handoff");
			expect(resource.content).toBe(skill!.embeddedContent!);
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("skill://tree-of-thoughts/anything.md throws 'no auxiliary files' error", async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-protocol4-"));
		try {
			const { skills } = await loadSkills({ cwd: tmpDir, ...ONLY_BUILTIN_SKILLS });
			setActiveSkills(skills);

			await expect(InternalUrlRouter.instance().resolve("skill://tree-of-thoughts/anything.md")).rejects.toThrow(
				"embedded builtin skill has no auxiliary files",
			);
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

// ── resolveSkillUrlToPath ───────────────────────────────────────────────────────

describe("resolveSkillUrlToPath for embedded skills", () => {
	afterEach(() => {
		resetActiveSkillsForTests();
	});

	it("throws ToolError for embedded skill with a suggestion to use read tool", async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-bash-"));
		try {
			const { skills } = await loadSkills({ cwd: tmpDir, ...ONLY_BUILTIN_SKILLS });
			setActiveSkills(skills);

			const tot = skills.find(s => s.name === "tree-of-thoughts");
			expect(tot!.embeddedContent).toBeDefined();

			let err: unknown;
			try {
				resolveSkillUrlToPath("skill://tree-of-thoughts", skills);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(ToolError);
			const msg = (err as ToolError).message;
			expect(msg).toContain("embedded builtin skill");
			expect(msg).toContain("skill://tree-of-thoughts");
			expect(msg).toContain("read tool");
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
