import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";

it.skipIf(process.platform === "win32")(
	"keeps skills in a literal backslash directory separate from a nested project",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-key-"));
		try {
			const literal = path.join(root, "a\\b");
			const nested = path.join(root, "a", "b");
			await fs.mkdir(literal);
			await fs.mkdir(nested, { recursive: true });
			const profile = path.join(root, "profile");
			const skill = path.join("example", "SKILL.md");
			await Bun.write(path.join(getProjectManagedSkillsDir(literal, profile), skill), "# Example\n");
			expect(await Bun.file(path.join(getProjectManagedSkillsDir(nested, profile), skill)).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
