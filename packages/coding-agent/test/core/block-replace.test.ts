import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatHashlineHeader } from "@pk-nerdsaver-ai/hashline";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	getFileSnapshotStore,
} from "@pk-nerdsaver-ai/pi-coding-agent/edit";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "block-replace-"));
	try {
		await fn(tempDir);
	} finally {
		await removeWithRetries(tempDir);
	}
}

function makeSession(tempDir: string): ToolSession {
	return { cwd: tempDir, settings: Settings.isolated() } as ToolSession;
}

function executeOptions(_tempDir: string, input: string, session: ToolSession): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

/**
 * Set up a file on disk + a recorded snapshot tag, returning the hashline
 * section header bound to the current content.
 */
async function seedFile(
	tempDir: string,
	session: ToolSession,
	name: string,
	source: string,
): Promise<{ filePath: string; header: string }> {
	const filePath = path.join(tempDir, name);
	await Bun.write(filePath, source);
	const tag = getFileSnapshotStore(session).record(filePath, source);
	return { filePath, header: formatHashlineHeader(name, tag) };
}

const TS_SOURCE = "function x() {\n  if (y) {\n  }\n}\n";
const ELISP_SOURCE = ["(ert-deftest ogent-zen-test ()", '  "Doc."', "  (should t))", ""].join("\n");

describe("SWAP.BLK — native tree-sitter resolution end-to-end", () => {
	it("resolves the inner `if` block (line 2) and replaces its full span", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nSWAP.BLK 2:\n+  if (y || z) {\n+  }`;

			await executeHashlineSingle(executeOptions(tempDir, input, session));

			expect(await Bun.file(filePath).text()).toBe("function x() {\n  if (y || z) {\n  }\n}\n");
		});
	});

	it("resolves the enclosing function block (line 1) and replaces the whole construct", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nSWAP.BLK 1:\n+function x() {\n+  return 42;\n+}`;

			await executeHashlineSingle(executeOptions(tempDir, input, session));

			expect(await Bun.file(filePath).text()).toBe("function x() {\n  return 42;\n}\n");
		});
	});

	it("deletes the resolved `if` block (line 2) end-to-end via `DEL.BLK`", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nDEL.BLK 2`;

			await executeHashlineSingle(executeOptions(tempDir, input, session));

			expect(await Bun.file(filePath).text()).toBe("function x() {\n}\n");
		});
	});

	it("inserts after an Emacs Lisp top-level macro-style form", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "ogent-zen-tests.el", ELISP_SOURCE);
			const input = `${header}\nINS.BLK.POST 1:\n+\n+(ert-deftest ogent-zen-second-test ()\n+  (should-not nil))`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

			expect(await Bun.file(filePath).text()).toBe(
				[
					"(ert-deftest ogent-zen-test ()",
					'  "Doc."',
					"  (should t))",
					"",
					"(ert-deftest ogent-zen-second-test ()",
					"  (should-not nil))",
					"",
				].join("\n"),
			);
			expect(text).toContain("INS.BLK.POST 1 → resolved lines 1-3 (3 lines); body lands after line 3");
		});
	});
	it("inserts after an extensionless .emacs top-level form", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, ".emacs", ELISP_SOURCE);
			const input = `${header}\nINS.BLK.POST 1:\n+\n+(message "loaded")`;

			await executeHashlineSingle(executeOptions(tempDir, input, session));

			expect(await Bun.file(filePath).text()).toBe(
				["(ert-deftest ogent-zen-test ()", '  "Doc."', "  (should t))", "", '(message "loaded")', ""].join("\n"),
			);
		});
	});

	it("reports the diff for a resolved block edit", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nSWAP.BLK 2:\n+  if (y || z) {\n+  }`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("if (y || z)");
		});
	});

	it("echoes the resolved span in the result text for SWAP.BLK", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nSWAP.BLK 1:\n+function x() {\n+  return 42;\n+}`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

			// `function x() {` opens on line 1; tree-sitter resolves the whole body (lines 1-4).
			expect(text).toContain("SWAP.BLK 1 → resolved lines 1-4 (4 lines)");
		});
	});

	it("echoes the resolved span in the result text for DEL.BLK", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nDEL.BLK 2`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

			// `if (y) {` opens on line 2; resolves lines 2-3.
			expect(text).toContain("DEL.BLK 2 → resolved lines 2-3 (2 lines)");
		});
	});

	it("rejects a lone closing delimiter (no block begins there) and steers to `SWAP N.=M:`", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			// Line 3 is `  }` — a closing delimiter, not a block opener.
			const input = `${header}\nSWAP.BLK 3:\n+  }`;

			// Steers to the concrete form and previews the file around the anchor (`*`-marked).
			await expect(executeHashlineSingle(executeOptions(tempDir, input, session))).rejects.toThrow(
				/could not resolve a syntactic block beginning on line 3.*SWAP 3\.=M:.*^ 1:function x\(\) \{$.*^\*3: {2}\}$/ms,
			);
			// Disk untouched — refusal never leaves a partial write.
			expect(await Bun.file(filePath).text()).toBe(TS_SOURCE);
		});
	});

	it("rejects a block edit on an unrecognized language", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const source = "alpha\nbeta\ngamma\n";
			const { filePath, header } = await seedFile(tempDir, session, "data.unknownext", source);
			const input = `${header}\nSWAP.BLK 1:\n+ALPHA`;

			await expect(executeHashlineSingle(executeOptions(tempDir, input, session))).rejects.toThrow(
				/could not resolve a syntactic block/,
			);
			expect(await Bun.file(filePath).text()).toBe(source);
		});
	});
});

const MD_PLAN = [
	"# Plan",
	"intro",
	"",
	"## Context",
	"why this matters",
	"more context",
	"",
	"### Detail",
	"deep note",
	"",
	"## Approach",
	"step one",
	"",
].join("\n");

describe("block ops on markdown headings — whole-section resolution end-to-end", () => {
	it("DEL.BLK at a `## H2` deletes the entire section, including nested subsections", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			// Line 4 is `## Context`; its section runs through `### Detail` and
			// the trailing blank, up to `## Approach`.
			const { filePath, header } = await seedFile(tempDir, session, "plan.md", MD_PLAN);
			const input = `${header}\nDEL.BLK 4`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

			expect(await Bun.file(filePath).text()).toBe(
				["# Plan", "intro", "", "## Approach", "step one", ""].join("\n"),
			);
			expect(text).toContain("DEL.BLK 4 → resolved lines 4-10 (7 lines)");
		});
	});

	it("INS.BLK.POST at a `## H2` lands after the whole section, past nested subsections", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "plan.md", MD_PLAN);
			const input = `${header}\nINS.BLK.POST 4:\n+## Verification\n+run the suite\n+`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

			// The new section is inserted after the `## Context` section (line
			// 10), before `## Approach` — not inside it after `### Detail`.
			expect(await Bun.file(filePath).text()).toBe(
				[
					"# Plan",
					"intro",
					"",
					"## Context",
					"why this matters",
					"more context",
					"",
					"### Detail",
					"deep note",
					"",
					"## Verification",
					"run the suite",
					"",
					"## Approach",
					"step one",
					"",
				].join("\n"),
			);
			expect(text).toContain("INS.BLK.POST 4 → resolved lines 4-10 (7 lines); body lands after line 10");
		});
	});
});
