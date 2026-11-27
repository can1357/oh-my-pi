import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
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

	it("links a host path to the file a backed URL aliases", async () => {
		const { text, isError } = await run(
			"printf 'body\\n' > local://source.txt && ln -s local://source.txt host-link && cat host-link",
		);

		expect(isError).toBeUndefined();
		expect(text).toContain("body");
		expect(await fs.readlink(path.join(tempDir, "host-link"))).toBe(path.join(localRoot, "source.txt"));
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

	it("hands an external program the files that backed URL arguments alias", async () => {
		const script = path.join(tempDir, "argv.js");
		await fs.writeFile(script, "console.log(process.argv.slice(2).join('\\n'));\n");
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "data.txt"), "payload\n");
		await fs.mkdir(path.join(localRoot, "index"), { recursive: true });

		const { text, isError } = await run(
			`'${process.execPath}' '${script}' local://data.txt --index=local://index https://example.com/a.txt 'local://'`,
		);

		expect(isError).toBeUndefined();
		expect(text).toContain(path.join(localRoot, "data.txt"));
		expect(text).toContain(`--index=${path.join(localRoot, "index")}`);
		expect(text).toContain("https://example.com/a.txt");
		// A bare scheme root is search-pattern text far more often than a directory.
		expect(text.split("\n")).toContain("local://");
	});

	it("runs a skill's script by URL but refuses the read-only skill directory as a working directory", async () => {
		const skillDir = path.join(tempDir, "skills", "demo");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: demo\n---\n");
		await fs.writeFile(path.join(skillDir, "tool.js"), "console.log('tool-ran');\n");
		session = {
			...session,
			skills: [{ name: "demo", baseDir: skillDir, filePath: path.join(skillDir, "SKILL.md") }],
		} as unknown as ToolSession;

		const ran = await run(`'${process.execPath}' skill://demo/tool.js`);
		expect(ran.isError).toBeUndefined();
		expect(ran.text).toContain("tool-ran");

		// The child could write anywhere under its working directory; skill:// refuses mutation.
		const refused = await run(`'${process.execPath}' tool.js`, "skill://demo");
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("read-only working directory");
	});

	it("hands a program a URL argument the provider cannot resolve as written", async () => {
		const script = path.join(tempDir, "argv.js");
		await fs.writeFile(script, "console.log(process.argv.slice(2).join('\\n'));\n");
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "data.txt"), "payload\n");

		// An identifier or message text that only looks like a path is the program's own.
		const { text, isError } = await run(
			`'${process.execPath}' '${script}' skill://nope/tool.js 'local://12.log; local://data.txt is the evidence'`,
		);

		expect(isError).toBeUndefined();
		expect(text).toContain("skill://nope/tool.js\nlocal://12.log; local://data.txt is the evidence\n");
	});

	it.skipIf(process.platform === "win32")("hands omp every URL as written, selectors included", async () => {
		const script = path.join(tempDir, "argv.js");
		await fs.writeFile(script, "console.log(process.argv.slice(2).join('\\n'));\n");
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "data.txt"), "payload\n");
		await fs.writeFile(path.join(tempDir, "omp"), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, {
			mode: 0o755,
		});

		const { text, isError } = await run(`PATH="$PWD:$PATH" omp read local://data.txt:1-1 --from=local://data.txt`);

		expect(isError).toBeUndefined();
		expect(text).toContain("read\nlocal://data.txt:1-1\n--from=local://data.txt\n");
	});

	it("resolves URLs attached to an option, behind curl's @, and in the environment", async () => {
		const script = path.join(tempDir, "argv.js");
		await fs.writeFile(script, "console.log(process.argv.slice(2).concat(process.env.BODY).join('\\n'));\n");
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "data.txt"), "payload\n");
		const data = path.join(localRoot, "data.txt");

		const { text, isError } = await run(
			`BODY=local://data.txt '${process.execPath}' '${script}' -olocal://data.txt @local://data.txt body=@local://data.txt`,
		);

		expect(isError).toBeUndefined();
		expect(text).toContain(`-o${data}\n@${data}\nbody=@${data}\n${data}\n`);
	});

	it("starts an external program in the directory a URL working directory aliases", async () => {
		const script = path.join(tempDir, "cwd.js");
		await fs.writeFile(script, "console.log(process.cwd());\nconsole.log(process.env.PWD);\n");
		await fs.mkdir(path.join(localRoot, "work"), { recursive: true });

		const { text, isError } = await run(`'${process.execPath}' '${script}'`, "local://work");

		const work = path.join(localRoot, "work");
		expect(isError).toBeUndefined();
		// `PWD` must agree with `getcwd()`: a program reading the variable
		// directly cannot open the URL spelling.
		expect(text).toContain(`${work}\n${work}`);
	});

	it("fails a redirection into a read-only scheme", async () => {
		const { isError } = await run("printf 'x' > omp://README.md");

		expect(isError).toBe(true);
	});
});

describe("bash writes to handler-written URLs", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		manager = new AsyncJobManager({});
		session = {
			...session,
			getSessionId: () => tempDir,
			asyncJobManager: manager,
			settings: Settings.isolated({ "bash.autoBackground.enabled": false, "bashInterceptor.enabled": false }),
		} as unknown as ToolSession;
	});

	afterEach(async () => {
		await manager.dispose();
	});

	it("cancels a background job through a redirect to proc://<id>/kill and shows the handler's answer", async () => {
		const started = await new BashTool(session).execute("bg", { command: "sleep 30", async: true, timeout: 0 });
		const id = started.details?.async?.jobId;
		if (!id) throw new Error("expected a background job");

		const { text, isError } = await run(`: > proc://${id}/kill`);

		expect(isError).toBeUndefined();
		expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(text).toContain(`proc://${id}/kill:`);
		expect(text).toContain(`Cancelled background job ${id}`);
	});

	it("fails the command with the handler's reason when it refuses a write, and refuses appends that would replace", async () => {
		const missing = await run(": > proc://nope/kill");
		expect(missing.isError).toBe(true);
		expect(missing.text).toContain("[proc://nope/kill failed: Background job or service not found: nope]");

		// A handler write replaces a stored target whole, so `>>` must not silently drop its content.
		const appended = await run("echo true >> cfg://async/enabled; echo status=$?");
		expect(appended.text).toContain("status=1");
		expect(appended.text).toContain("truncate (>) instead of appending (>>)");
	});
});

describe("bash replies through out://", () => {
	it("carries each closed redirect as a reply, live and in the final result, without touching the output", async () => {
		const frames: unknown[] = [];
		const result = await new BashTool({ ...session, tuiTranscript: true }).execute(
			"call",
			{ command: "printf '**first**\\n' > out://; echo between; echo second >> out://" },
			undefined,
			update => frames.push(update.details),
		);

		expect(result.content.find(c => c.type === "text")?.text).toBe("between\n");
		expect(result.details?.replies).toEqual(["**first**\n", "second\n"]);
		// The first reply reaches the card while the command still runs.
		expect(frames).toContainEqual({ replies: ["**first**\n"] });
	});

	it("drops an oversize reply instead of showing a truncated one, and refuses reads", async () => {
		const big = await new BashTool({ ...session, tuiTranscript: true }).execute("call", {
			// `yes` rather than /dev/zero, which Windows lacks.
			command: "yes a | head -c 70000 | tr '\\n' a > out://; echo status=$?",
		});
		// Unix spells the rejected write by its errno text; Windows has no EFBIG errno and keeps the code.
		const text = big.content.find(c => c.type === "text")?.text;
		expect(text).toMatch(/File too large|EFBIG/);
		expect(text).toContain("status=1");
		expect(big.details?.replies).toBeUndefined();

		const read = await run("cat out://; echo status=$?");
		expect(read.text).toContain("status=1");
	});
});
