import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir, tryParseJson } from "@oh-my-pi/pi-utils";
import { invalidate as invalidateCapabilityFsCache, readFile } from "../../src/capability/fs";

// Discovery reads a user's files — `AGENTS.md`, `.mcp.json`, and the rest — through
// `capability/fs.readFile`. That read used `Bun.file().text()`, which drops a leading
// byte-order mark; this pull request routes it through the stat-first helper, which reads
// bytes as `node:fs` does and keeps the mark. A consumer that parses the text with the
// plain `JSON.parse` (`.mcp.json` goes through `tryParseJson`) then fails on a mark it used
// to tolerate. So the read drops one mark again, to stay byte-for-byte what it was before.
//
// This is the proof that the drop restores prior behaviour rather than adding new behaviour:
// the `.mcp.json` case fails on the un-dropped conversion and passes once the mark is dropped.
const BOM = "\uFEFF";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-discovery-bom-");
});

afterEach(() => {
	tempDir.removeSync();
});

/** A file at a fresh path under the sandbox, read through discovery's own reader. */
async function readThroughDiscovery(name: string, bytes: string): Promise<string | null> {
	const at = path.join(tempDir.path(), name);
	fs.writeFileSync(at, bytes);
	invalidateCapabilityFsCache(at);
	return readFile(at);
}

describe("a discovery read drops a leading byte-order mark, as Bun.file().text() did", () => {
	it("a .mcp.json with a byte-order mark still parses as JSON", async () => {
		const body = `{"mcpServers":{"demo":{"command":"demo"}}}`;
		const content = await readThroughDiscovery(".mcp.json", `${BOM}${body}`);

		// The consumer: `discovery/mcp-json.ts` parses this text with `tryParseJson` (plain `JSON.parse`).
		expect(content).not.toBeNull();
		const parsed = tryParseJson<{ mcpServers: Record<string, unknown> }>(content ?? "");
		expect(parsed).not.toBeNull();
		expect(Object.keys(parsed?.mcpServers ?? {})).toEqual(["demo"]);
		// And the text itself no longer carries the mark.
		expect(content?.charCodeAt(0)).not.toBe(0xfeff);
	});

	it("the mark is dropped from any discovery file, byte-for-byte", async () => {
		const content = await readThroughDiscovery("AGENTS.md", `${BOM}# Title\n`);
		expect(content).toBe("# Title\n");
	});

	it("a file with no mark is returned unchanged", async () => {
		const body = `{"mcpServers":{}}`;
		const content = await readThroughDiscovery(".mcp.json", body);
		expect(content).toBe(body);
	});
});
