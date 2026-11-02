import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { WriteTool } from "../../src/tools/write";

const [archive, member] = process.argv.slice(2);
if (!archive || !member) throw new Error("Expected archive path and member name");
const cwd = path.dirname(archive);
const session: ToolSession = {
	cwd,
	hasUI: false,
	settings: Settings.isolated(),
	getSessionFile: () => path.join(cwd, "session.jsonl"),
	getSessionSpawns: () => "*",
	getArtifactsDir: () => cwd,
	allocateOutputArtifact: async () => ({ id: "1", path: path.join(cwd, "output.log") }),
};

process.stdout.write("ready\n");
await Bun.stdin.stream().getReader().read();
const result = await new WriteTool(session).execute(member, {
	path: `${archive}:${member}.txt`,
	content: `new ${member}`,
});
if (result.isError) throw new Error(JSON.stringify(result.content));
process.stdout.write("success\n");
