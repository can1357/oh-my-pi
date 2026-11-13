import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentsCommand } from "@oh-my-pi/pi-coding-agent/cli/agents-cli";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

describe("omp agents unpack", () => {
	let dir: string | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	it("keeps the inheritContext: false opt-out, since an unpacked agent overrides the bundled one", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-unpack-"));
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runAgentsCommand({ action: "unpack", flags: { dir, json: true } });
		for (const name of ["reviewer", "security-reviewer", "seance"]) {
			const { frontmatter } = parseFrontmatter(await Bun.file(path.join(dir, `${name}.md`)).text());
			expect(parseAgentFields(frontmatter)?.inheritContext).toBe(false);
		}
		const { frontmatter } = parseFrontmatter(await Bun.file(path.join(dir, "task.md")).text());
		expect(parseAgentFields(frontmatter)?.inheritContext).toBeUndefined();
	});
});
