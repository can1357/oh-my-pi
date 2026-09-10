import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("config.yml comment preservation on model-role writes (#11477)", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-config-comments-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await tempDir?.remove();
	});

	const HAND_MAINTAINED = `modelRoles:
  default: anthropic/claude-fable-5-1:xhigh # daily driver
# Deny floor (keep in step with the other profile)
bash:
  patterns:
    - match: "git push --force*"
      approval: deny
defaultThinkingLevel: high
`;

	it("preserves comments, quoting, and the trailing newline when adding a global role", async () => {
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, HAND_MAINTAINED);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
		await settings.flush();

		const after = await Bun.file(configPath).text();

		// Only the intended change landed.
		expect(after).toContain("smol: anthropic/claude-haiku-4-5");
		expect(after).toContain("default: anthropic/claude-fable-5-1:xhigh");
		// Everything else survives verbatim.
		expect(after).toContain("# daily driver");
		expect(after).toContain("# Deny floor (keep in step with the other profile)");
		expect(after).toContain('- match: "git push --force*"');
		expect(after).toContain("defaultThinkingLevel: high");
		expect(after.endsWith("\n")).toBe(true);
	});

	it("preserves surrounding comments when clearing a global role", async () => {
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(
			configPath,
			`modelRoles:
  default: anthropic/claude-fable-5-1
  smol: anthropic/claude-haiku-4-5 # cheap tier
# keep this note
defaultThinkingLevel: high
`,
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setModelRole("smol", undefined);
		await settings.flush();

		const after = await Bun.file(configPath).text();
		expect(after).not.toContain("smol:");
		expect(after).toContain("default: anthropic/claude-fable-5-1");
		expect(after).toContain("# keep this note");
		expect(after).toContain("defaultThinkingLevel: high");
		expect(after.endsWith("\n")).toBe(true);
	});

	it("preserves comments on a non-role setting write", async () => {
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(
			configPath,
			`# top comment
theme:
  dark: anthracite # my theme
defaultThinkingLevel: high
`,
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.set("theme.dark", "titanium");
		await settings.flush();

		const after = await Bun.file(configPath).text();
		expect(after).toContain("# top comment");
		expect(after).toContain("dark: titanium");
		expect(after).toContain("# my theme");
		expect(after).toContain("defaultThinkingLevel: high");
	});

	it("still writes a well-formed config when no prior file exists", async () => {
		const configPath = path.join(agentDir, "config.yml");
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
		await settings.flush();

		const after = await Bun.file(configPath).text();
		expect(after).toContain("modelRoles:");
		expect(after).toContain("smol: anthropic/claude-haiku-4-5");
		expect(after.endsWith("\n")).toBe(true);
	});

	it("preserves four-space indentation on untouched blocks", async () => {
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(
			configPath,
			`modelRoles:
    default: anthropic/claude-fable-5-1:xhigh
# deny floor
bash:
    patterns:
        - match: "git push --force*"
          approval: deny
`,
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
		await settings.flush();

		const after = await Bun.file(configPath).text();
		// New key adopts the file's own 4-space step; untouched blocks keep theirs.
		expect(after).toContain("\n    default: anthropic/claude-fable-5-1:xhigh");
		expect(after).toContain("\n    smol: anthropic/claude-haiku-4-5");
		expect(after).toContain("\n    patterns:");
		expect(after).toContain('\n        - match: "git push --force*"');
		expect(after).toContain("# deny floor");
		expect(after).not.toContain("\n  default:");
	});

	it("detects 4-space step structurally despite a shallower-indented block scalar", async () => {
		const configPath = path.join(agentDir, "config.yml");
		// The block scalar's body is indented 2 spaces — less than the 4-space
		// mapping step. A whitespace-minimum detector would pick 2 and reflow the
		// maps; structural detection reads the step from the nested map node.
		await Bun.write(
			configPath,
			`shellPath: |
  echo hi
  echo bye
modelRoles:
    default: anthropic/claude-fable-5-1
`,
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
		await settings.flush();

		const after = await Bun.file(configPath).text();
		expect(after).toContain("\n    default: anthropic/claude-fable-5-1");
		expect(after).toContain("\n    smol: anthropic/claude-haiku-4-5");
		expect(after).not.toContain("\n  default:");
		expect(after).not.toContain("\n  smol:");
		// Block scalar content is retained (its body reindents to the document step).
		expect(after).toContain("echo hi");
		expect(after).toContain("echo bye");
	});

	it("persists a role write against an aliased modelRoles mapping without throwing", async () => {
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(
			configPath,
			`roles: &roles
  default: anthropic/claude-fable-5-1
modelRoles: *roles
defaultThinkingLevel: high
`,
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
		await settings.flush();

		// The aliased branch is dereferenced to a concrete map so the write
		// succeeds (the old alias node would make setIn throw).
		const after = await Bun.file(configPath).text();
		const parsed = YAML.parse(after) as { modelRoles: Record<string, string> };
		expect(parsed.modelRoles.default).toBe("anthropic/claude-fable-5-1");
		expect(parsed.modelRoles.smol).toBe("anthropic/claude-haiku-4-5");
		expect(after).toContain("defaultThinkingLevel: high");
	});
});
