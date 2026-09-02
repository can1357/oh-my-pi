import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatHashlineHeader } from "@oh-my-pi/hashline";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalSnapshotKey, EditTool, getFileSnapshotStore, type PatchParams } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { EditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const MODEL = "openai/gpt-5.6";
const SOURCE = "export function value(): number {\n\treturn 1;\n}\n";

function makeSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => MODEL,
		enableLsp: false,
		settings,
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

let tempDir: string;
let agentDir: string;
let logPath: string;
let settings: Settings;
let session: ToolSession;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-blackbox-"));
	agentDir = path.join(tempDir, "agent");
	logPath = path.join(agentDir, "edit-blackbox.jsonl");
	await fs.mkdir(agentDir, { recursive: true });
	settings = await Settings.loadIsolated({
		cwd: tempDir,
		agentDir,
		inMemory: true,
		overrides: { "edit.enforceSeenLines": false, "edit.blackbox.enabled": true },
	});
	session = makeSession(tempDir, settings);
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

async function writeFixture(name: string): Promise<string> {
	const absolutePath = path.join(tempDir, name);
	await Bun.write(absolutePath, SOURCE);
	return absolutePath;
}

describe("edit parse-regression blackbox", () => {
	test("is disabled by default", async () => {
		const disabledSettings = await Settings.loadIsolated({
			cwd: tempDir,
			agentDir,
			inMemory: true,
			overrides: { "edit.enforceSeenLines": false },
		});
		const disabledSession = makeSession(tempDir, disabledSettings);
		const filePath = await writeFixture("disabled.ts");

		const result = await new EditTool(disabledSession, "replace").execute("disabled", {
			path: "disabled.ts",
			old_string: "return 1;",
			new_string: "return (;",
		});

		expect(await Bun.file(filePath).text()).toContain("return (;");
		expect(await Bun.file(logPath).exists()).toBe(false);
		// The parse-regression warning is independent of blackbox recording.
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toMatch(/no longer parses after this edit/);
	});
	test("does not warn when the edit keeps the file parsing", async () => {
		await writeFixture("clean.ts");

		const result = await new EditTool(session, "replace").execute("clean", {
			path: "clean.ts",
			old_string: "return 1;",
			new_string: "return 2;",
		});

		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).not.toMatch(/no longer parses/);
	});

	test("appends valid-to-invalid transitions from every edit variant", async () => {
		await fs.appendFile(logPath, '{"seed":true}\n');
		const expected: Array<{
			prev: string;
			new: string;
			model: string;
			variant: EditMode;
			arg: unknown;
		}> = [];

		const replacePath = await writeFixture("replace.ts");
		const replaceArg = { path: "replace.ts", old_string: "return 1;", new_string: "return (;" };
		await new EditTool(session, "replace").execute("replace", replaceArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(replacePath).text(),
			model: MODEL,
			variant: "replace",
			arg: replaceArg,
		});

		const patchPath = await writeFixture("patch.ts");
		const patchArg = {
			path: "patch.ts",
			edits: [{ op: "update", diff: "@@\n-\treturn 1;\n+\treturn (;" }],
		} satisfies PatchParams;
		await new EditTool(session, "patch").execute("patch", patchArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(patchPath).text(),
			model: MODEL,
			variant: "patch",
			arg: patchArg,
		});

		const applyPatchPath = await writeFixture("apply-patch.ts");
		const applyPatchArg = {
			input: [
				"*** Begin Patch",
				"*** Update File: apply-patch.ts",
				"@@",
				"-\treturn 1;",
				"+\treturn (;",
				"*** End Patch",
				"",
			].join("\n"),
		};
		await new EditTool(session, "apply_patch").execute("apply-patch", applyPatchArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(applyPatchPath).text(),
			model: MODEL,
			variant: "apply_patch",
			arg: applyPatchArg,
		});

		const hashlinePath = await writeFixture("hashline.ts");
		const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(hashlinePath), SOURCE);
		const hashlineArg = {
			input: `${formatHashlineHeader("hashline.ts", tag)}\nPUT 2-2:\n+\treturn (;`,
		};
		await new EditTool(session, "hashline").execute("hashline", hashlineArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(hashlinePath).text(),
			model: MODEL,
			variant: "hashline",
			arg: hashlineArg,
		});

		const sloppyPath = await writeFixture("sloppy.ts");
		const sloppyArg = {
			input: '<SM:EDIT path="sloppy.ts">\n<SM:FIND>\n\treturn 1;\n</SM:FIND>\n<SM:PUT>\n\treturn (;\n</SM:PUT>',
		};
		await new EditTool(session, "sloppy").execute("sloppy", sloppyArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(sloppyPath).text(),
			model: MODEL,
			variant: "sloppy",
			arg: sloppyArg,
		});

		const lines = (await Bun.file(logPath).text()).trimEnd().split("\n");
		expect(JSON.parse(lines[0])).toEqual({ seed: true });
		expect(lines.slice(1).map(line => JSON.parse(line))).toEqual(expected);
	});

	test("does not record valid or already-invalid transitions", async () => {
		await writeFixture("valid.ts");
		await new EditTool(session, "replace").execute("valid", {
			path: "valid.ts",
			old_string: "return 1;",
			new_string: "return 2;",
		});

		await Bun.write(path.join(tempDir, "invalid.ts"), "export const value = (;\n");
		await new EditTool(session, "replace").execute("already-invalid", {
			path: "invalid.ts",
			old_string: "value",
			new_string: "next",
		});

		expect(await Bun.file(logPath).exists()).toBe(false);
	});

	test("treats an empty supported source as parseable", async () => {
		await writeFixture("empty.ts");
		await new EditTool(session, "replace").execute("empty", {
			path: "empty.ts",
			old_string: SOURCE,
			new_string: "",
		});

		expect(await Bun.file(path.join(tempDir, "empty.ts")).text()).toBe("");
		expect(await Bun.file(logPath).exists()).toBe(false);
	});
});
