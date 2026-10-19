import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDirectoryArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import { getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

describe("/move directory autocomplete", () => {
	let root = "";
	let projectDir = "";
	const complete = buildDirectoryArgumentCompletions();
	const values = async (prefix: string) => (await complete(prefix))?.map(item => item.value) ?? null;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-autocomplete-"));
		projectDir = path.join(root, "project");
		await fs.mkdir(path.join(projectDir, "alpha"), { recursive: true });
		await fs.mkdir(path.join(projectDir, "beta"));
		await fs.mkdir(path.join(root, "sibling"));
		setProjectDir(projectDir);
	});

	afterEach(async () => {
		setProjectDir(originalProjectDir);
		await removeWithRetries(root);
	});

	test("a directory named without a trailing separator completes the separator, not its first child", async () => {
		expect(await values("..")).toEqual(["../"]);
		expect(await values(".")).toEqual(["./"]);
		expect(await values("~")).toEqual(["~/"]);
		expect(await values("alpha/..")).toEqual(["alpha/../"]);
	});

	test("a trailing separator lists the directory's children", async () => {
		expect(await values("../")).toEqual(["./", "../sibling/"]);
		expect(await values("")).toEqual(["alpha/", "beta/"]);
	});

	test("absolute prefixes stay absolute", async () => {
		const absolute = `${root.replaceAll("\\", "/")}/`;
		expect(await values(`${absolute}sib`)).toEqual([`${absolute}sibling/`]);
		expect(await values(absolute)).toEqual([`${absolute}project/`, `${absolute}sibling/`]);
	});

	test.if(process.platform === "win32")("a trailing backslash lists children on Windows", async () => {
		const absolute = root.replaceAll("\\", "/");
		expect(await values(`${root}\\`)).toEqual([`${absolute}/project/`, `${absolute}/sibling/`]);
	});
});
