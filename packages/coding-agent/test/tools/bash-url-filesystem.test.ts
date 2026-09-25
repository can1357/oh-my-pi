import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

let tempDir: string;
let localRoot: string;
let session: ToolSession;

beforeEach(async () => {
	tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-url-fs-")));
	const localProtocolOptions = { getArtifactsDir: () => tempDir, getSessionId: () => "bash-url-fs" };
	localRoot = resolveLocalRoot(localProtocolOptions);
	session = {
		cwd: tempDir,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		localProtocolOptions,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function run(command: string, cwd?: string): Promise<{ text: string; isError: boolean | undefined }> {
	const result = await new BashTool(session).execute("call", { command, ...(cwd ? { cwd } : {}) });
	return { text: result.content.find(c => c.type === "text")?.text ?? "", isError: result.isError };
}

describe("bash internal URLs through the shell filesystem", () => {
	it("resolves variable-composed URLs and redirections at access time, leaving literal text alone", async () => {
		const { text, isError } = await run(
			`scheme=local; printf 'hi\\n' > "$scheme://out.txt"; printf 'more\\n' >> local://out.txt; cat local://out.txt; echo 'local://out.txt'`,
		);

		expect(isError).toBeUndefined();
		expect(text).toContain("hi\nmore\n");
		expect(text).toContain("local://out.txt");
		expect(await fs.readFile(path.join(localRoot, "out.txt"), "utf-8")).toBe("hi\nmore\n");
	});

	it("follows URL symlinks and resolves backed URLs to their physical path", async () => {
		const { text, isError } = await run(
			"printf 'body\\n' > local://source.txt && ln -s local://source.txt local://link && cat local://link && readlink local://link && realpath local://link",
		);

		const physical = await fs.realpath(path.join(localRoot, "source.txt"));
		expect(isError).toBeUndefined();
		expect(text).toContain(`body\n${physical}\n${physical}`);
		expect(await fs.readlink(path.join(localRoot, "link"))).toBe("local://source.txt");
	});

	it("runs in a URL working directory with relative paths inside it", async () => {
		await fs.mkdir(path.join(localRoot, "work"), { recursive: true });
		await fs.writeFile(path.join(localRoot, "work", "in.txt"), "inside\n");

		const { text, isError } = await run("cat in.txt; printf 'rel\\n' > rel.txt; ls", "local://work");

		expect(isError).toBeUndefined();
		expect(text).toContain("inside");
		expect(text).toContain("rel.txt");
		expect(await fs.readFile(path.join(localRoot, "work", "rel.txt"), "utf-8")).toBe("rel\n");
	});

	it("fails a redirection into a read-only scheme", async () => {
		const { isError } = await run("printf 'x' > omp://README.md");

		expect(isError).toBe(true);
	});
});
