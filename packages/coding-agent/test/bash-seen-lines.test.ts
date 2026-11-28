import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ClientBridge, ClientBridgeTerminalHandle } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { bashResultReachesModelWhole } from "@oh-my-pi/pi-coding-agent/tools/bash-seen-lines";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createSession, footers, SOURCE, textOutput } from "./helpers/bash-seen-lines";

async function bash(session: ToolSession, command: string): Promise<string> {
	return textOutput(await new BashTool(session).execute("bash", { command }));
}

async function edit(session: ToolSession, input: string): Promise<string> {
	return textOutput(await new EditTool(session, "hashline").execute("edit", { input }));
}

describe("bash numbered file views credit seen lines", () => {
	let cwd: string;
	let file: string;

	beforeEach(async () => {
		cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-bash-seen-lines-"));
		file = path.join(cwd, "values.txt");
		await Bun.write(file, SOURCE);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	// Regression (T1): bash output never reached the edit store, so an edit anchored on a line
	// `grep -n` showed was rejected as never displayed and only the identical resend applied.
	it("tags a grep -n view and accepts edits on its rows on the first attempt", async () => {
		const session = createSession(cwd);
		const output = await bash(session, "grep -n 'value_3[45]$' values.txt");
		expect(output).toContain("34:line 34: value_34\n35:line 35: value_35");
		const [footer, ...rest] = footers(output);
		expect(rest).toEqual([]);
		expect(footer).toMatchObject({ path: "values.txt", lines: "34-35" });
		// The footer follows the command output.
		expect(output.trimEnd().endsWith(footer.lines)).toBe(true);

		const unshown = await edit(session, `${footer.header}\nPUT 20.=20:\n+line 20: changed\n`);
		expect(unshown).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(SOURCE);

		await edit(session, `${footer.header}\nPUT 35.=35:\n+line 35: changed\n`);
		expect(await Bun.file(file).text()).toBe(SOURCE.replace("line 35: value_35", "line 35: changed"));
	});

	// `nl -ba` / `cat -n` rows (`   N<TAB>text`) are numbered views too; unparsed, those edits would be rejected.
	it("tags a cat -n view (tab-separated rows)", async () => {
		const session = createSession(cwd);
		const output = await bash(session, "cat -n values.txt | sed -n '12,13p'");
		expect(footers(output)).toMatchObject([{ path: "values.txt", lines: "12-13" }]);
	});

	// T2: unnumbered views would make the model count offsets; the guard must still catch a miscount.
	it("does not credit an unnumbered sed -n view", async () => {
		const session = createSession(cwd);
		const read = textOutput(await new ReadTool(session).execute("read", { path: "values.txt:30-31" }));
		const header = read.split("\n")[0];
		expect(header).toMatch(/^\[values\.txt#[0-9A-F]{4}\]$/);

		const output = await bash(session, "sed -n 7p values.txt");
		expect(output).toContain("line 7: value_7");
		expect(footers(output)).toEqual([]);

		expect(await edit(session, `${header}\nPUT 7.=7:\n+line 7: changed\n`)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(SOURCE);
	});

	// T3: a row whose number is wrong is not a view of that line, even when its text is a real line of the file
	// (a miscount). Nothing is recorded either: an empty seen set would lift the guard for the whole file, which a
	// later read (same content, same tag) cannot narrow again.
	it("does not credit a numbered row whose text belongs to another line", async () => {
		const session = createSession(cwd);
		const output = await bash(session, "printf '7:line 8: value_8\\n' && test -f values.txt");
		expect(output).toContain("7:line 8: value_8");
		expect(footers(output)).toEqual([]);

		const read = textOutput(await new ReadTool(session).execute("read", { path: "values.txt:30-31" }));
		const header = read.split("\n")[0];
		expect(await edit(session, `${header}\nPUT 7.=7:\n+line 7: changed\n`)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(SOURCE);
	});

	// grep context rows (`N-text`) are shown lines too; unparsed, edits on them would be rejected.
	it("credits grep context rows", async () => {
		const session = createSession(cwd);
		const output = await bash(session, "grep -n -A1 'value_34$' values.txt");
		expect(output).toContain("35-line 35: value_35");
		expect(footers(output)).toMatchObject([{ path: "values.txt", lines: "34-35" }]);
	});

	// A failed exit still shows its rows (here `false` fails after grep matched); limiting credit to exit 0 would
	// reject edits on them.
	it("credits rows of a command that exits non-zero", async () => {
		const session = createSession(cwd);
		const output = await bash(session, "grep -n 'value_35$' values.txt; false");
		expect(output).toContain("35:line 35: value_35");
		expect(footers(output)).toMatchObject([{ path: "values.txt", lines: "35" }]);
	});

	// The tool wrapper middle-elides a result over the spill threshold, measured on the text with its tag footer.
	// Three rows that fit below it on their own but cross it with the footer are not credited: the elision could
	// drop them. Rows stay under the 768-byte column cap, which other tests in a shared process may leave in force.
	it("credits nothing when the tag footer would push the result over the spill threshold", async () => {
		const session = createSession(cwd, { settings: { "tools.artifactSpillThreshold": 1 } });
		const rows = (width: number) => `${Array.from({ length: 3 }, () => "a".repeat(width)).join("\n")}\n`;
		await Bun.write(path.join(cwd, "fits.txt"), rows(300));
		const fits = await bash(session, "grep -n a fits.txt");
		expect(Buffer.byteLength(fits)).toBeLessThan(1024 - 60);
		expect(footers(fits)).toMatchObject([{ path: "fits.txt", lines: "1-3" }]);

		await Bun.write(path.join(cwd, "big.txt"), rows(335));
		const output = await bash(session, "grep -n a big.txt");
		// The output alone is below the threshold; only the footer would cross it.
		expect(Buffer.byteLength(output.trimEnd())).toBeLessThanOrEqual(1024);
		expect(output).toContain(`3:${"a".repeat(335)}`);
		expect(footers(output)).toEqual([]);
	});

	// The tool wrapper middle-elides text over the spill threshold (bytes), which would drop credited rows.
	it("treats a result over the spill threshold as cut", () => {
		const small = Settings.isolated({ "tools.artifactSpillThreshold": 1 });
		expect(bashResultReachesModelWhole("a".repeat(1024), small)).toBe(true);
		expect(bashResultReachesModelWhole("a".repeat(1025), small)).toBe(false);
		expect(bashResultReachesModelWhole("界".repeat(400), small)).toBe(false);
	});

	// The footer lists at most 12 ranges, so many scattered rows cannot bloat it; rows past the listed ranges are
	// still credited.
	it("summarizes footer ranges past the cap and still credits the unlisted rows", async () => {
		const session = createSession(cwd);
		const output = await bash(session, "grep -n '[13579]$' values.txt");
		expect(output).toContain("39:line 39: value_39");
		expect(footers(output)).toMatchObject([
			{ path: "values.txt", lines: "1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23 (+8 more ranges)" },
		]);

		const [footer] = footers(output);
		await edit(session, `${footer.header}\nPUT 39.=39:\n+line 39: changed\n`);
		expect(await Bun.file(file).text()).toBe(SOURCE.replace("line 39: value_39", "line 39: changed"));
	});

	// Bare rows name no file; with two files named, crediting either would credit rows that may be the other's.
	it("ignores bare rows when the command names more than one file", async () => {
		const session = createSession(cwd);
		await Bun.write(path.join(cwd, "other.txt"), SOURCE);
		const output = await bash(session, "grep -h -n 'value_35$' values.txt other.txt");
		expect(output).toContain("35:line 35: value_35");
		expect(footers(output)).toEqual([]);
	});

	// D26/D28/D30: numbered views of a BOM file print the BOM after the line number on line 1, while the store holds
	// the text with exactly one BOM removed. Only line 1 is shown: an edit on line 2 must be rejected, which proves a
	// snapshot was retained; with none, the guard accepts any edit under a matching tag.
	async function expectOnlyLine1Credited(bomCount: number): Promise<void> {
		const session = createSession(cwd);
		const target = path.join(cwd, "f.txt");
		const bom = [0xef, 0xbb, 0xbf];
		const prefix = Array.from({ length: bomCount }, () => bom).flat();
		await Bun.write(target, new Uint8Array([...prefix, ...Buffer.from("hello\nworld\n")]));
		const output = await bash(session, "cat -n f.txt | head -n 1");
		expect(output).toContain(`${"\uFEFF".repeat(bomCount)}hello`);
		const [footer] = footers(output);
		expect(footers(output)).toMatchObject([{ path: "f.txt", lines: "1" }]);

		const hidden = await edit(session, `${footer.header}\nPUT 2.=2:\n+changed\n`);
		expect(hidden).toContain("never displayed");
		expect(Buffer.from(await Bun.file(target).bytes()).toString("utf8")).toBe(
			`${"\uFEFF".repeat(bomCount)}hello\nworld\n`,
		);

		await edit(session, `${footer.header}\nPUT 1.=1:\n+changed\n`);
		const after = Buffer.from(await Bun.file(target).bytes()).toString("utf8");
		expect(after).toContain("changed\nworld\n");
		expect(after).not.toContain("hello");
	}

	it("credits line 1 of a BOM file shown with its BOM", () => expectOnlyLine1Credited(1));

	// The store and the patcher remove exactly one BOM, so a second one is content and part of the tag.
	it("removes exactly one BOM of a file that starts with two", () => expectOnlyLine1Credited(2));

	it("does not credit a BOM-prefixed row of a file without a BOM", async () => {
		const session = createSession(cwd);
		await Bun.write(path.join(cwd, "g.txt"), "hello\nworld\n");
		const output = await bash(session, "printf '1:\\357\\273\\277hello\\n' && test -f g.txt");
		expect(output).toContain("1:\uFEFFhello");
		expect(footers(output)).toEqual([]);
	});

	// Without hashline edits there is no tag to show or guard to satisfy.
	it("does nothing outside hashline mode", async () => {
		const session = createSession(cwd, { settings: { "edit.mode": "replace" } });
		const output = await bash(session, "grep -n 'value_35$' values.txt");
		expect(output).toContain("35:line 35: value_35");
		expect(footers(output)).toEqual([]);
	});

	// Edit addresses a notebook's cell text, not its JSON rows: a tag for the raw JSON would not match, and its row
	// numbers do not address the editable text.
	it("does not credit rows of a notebook", async () => {
		const session = createSession(cwd);
		const notebook = JSON.stringify({ cells: [{ cell_type: "code", source: ["needle = 1\n"] }] }, null, 1);
		await Bun.write(path.join(cwd, "nb.ipynb"), `${notebook}\n`);
		const output = await bash(session, "grep -n needle nb.ipynb");
		expect(output).toContain("needle = 1");
		expect(footers(output)).toEqual([]);
	});

	// Output that only looks numbered (a failing build's `path:line:col` diagnostics) can name many large files;
	// without a total budget every one would be read and hashed for no credit. Files past the budget get none.
	it("stops reading candidate files past the total byte budget", async () => {
		const session = createSession(cwd);
		const filler = `${"x".repeat(1023)}\n`.repeat(3 * 1024);
		for (const name of ["a.txt", "b.txt", "c.txt"]) await Bun.write(path.join(cwd, name), `needle\n${filler}`);
		const output = await bash(session, "grep -n needle a.txt b.txt c.txt");
		expect(output).toContain("c.txt:1:needle");
		expect(footers(output).map(footer => [footer.path, footer.lines])).toEqual([
			["a.txt", "1"],
			["b.txt", "1"],
		]);
	});

	// T4: path-prefixed rows credit every file they name, one footer line each.
	it("credits each file of a recursive grep -rn", async () => {
		const session = createSession(cwd);
		await Bun.write(path.join(cwd, "src", "a.txt"), "alpha\nneedle a\nomega\n");
		await Bun.write(path.join(cwd, "src", "b.txt"), "needle b\nbeta\n");
		const output = await bash(session, "grep -rn needle src");
		expect(output).toContain("src/a.txt:2:needle a");
		expect(output).toContain("src/b.txt:1:needle b");
		const found = footers(output);
		expect(found.map(footer => [footer.path, footer.lines]).sort()).toEqual([
			["src/a.txt", "2"],
			["src/b.txt", "1"],
		]);
		const byPath = new Map(found.map(footer => [footer.path, footer]));

		await edit(session, `${byPath.get("src/b.txt")?.header}\nPUT 1.=1:\n+needle changed\n`);
		expect(await Bun.file(path.join(cwd, "src", "b.txt")).text()).toBe("needle changed\nbeta\n");
	});

	// T5: paths to the same file. The tool hoists a leading `cd sub &&` into the command's cwd, so the first row
	// checks that rows resolve against the cwd the command ran in; the others keep their `cd` in the command and
	// check the literal `cd` targets as resolution bases: chained (`cd a && cd b` is `a/b`, no single target names
	// it) and after a failed `cd` (`cd missing || cd b` runs `cd b` from the cwd, not from `missing`).
	it.each([
		["cd sub && grep -n needle f.txt", "sub"],
		["test -d sub && cd sub && grep -n needle f.txt", "sub"],
		["test -d a && cd a && cd b && grep -n needle f.txt", "a/b"],
		["cd missing || cd b && grep -n needle f.txt", "b"],
	])("credits a file named relative to a cd target: %s", async (command, dir) => {
		const session = createSession(cwd);
		const target = path.join(cwd, dir, "f.txt");
		await Bun.write(target, "first\nneedle here\nlast\n");
		const output = await bash(session, command);
		expect(output).toContain("2:needle here");
		const [footer, ...rest] = footers(output);
		expect(rest).toEqual([]);
		expect(footer).toMatchObject({ path: `${dir}/f.txt`, lines: "2" });

		await edit(session, `${footer.header}\nPUT 2.=2:\n+needle moved\n`);
		expect(await Bun.file(target).text()).toBe("first\nneedle moved\nlast\n");
	});

	// D14: a subshell group makes the whole command "non-flat"; its `cd` target and file words still count.
	it("credits a file named inside a parenthesized subshell", async () => {
		const session = createSession(cwd);
		await Bun.write(path.join(cwd, "sub", "f.txt"), "first\nneedle here\nlast\n");
		const output = await bash(session, "(cd sub && grep -n needle f.txt)");
		expect(output).toContain("2:needle here");
		expect(footers(output)).toMatchObject([{ path: "sub/f.txt", lines: "2" }]);
	});

	// D13: shell output carries no tool-input prefixes. A leading `:` is part of the printed path, so
	// `:/abs/values.txt` names no file (tool-input normalization would strip it and credit values.txt).
	it("does not strip a leading colon from a path printed in a row", async () => {
		const session = createSession(cwd);
		const plain = await bash(session, `printf '%s:35:line 35: value_35\\n' '${file}'`);
		expect(footers(plain)).toMatchObject([{ path: "values.txt", lines: "35" }]);

		const colon = await bash(session, `printf ':%s:35:line 35: value_35\\n' '${file}'`);
		expect(colon).toContain(":35:line 35: value_35");
		expect(footers(colon)).toEqual([]);
	});

	// A comment names no file: its words are neither candidates (which would make two files named and drop the bare
	// rows) nor a `cd` base, and an apostrophe in one must not open a quote that swallows the command. The last row is
	// non-flat (`${...}`), where the whole command is tokenized without the extractor's comment handling.
	it.each([
		"# Let's look\ngrep -n 'value_35$' values.txt",
		"grep -n 'value_35$' values.txt # compare with other.txt",
		`PAT=value_35; grep -n \${PAT} values.txt # compare with other.txt`,
	])("ignores comment text when naming files: %s", async command => {
		const session = createSession(cwd);
		await Bun.write(path.join(cwd, "other.txt"), SOURCE);
		const output = await bash(session, command);
		expect(output).toContain("35:line 35: value_35");
		expect(footers(output)).toMatchObject([{ path: "values.txt", lines: "35" }]);
	});

	// A quoted `#` is an argument, not a comment: dropping the words after it would lose the file name. Flat
	// command first, then one the extractor declines (a subshell), which takes the comment-aware fallback.
	it.each(["grep -n '#*value_35$' values.txt", "(grep -n '#*value_35$' values.txt)"])(
		"keeps words after a quoted # argument: %s",
		async command => {
			const session = createSession(cwd);
			const output = await bash(session, command);
			expect(output).toContain("35:line 35: value_35");
			expect(footers(output)).toMatchObject([{ path: "values.txt", lines: "35" }]);
		},
	);

	// T6 (D11): a program (eval `tool.bash`, the shell tool-command bridge) reads the result, not the model. Crediting
	// its rows would mark lines the model never saw as seen, and the footer would corrupt what the script parses.
	it("neither tags nor credits a programmatic call's rows", async () => {
		const session = createSession(cwd);
		const result = await new BashTool(session).execute(
			"bash",
			{ command: "grep -n 'value_35$' values.txt" },
			undefined,
			undefined,
			{ programmatic: true } as unknown as Parameters<BashTool["execute"]>[4],
		);
		const output = textOutput(result);
		expect(output.trimEnd()).toBe("35:line 35: value_35");
		expect(output).not.toContain("[values.txt#");
		expect(footers(output)).toEqual([]);
		expect(result.details?.editTags).toBeUndefined();

		const read = textOutput(await new ReadTool(session).execute("read", { path: "values.txt:30-31" }));
		const header = read.split("\n")[0];
		expect(header).toMatch(/^\[values\.txt#[0-9A-F]{4}\]$/);
		expect(await edit(session, `${header}\nPUT 35.=35:\n+line 35: changed\n`)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(SOURCE);
	});

	// D25/D29: the ACP client-terminal path credits the model's result like the direct path, and never a program's.
	describe("through the client bridge", () => {
		function bridgeSession(): ToolSession {
			const shell = path.join(cwd, "bash");
			// The route only forwards the shell path to the stubbed terminal, but `getShellConfig` needs it to exist.
			fs.writeFileSync(shell, "");
			const handle: ClientBridgeTerminalHandle = {
				terminalId: "term-seen",
				waitForExit: async () => ({ exitCode: 0, signal: null }),
				currentOutput: async () => ({ output: "35:line 35: value_35\n", truncated: false }),
				kill: async () => {},
				release: async () => {},
			};
			const clientBridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
			return createSession(cwd, { clientBridge, settings: { shellPath: shell } });
		}

		it("credits a model call's rows", async () => {
			const session = bridgeSession();
			const result = await new BashTool(session).execute("bash", { command: "grep -n 'value_35$' values.txt" });
			const [footer, ...rest] = footers(textOutput(result));
			expect(rest).toEqual([]);
			expect(footer).toMatchObject({ path: "values.txt", lines: "35" });
			expect(result.details?.editTags).toEqual([`${footer.header} line 35`]);

			await edit(session, `${footer.header}\nPUT 35.=35:\n+line 35: changed\n`);
			expect(await Bun.file(file).text()).toBe(SOURCE.replace("line 35: value_35", "line 35: changed"));
		});

		it("credits nothing for a program's call", async () => {
			const session = bridgeSession();
			const result = await new BashTool(session).execute(
				"bash",
				{ command: "grep -n 'value_35$' values.txt" },
				undefined,
				undefined,
				{ programmatic: true } as unknown as Parameters<BashTool["execute"]>[4],
			);
			expect(textOutput(result)).toContain("35:line 35: value_35");
			expect(footers(textOutput(result))).toEqual([]);
			expect(result.details?.editTags).toBeUndefined();
		});
	});
});
