import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(
	cwd: string,
	settings: Record<string, unknown> = {},
	asyncJobManager?: AsyncJobManager,
): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "bash-view-tags",
		asyncJobManager,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			...settings,
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

	it("keeps a retained unrestricted snapshot unrestricted when the file returns to it", async () => {
		const file = path.join(cwd, "retry.ts");
		const store = getEditStore(session);
		const original = store.recordSnapshot(file, SOURCE, []);
		store.recordSnapshot(file, SOURCE.replace("times * 2", "times * 4"), []);
		expect(footerTag(await bash("grep -n limit retry.ts"), "retry.ts")).toBe(original);
		expect(store.seenLines(file, original)).toEqual([]);

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `[retry.ts#${original}]\nPUT 4.=4:\n+\t\tawait attempt(i);\n`,
		});
		expect(result.isError).toBeFalsy();
	});

	it("resolves `path:` rows in the directory an inner `cd` moved to, and skips names both directories hold", async () => {
		await fs.mkdir(path.join(cwd, "sub"));
		await Bun.write(path.join(cwd, "sub", "a.ts"), "target\n");
		await Bun.write(path.join(cwd, "sub", "b.ts"), "target\n");
		const output = await bash("true; cd sub; grep -n target a.ts b.ts");
		const tag = footerTag(output, "sub/a.ts");
		expect(tag).toBeDefined();
		expect(footerTag(output, "sub/b.ts")).toBeDefined();
		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `[sub/a.ts#${tag}]\nPUT 1.=1:\n+changed\n`,
		});
		expect(result.isError).toBeFalsy();

		await Bun.write(path.join(cwd, "b.ts"), "target\n");
		const ambiguous = await bash("true; cd sub; grep -n target a.ts b.ts");
		expect(footerTag(ambiguous, "sub/b.ts")).toBeUndefined();
		expect(footerTag(ambiguous, "b.ts")).toBeUndefined();
		expect(getEditStore(session).headHash(path.join(cwd, "b.ts"))).toBeNull();
	});

	it("tags every row of a long listing of short lines", async () => {
		await Bun.write(path.join(cwd, "blank.txt"), "\n".repeat(5000));
		const output = await bash("grep -n '^$' blank.txt");
		expect(output).toContain("5000:");
		const tag = footerTag(output, "blank.txt");
		expect(tag).toBeDefined();
		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `[blank.txt#${tag}]\nPUT 5000.=5000:\n+last\n`,
		});
		expect(result.isError).toBeFalsy();
	});

	it("records nothing when the tagged result would pass the spill threshold", async () => {
		// 1 KiB threshold: 30 rows come to ~980 bytes, which the tag line pushes past it.
		const rows = Array.from({ length: 30 }, (_, i) => `entry ${String(i).padStart(2, "0")} ${"x".repeat(20)}`);
		await Bun.write(path.join(cwd, "list.txt"), `${rows.join("\n")}\n`);
		const small = makeSession(cwd, { "tools.artifactSpillThreshold": 1 });
		const near = textOf(await new BashTool(small).execute("bash", { command: "grep -n entry list.txt" }));
		expect(Buffer.byteLength(near)).toBeLessThanOrEqual(1024);
		expect(near).not.toContain("Edit tags for the numbered lines above:");
		await Bun.write(path.join(cwd, "list.txt"), `${[...rows, ...rows].join("\n")}\n`);
		const over = textOf(await new BashTool(small).execute("bash", { command: "grep -n entry list.txt" }));
		expect(over).not.toContain("Edit tags for the numbered lines above:");
		expect(getEditStore(small).headHash(path.join(cwd, "list.txt"))).toBeNull();
	});

	it("records rows only for a job result the call returns itself", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		try {
			const foreground = makeSession(
				cwd,
				{ "async.enabled": true, "bash.autoBackground.enabled": true, "bash.autoBackground.thresholdMs": 60_000 },
				manager,
			);
			const waited = textOf(await new BashTool(foreground).execute("bash", { command: "grep -n limit retry.ts" }));
			const tag = footerTag(waited, "retry.ts");
			expect(tag).toBeDefined();
			expect(getEditStore(foreground).seenLines(path.join(cwd, "retry.ts"), tag!)).toEqual([2, 3]);

			const background = makeSession(cwd, { "async.enabled": true }, manager);
			const started = await new BashTool(background).execute("bash", {
				command: "grep -n limit retry.ts",
				async: true,
			});
			const jobId = started.details?.async?.jobId;
			if (!jobId) throw new Error("expected a background job");
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries();
			expect(getEditStore(background).headHash(path.join(cwd, "retry.ts"))).toBeNull();
		} finally {
			await manager.dispose();
		}
	});
});
