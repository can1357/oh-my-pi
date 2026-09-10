import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

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
});
