import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore } from "@oh-my-pi/pi-coding-agent/edit";
import { formatHashlineHeader } from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tempDir: string;

afterEach(async () => {
	resetSettingsForTest();
	if (tempDir) await removeWithRetries(tempDir);
});

async function sessionIn(dir: string): Promise<ToolSession> {
	resetSettingsForTest();
	const settings = await Settings.loadIsolated({
		cwd: dir,
		agentDir: path.join(dir, "agent"),
		inMemory: true,
		overrides: { "edit.enforceSeenLines": false },
	});
	return {
		cwd: dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings,
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

async function applyHashline(session: ToolSession, name: string, text: string, body: string): Promise<string> {
	const absolute = path.join(session.cwd, name);
	await Bun.write(absolute, text);
	const tag = getEditStore(session).recordSnapshot(absolute, text);
	const result = await new EditTool(session, "hashline").execute("boundary-repeat", {
		input: `${formatHashlineHeader(name, tag)}\n${body}`,
	});
	expect(result.isError, result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toBeFalsy();
	return Bun.file(absolute).text();
}

test("keeps a replacement row that repeats the line just outside the range", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-boundary-repeat-"));
	const session = await sessionIn(tempDir);
	const text = "alpha\nbeta\ngamma\nomega";

	expect(await applyHashline(session, "example.txt", text, "PUT 2.=3:\n+alpha\n+beta\n+gamma")).toBe(
		"alpha\nalpha\nbeta\ngamma\nomega",
	);
	expect(await applyHashline(session, "trail.txt", text, "PUT 2.=3:\n+beta\n+gamma\n+omega")).toBe(
		"alpha\nbeta\ngamma\nomega\nomega",
	);
	expect(
		await applyHashline(
			session,
			"f.ts",
			"function f() {\n  keep();\n  old();\n  next();\n}\n",
			"PUT 3.=4:\n+  keep();\n+  fresh();\n+  next();",
		),
	).toBe("function f() {\n  keep();\n  keep();\n  fresh();\n  next();\n}\n");
});
