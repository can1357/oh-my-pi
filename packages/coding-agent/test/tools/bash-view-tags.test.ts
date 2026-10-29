import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { planNumberedFileTags } from "@oh-my-pi/pi-coding-agent/tools/bash-view-tags";
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
	};
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

		const catN = await bash("cat -n retry.ts | head -n 4 | tail -n 2");
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

	it("names no tag for unprefixed rows of several files, whose numbers run across the joined stream", async () => {
		await Bun.write(path.join(cwd, "a.ts"), "shared\n");
		await Bun.write(path.join(cwd, "b.ts"), "shared\nsecond\n");
		const joined = await bash("cat -n a.ts b.ts");
		expect(joined).toContain("2\tshared");
		expect(joined).not.toContain("Edit tags for the numbered lines above:");
		expect(getEditStore(session).headHash(path.join(cwd, "b.ts"))).toBeNull();
	});

	it("names no tag when a `cd` may not apply to the commands after it", async () => {
		await fs.mkdir(path.join(cwd, "sub"));
		await Bun.write(path.join(cwd, "sub", "retry.ts"), SOURCE);
		for (const command of [
			"false && cd sub; grep -n limit retry.ts",
			"(cd sub); grep -n limit retry.ts",
			"cd sub | true; grep -n limit retry.ts",
			"pushd sub > /dev/null; grep -n limit retry.ts",
			"if true; then cd sub; fi; grep -n limit retry.ts",
		]) {
			expect(await bash(command)).not.toContain("Edit tags for the numbered lines above:");
		}
		expect(getEditStore(session).headHash(path.join(cwd, "sub", "retry.ts"))).toBeNull();
		expect(getEditStore(session).headHash(path.join(cwd, "retry.ts"))).toBeNull();
	});

	it("names no tag for rows numbered after the file was sliced or streamed", async () => {
		// The last line repeats the first: `tail -n 1 | cat -n` prints it as line 1.
		await Bun.write(path.join(cwd, "ends.ts"), "same\nmiddle\nsame\n");
		for (const command of [
			"tail -n 1 ends.ts | cat -n",
			"sed -n 3p ends.ts | grep -n same",
			"grep -n same ends.ts | nl",
		]) {
			expect(await bash(command)).not.toContain("Edit tags for the numbered lines above:");
		}
		expect(getEditStore(session).headHash(path.join(cwd, "ends.ts"))).toBeNull();
	});

	it("names no tag when a row's file, line or source is uncertain", async () => {
		await fs.mkdir(path.join(cwd, "sub"));
		await Bun.write(path.join(cwd, "a.ts"), "same\nroot-only\nsame\nsame\nsame\n");
		await Bun.write(path.join(cwd, "sub", "a.ts"), "same\nsub-only\nsame\n");
		// A file whose text is a numbered row of a.ts.
		await Bun.write(path.join(cwd, "2p"), "3:same\n");
		for (const command of [
			// The `cd` is skipped when the first grep fails.
			"grep -q missing /dev/null && cd sub; grep -n '^same$' a.ts",
			// Quoted or escaped `=`: a command named FOO=bar, not an assignment.
			"'FOO=bar' cd sub; grep -n '^same$' a.ts",
			"FOO\\=bar cd sub; grep -n '^same$' a.ts",
			"F''OO=bar cd sub; grep -n '^same$' a.ts",
			"F\\OO=bar cd sub; grep -n '^same$' a.ts",
			"F\"\"OO=bar cd sub; grep -n '^same$' a.ts",
			// An assignment that can move the `cd`.
			"CDPATH=/ cd sub; grep -n '^same$' a.ts",
			// The shell fails on `missing` or the file `2p` before it climbs back to sub.
			"cd missing/../sub; grep -n '^same$' a.ts",
			"cd 2p/../sub; grep -n '^same$' a.ts",
			// The redirection fails, so the `cd` never runs.
			"cd sub > missing/out; grep -n '^same$' a.ts",
			// The rows come from `2p`, not from the numbered stream or view.
			"cat -n a.ts | sed -n 1p 2p",
			"cat -n a.ts | cat 2p",
			"grep -n -m1 same a.ts; cat 2p",
			// A comment or heredoc hides what runs.
			"cat -n a.ts # ; cd sub\ngrep -n '^same$' a.ts",
			"cat -n << true\ncd sub\ntrue\ngrep -n '^same$' a.ts",
			// Numbers that are not file line numbers, or text cut after numbering.
			"grep -bm 2 same a.ts",
			"nl -ba -v 5 a.ts | head -n 1",
			"nl a.ts",
			"cat -b a.ts",
			"cat -ns a.ts",
			"grep -n '^same$' a.ts | tail -n 1 | cut -c2-",
			"grep -nH --label=a.ts same < sub/a.ts",
		]) {
			expect(await bash(command)).not.toContain("Edit tags for the numbered lines above:");
		}
		expect(getEditStore(session).headHash(path.join(cwd, "a.ts"))).toBeNull();
		expect(getEditStore(session).headHash(path.join(cwd, "sub", "a.ts"))).toBeNull();
	});

	it("names no tag when the shell may read operands the command does not spell", async () => {
		await Bun.write(path.join(cwd, "a.ts"), "same\nactual\n");
		// `s*` expands to the pattern `same` and the file `same-input`.
		await Bun.write(path.join(cwd, "same"), "");
		await Bun.write(path.join(cwd, "same-input"), "same\n");
		// Files named like options, read after `--`.
		await Bun.write(path.join(cwd, "-x"), "same\n");
		await Bun.write(path.join(cwd, "-n"), "1:same\n");
		for (const command of [
			"grep -nh s* a.ts | head -n 1",
			"grep -nh -e s* a.ts | head -n 1",
			"cat -n a.ts | grep s*",
			// `*` matches `-n` and `-x`, which grep takes as options.
			"grep -n same * | head -n 1",
			"cat -n -- -x a.ts | head -n 1",
			"cat -- -n a.ts | head -n 1",
			"grep -nh -- same -x a.ts | head -n 1",
		]) {
			expect(await bash(command)).not.toContain("Edit tags for the numbered lines above:");
		}
		expect(getEditStore(session).headHash(path.join(cwd, "a.ts"))).toBeNull();
	});

	it("reads a quoted word the way the shell does", async () => {
		await Bun.write(path.join(cwd, "a.ts"), "same\n");
		await Bun.write(path.join(cwd, "2p"), "1:same\n");
		// `$D` expands inside double quotes; the literal directory is a decoy.
		await Bun.write(path.join(cwd, "$D", "a.ts"), "same\n");
		expect(await planNumberedFileTags(session, 'grep -n same "$D/a.ts"', cwd, "1:same\n")).toBeUndefined();
		// `'2p'>/dev/stdout` hands `2p` to head as a file: the row is from 2p.
		expect(
			await planNumberedFileTags(session, "grep -n missing a.ts | head '2p'>/dev/stdout", cwd, "1:same\n"),
		).toBeUndefined();
		// `''~/a.ts` does not start with `~`: the shell opens ./~/a.ts, not the home file.
		await Bun.write(path.join(cwd, "home", "a.ts"), "same\n");
		await Bun.write(path.join(cwd, "~", "a.ts"), "same\n");
		const homeSpy = spyOn(os, "homedir").mockReturnValue(path.join(cwd, "home"));
		try {
			(await planNumberedFileTags(session, "grep -n same ''~/a.ts", cwd, "1:same\n"))?.commit();
			expect(getEditStore(session).headHash(path.join(cwd, "home", "a.ts"))).toBeNull();
			expect(getEditStore(session).headHash(path.join(cwd, "~", "a.ts"))).not.toBeNull();
		} finally {
			homeSpy.mockRestore();
		}
	});

	it("names no tag for anything but one numberer reading the files it names", async () => {
		await Bun.write(path.join(cwd, "a.ts"), "same\nx\nsame\n");
		await Bun.write(path.join(cwd, "b.ts"), "same\n");
		for (const command of [
			"grep -n same ./*.ts",
			"grep -n same a.ts; grep -n same b.ts",
			"grep -n same a.ts && grep -n same b.ts",
			"git grep --no-index -n same -- a.ts",
			"grep -n -A1 same a.ts",
			"grep -nh same a.ts b.ts",
			"grep -rn same .",
			"rg -n same",
			"grep -n same a.ts | grep -v x",
			"grep -n same a.ts | sed -n 1p",
			"LC_ALL=C grep -n same a.ts",
			"grep -n same < a.ts",
			"cat a.ts | grep -n same",
		]) {
			expect(await bash(command)).not.toContain("Edit tags for the numbered lines above:");
		}
		expect(getEditStore(session).headHash(path.join(cwd, "a.ts"))).toBeNull();
		expect(getEditStore(session).headHash(path.join(cwd, "b.ts"))).toBeNull();
	});

	it("names no tag for file names or counts printed instead of rows", async () => {
		// `grep -nl` prints only the name `1-target`, which reads as row 1 `target`.
		await Bun.write(path.join(cwd, "1-target"), "target\n");
		await Bun.write(path.join(cwd, "3"), "x\ny\nz\n");
		expect((await bash("grep -nl target 1-target")).trim()).toBe("1-target");
		for (const command of ["grep -nL x 1-target", "rg -nl target 1-target", "grep -nc x 3"]) {
			expect(await planNumberedFileTags(session, command, cwd, "1-target\n")).toBeUndefined();
		}
		expect(getEditStore(session).headHash(path.join(cwd, "1-target"))).toBeNull();
	});

	it("names no tag for a system rg that may read a config file, unless told to skip it", async () => {
		// A `--no-filename` in `RIPGREP_CONFIG_PATH` prints a's row `2:target` as
		// `1:2:target`, which reads as row 2 of file `1`, a row `-m1` never printed.
		await Bun.write(path.join(cwd, "a"), "2:target\n");
		await Bun.write(path.join(cwd, "1"), "target-first\ntarget\n");
		expect(
			await planNumberedFileTags(session, "rg -nm1 target a 1", cwd, "1:2:target\n1:target-first\n", true),
		).toBeUndefined();
		const tags = await planNumberedFileTags(
			session,
			"rg --no-config -nm1 target a 1",
			cwd,
			"a:1:2:target\n1:1:target-first\n",
			true,
		);
		expect(tags?.notice).toContain("[1#");
	});

	it("keeps a redirection's quoted target attached to it", async () => {
		// `-m1` stops each file at its first match: row 2 comes from b, not a.
		await Bun.write(path.join(cwd, "a"), "target\ntarget\n");
		await Bun.write(path.join(cwd, "b"), "x\ntarget\n");
		expect(await bash('grep -nh -m1 target a 2>"err" b')).toContain("2:target");
		expect(getEditStore(session).headHash(path.join(cwd, "a"))).toBeNull();
	});

	it("names no tag for rows a numberer prints that are not file lines", async () => {
		// A custom group separator spelled like a row of b.ts.
		await Bun.write(path.join(cwd, "a.ts"), "target\nctx\ngap\ngap\ntarget\n");
		await Bun.write(path.join(cwd, "b.ts"), "same\n");
		expect(await bash("grep -n --group-separator=b.ts:1:same -A1 target a.ts")).toContain("b.ts:1:same");
		expect(getEditStore(session).headHash(path.join(cwd, "b.ts"))).toBeNull();

		// `nl` restarts at a logical-page delimiter: physical line 3 prints as 1.
		await Bun.write(path.join(cwd, "page.ts"), "same\n\\:\\:\nsame\n");
		expect(await bash("nl -ba page.ts | tail -n 1")).not.toContain("Edit tags for the numbered lines above:");
		expect(getEditStore(session).headHash(path.join(cwd, "page.ts"))).toBeNull();

		// `1:2:prefix` is line 2 of the file `1`, cut by `-o`; read bare it would be line 1.
		await Bun.write(path.join(cwd, "1"), "2:prefix\nprefix suffix\n");
		expect(await bash("grep -nHo '^prefix' 1")).toContain("1:2:prefix");
		expect(getEditStore(session).headHash(path.join(cwd, "1"))).toBeNull();
	});

	// Windows file names cannot hold `:`.
	it.skipIf(process.platform === "win32")(
		"tags only files the command names, and no line its output shows two ways",
		async () => {
			await Bun.write(path.join(cwd, "a.ts"), "b.ts:1:same\n");
			await Bun.write(path.join(cwd, "1:b.ts"), "same\n");
			await Bun.write(path.join(cwd, "a.ts:1:b.ts"), "same\n");
			const store = getEditStore(session);
			// Text of a.ts spelled like a row of `1:b.ts` or of `a.ts:1:b.ts`.
			expect(footerTag(await bash("grep -n same a.ts"), "a.ts")).toBeDefined();
			expect(await bash("grep -nH same a.ts")).toContain("a.ts:1:b.ts:1:same");
			expect(store.headHash(path.join(cwd, "1:b.ts"))).toBeNull();
			expect(store.headHash(path.join(cwd, "a.ts:1:b.ts"))).toBeNull();

			// `a.ts:1:b.ts:1:same`, printed for both files, reads as a row of each.
			const both = makeSession(cwd);
			const output = textOf(
				await new BashTool(both).execute("bash", { command: "grep -n same a.ts 'a.ts:1:b.ts'" }),
			);
			expect(output).toContain("a.ts:1:b.ts:1:same");
			expect(output).not.toContain("Edit tags for the numbered lines above:");
		},
	);

	it("names no tag for a `cd` inside the command, which a function or `CDPATH` can send elsewhere", async () => {
		await fs.mkdir(path.join(cwd, "sub"));
		await Bun.write(path.join(cwd, "sub", "a.ts"), "same\nwrong\n");
		for (const command of [
			"cd sub; grep -n . a.ts",
			"cd sub && grep -n . a.ts",
			"cd sub > /dev/null; grep -n . a.ts",
		]) {
			expect(await planNumberedFileTags(session, command, cwd, "1:same\n2:wrong\n")).toBeUndefined();
		}
	});

	it("names no tag for a numbering or pattern option after a file, which POSIX tools read as a file", async () => {
		// Under `POSIXLY_CORRECT`, `-n` is a missing file and line 2 prints unnumbered as `a.ts:1:target`.
		await Bun.write(path.join(cwd, "a.ts"), "target\n1:target\n");
		expect(await planNumberedFileTags(session, "grep '^1:' a.ts -n", cwd, "a.ts:1:target\n")).toBeUndefined();
		expect(await planNumberedFileTags(session, "cat a.ts -n", cwd, "target\n1:target\n")).toBeUndefined();
		// There `a.ts` is the pattern, and `-e` and `target` the files.
		expect(await planNumberedFileTags(session, "grep -nh a.ts -e target", cwd, "1:target\n")).toBeUndefined();
		// ripgrep has no such mode; other options after a file only filter real rows.
		expect(await planNumberedFileTags(session, "rg '^1:' a.ts -n", cwd, "2:1:target\n")).toBeDefined();
		expect(await planNumberedFileTags(session, "grep -n target a.ts --max-count=1", cwd, "1:target\n")).toBeDefined();
	});

	it("names no tag when a later option takes the line numbers back", async () => {
		// Line 2 is `1:target`: printed without its number it reads as row 1.
		await Bun.write(path.join(cwd, "a.ts"), "target\n1:target\n");
		for (const command of [
			"rg -n -N '^1:' a.ts",
			"rg -n --no-line-number '^1:' a.ts",
			"git grep -n --no-line-number '^1:' a.ts",
		]) {
			expect(await planNumberedFileTags(session, command, cwd, "1:target\n")).toBeUndefined();
		}
		expect(await planNumberedFileTags(session, "rg -n '^1:' a.ts", cwd, "2:1:target\n")).toBeDefined();
	});

	it("keeps quoted `>` and spaces in a file name", async () => {
		await Bun.write(path.join(cwd, "a >suffix"), "same\nactual\n");
		await Bun.write(path.join(cwd, "a  "), "same\nwrong\n");
		const output = await bash("cat -n 'a >suffix'");
		expect(output).toContain("Edit tags for the numbered lines above:");
		expect(getEditStore(session).headHash(path.join(cwd, "a  "))).toBeNull();
		const tag = getEditStore(session).headHash(path.join(cwd, "a >suffix"));
		expect(getEditStore(session).seenLines(path.join(cwd, "a >suffix"), tag!)).toEqual([1, 2]);
	});

	it("tags a numbered view through redirections and row filters", async () => {
		const output = await bash("grep -n limit retry.ts 2>/dev/null | head -5 | tail -n 2");
		const tag = footerTag(output, "retry.ts");
		expect(tag).toBeDefined();
		expect(getEditStore(session).seenLines(path.join(cwd, "retry.ts"), tag!)).toEqual([2, 3]);
	});

	it("names no tag for a path that climbs out of a symlink", async () => {
		// `link/../retry.ts` opens outside/retry.ts; read lexically it would be ./retry.ts.
		await fs.mkdir(path.join(cwd, "outside", "sub"), { recursive: true });
		await Bun.write(path.join(cwd, "outside", "retry.ts"), SOURCE);
		await fs.symlink(path.join(cwd, "outside", "sub"), path.join(cwd, "link"));
		expect(await bash("grep -n limit link/../retry.ts")).not.toContain("Edit tags for the numbered lines above:");
		expect(await bash("grep -n limit link/../retry.ts /dev/null")).not.toContain(
			"Edit tags for the numbered lines above:",
		);
		expect(getEditStore(session).headHash(path.join(cwd, "retry.ts"))).toBeNull();
	});

	it("names a file under the home directory with `~`, and edit accepts it", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue(cwd);
		try {
			await fs.mkdir(path.join(cwd, "inner"));
			const inner = makeSession(path.join(cwd, "inner"));
			const output = textOf(
				await new BashTool(inner).execute("bash", { command: `grep -n limit ${path.join(cwd, "retry.ts")}` }),
			);
			expect(output).toContain("[~/retry.ts#");
			expect(output).not.toContain(`[${cwd}`);
			const tag = footerTag(output, "~/retry.ts");
			const result = await new EditTool(inner, "hashline").execute("edit", {
				input: `[~/retry.ts#${tag}]\nPUT 2.=2:\n+\tconst limit = times * 3;\n`,
			});
			expect(result.isError).toBeFalsy();
		} finally {
			homeSpy.mockRestore();
		}
	});

	it("names no tag when edits do not take hashline anchors, or for notebooks", async () => {
		const replace = makeSession(cwd, { "edit.mode": "replace" });
		const output = textOf(await new BashTool(replace).execute("bash", { command: "grep -n limit retry.ts" }));
		expect(output).toContain("2:\tconst limit");
		expect(output).not.toContain("Edit tags for the numbered lines above:");

		await Bun.write(path.join(cwd, "nb.ipynb"), '{\n "cells": [],\n "nbformat": 4\n}\n');
		expect(await bash("grep -n cells nb.ipynb")).not.toContain("Edit tags for the numbered lines above:");
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

	it("resolves rows in the directory a leading `cd` moved to", async () => {
		await fs.mkdir(path.join(cwd, "sub"));
		await Bun.write(path.join(cwd, "sub", "a.ts"), "target\n");
		await Bun.write(path.join(cwd, "sub", "b.ts"), "target\n");
		await Bun.write(path.join(cwd, "b.ts"), "target\n");
		const output = await bash("cd sub && grep -n target a.ts b.ts");
		const tag = footerTag(output, "sub/a.ts");
		expect(tag).toBeDefined();
		expect(footerTag(output, "sub/b.ts")).toBeDefined();
		expect(footerTag(output, "b.ts")).toBeUndefined();
		expect(getEditStore(session).headHash(path.join(cwd, "b.ts"))).toBeNull();
		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `[sub/a.ts#${tag}]\nPUT 1.=1:\n+changed\n`,
		});
		expect(result.isError).toBeFalsy();

		// A `cd` inside the command is not followed: it may fail, or run a function.
		expect(await bash("cd missing; grep -n target b.ts")).not.toContain("Edit tags for the numbered lines above:");
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

	it("records rows only for the result the call returns itself, never a job's delivery", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (_id, text) => {
				deliveries.push(text);
			},
		});
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

			// A job's result reaches the model later, if at all: no tags, nothing recorded.
			const background = makeSession(cwd, { "async.enabled": true }, manager);
			const started = await new BashTool(background).execute("bash", {
				command: "grep -n limit retry.ts",
				async: true,
			});
			const jobId = started.details?.async?.jobId;
			if (!jobId) throw new Error("expected a background job");
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries();
			expect(deliveries.at(-1)).toContain("2:\tconst limit");
			expect(deliveries.at(-1)).not.toContain("Edit tags for the numbered lines above:");
			expect(getEditStore(background).headHash(path.join(cwd, "retry.ts"))).toBeNull();
		} finally {
			await manager.dispose();
		}
	});
});
