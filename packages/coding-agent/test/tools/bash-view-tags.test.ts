import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
		enableLsp: false,
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

const SOURCE = [
	"export function retry(times: number) {",
	"\tconst limit = times * 2;",
	"\tfor (let i = 0; i < limit; i++) {",
	"\t\tattempt(i);",
	"\t}",
	"}",
	"",
].join("\n");

describe("bash numbered file views mint edit tags", () => {
	let cwd: string;
	let session: ToolSession;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-view-tags-")));
		await Bun.write(path.join(cwd, "retry.ts"), SOURCE);
		session = makeSession(cwd);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	async function bash(command: string): Promise<string> {
		return textOf(await new BashTool(session).execute("bash", { command }));
	}

	function footerTag(output: string, file: string): string | undefined {
		const footer = output.split("\n").find(line => line.startsWith("Edit tags for the numbered lines above:"));
		return footer && new RegExp(`\\[${file.replace(".", "\\.")}#([0-9A-F]{4})\\]`).exec(footer)?.[1];
	}

	it("lets an edit anchor a line `grep -n` printed, under the tag the output names", async () => {
		const output = await bash("grep -n 'const limit' retry.ts");
		expect(output).toContain("2:\tconst limit = times * 2;");
		const tag = footerTag(output, "retry.ts");
		expect(tag).toBeDefined();

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `[retry.ts#${tag}]\nPUT 2.=2:\n+\tconst limit = times * 3;\n`,
		});
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).not.toContain("never displayed");
		expect(await Bun.file(path.join(cwd, "retry.ts")).text()).toBe(SOURCE.replace("times * 2", "times * 3"));
	});

	it("still rejects lines the numbered output did not print", async () => {
		const tag = footerTag(await bash("grep -n 'const limit' retry.ts"), "retry.ts");
		expect(tag).toBeDefined();

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `[retry.ts#${tag}]\nPUT 4.=4:\n+\t\tawait attempt(i);\n`,
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/anchors to lines 4 .*never displayed/);
		expect(await Bun.file(path.join(cwd, "retry.ts")).text()).toBe(SOURCE);
	});

	it("tags `path:N:text` rows of several files and `cat -n` rows", async () => {
		await Bun.write(path.join(cwd, "other.ts"), "const limit = 1;\n");
		const grep = await bash("grep -n 'limit' retry.ts other.ts");
		expect(footerTag(grep, "retry.ts")).toBeDefined();
		expect(footerTag(grep, "other.ts")).toBeDefined();
		expect(getEditStore(session).seenLines(path.join(cwd, "retry.ts"), footerTag(grep, "retry.ts")!)).toEqual([2, 3]);

		const catN = await bash("cat -n retry.ts | sed -n 3,4p");
		expect(footerTag(catN, "retry.ts")).toBeDefined();
	});

	it("names no tag for unnumbered views or rows that do not match the file", async () => {
		expect(footerTag(await bash("sed -n 2,3p retry.ts"), "retry.ts")).toBeUndefined();
		// The second grep renumbers the first one's output: `1:2:...` rows are not lines of retry.ts.
		expect(footerTag(await bash("grep -n limit retry.ts | grep -n const | cut -c1-12"), "retry.ts")).toBeUndefined();
		expect(footerTag(await bash("printf '2:not the file\\n' # retry.ts"), "retry.ts")).toBeUndefined();
	});

	it("names no tags for a listing across more than four files", async () => {
		for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])
			await Bun.write(path.join(cwd, name), "const limit = 1;\n");
		const survey = await bash("grep -n limit a.ts b.ts c.ts d.ts e.ts");
		expect(survey).toContain("e.ts:1:const limit = 1;");
		expect(survey).not.toContain("Edit tags for the numbered lines above:");
		expect(getEditStore(session).headHash(path.join(cwd, "a.ts"))).toBeNull();
	});

	it("keeps a full read's unrestricted snapshot unrestricted", async () => {
		const file = path.join(cwd, "retry.ts");
		const store = getEditStore(session);
		const tag = store.recordSnapshot(file, SOURCE, []);
		expect(footerTag(await bash("grep -n limit retry.ts"), "retry.ts")).toBe(tag);
		expect(store.seenLines(file, tag)).toEqual([]);
	});
});
