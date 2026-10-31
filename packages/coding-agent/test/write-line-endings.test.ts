import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { rejectionOf } from "./helpers/rejection";

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("write tool keeps the replaced file's line endings and BOM", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-line-endings-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("writes CRLF when replacing a CRLF file with LF content", async () => {
		const filePath = path.join(tmpDir, "build.bat");
		await fs.writeFile(filePath, "@echo off\r\necho old\r\n");

		const result = await new WriteTool(createSession(tmpDir)).execute("call-1", {
			path: filePath,
			content: "@echo off\necho new\n",
		});

		expect(await fs.readFile(filePath, "latin1")).toBe("@echo off\r\necho new\r\n");
		expect(resultText(result)).toContain(
			"Successfully wrote 21 bytes to build.bat\nNote: kept the replaced file's CRLF line endings.",
		);
	});

	it("keeps a UTF-8 BOM when replacing a BOM file", async () => {
		const filePath = path.join(tmpDir, "notes.txt");
		await fs.writeFile(filePath, "\uFEFFhello\nworld\n");

		await new WriteTool(createSession(tmpDir)).execute("call-1", { path: filePath, content: "hello\nthere\n" });

		expect([...(await fs.readFile(filePath)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(await fs.readFile(filePath, "utf8")).toBe("\uFEFFhello\nthere\n");
	});

	it("keeps both CRLF and the BOM, and the returned tag edits the file", async () => {
		const filePath = path.join(tmpDir, "Program.cs");
		await fs.writeFile(filePath, "\uFEFFclass A {}\r\n");
		const session = createSession(tmpDir);

		const writeResult = await new WriteTool(session).execute("call-1", {
			path: filePath,
			content: "class A {}\nclass B {}\n",
		});
		expect(await fs.readFile(filePath, "utf8")).toBe("\uFEFFclass A {}\r\nclass B {}\r\n");
		expect(resultText(writeResult)).toContain("Note: kept the replaced file's CRLF line endings and UTF-8 BOM.");

		const headerLine = resultText(writeResult).split("\n")[0] ?? "";
		await new EditTool(session, "hashline").execute("call-2", {
			input: `${headerLine}\nPUT 2.=2:\n+class C {}\n`,
		});
		expect(await fs.readFile(filePath, "utf8")).toBe("\uFEFFclass A {}\r\nclass C {}\r\n");
	});

	it("writes content that already has carriage returns as given", async () => {
		const crlfPath = path.join(tmpDir, "crlf.txt");
		await fs.writeFile(crlfPath, "a\r\nb\r\n");
		const crlfResult = await new WriteTool(createSession(tmpDir)).execute("call-1", {
			path: crlfPath,
			content: "x\ny\r\n",
		});
		expect(await fs.readFile(crlfPath, "latin1")).toBe("x\ny\r\n");
		expect(resultText(crlfResult)).not.toContain("Note: kept");

		const lfPath = path.join(tmpDir, "lf.txt");
		await fs.writeFile(lfPath, "a\nb\n");
		await new WriteTool(createSession(tmpDir)).execute("call-2", { path: lfPath, content: "x\r\ny\r\n" });
		expect(await fs.readFile(lfPath, "latin1")).toBe("x\r\ny\r\n");
	});

	it("writes new files and replaced LF or binary files as given", async () => {
		const tool = new WriteTool(createSession(tmpDir));

		const newPath = path.join(tmpDir, "new.txt");
		await tool.execute("call-1", { path: newPath, content: "a\nb\n" });
		expect(await fs.readFile(newPath, "latin1")).toBe("a\nb\n");

		const lfPath = path.join(tmpDir, "lf.txt");
		await fs.writeFile(lfPath, "a\nb\n");
		const lfResult = await tool.execute("call-2", { path: lfPath, content: "c\nd\n" });
		expect(await fs.readFile(lfPath, "latin1")).toBe("c\nd\n");
		expect(resultText(lfResult)).not.toContain("Note: kept");

		// A PNG signature has a CRLF pair and NUL bytes: it says nothing about text line endings.
		const pngPath = path.join(tmpDir, "image.png");
		await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
		await tool.execute("call-3", { path: pngPath, content: "not an image\nanymore\n" });
		expect(await fs.readFile(pngPath, "latin1")).toBe("not an image\nanymore\n");
	});

	it("does not leave a lone BOM when emptying a BOM file", async () => {
		const filePath = path.join(tmpDir, "empty.txt");
		await fs.writeFile(filePath, "\uFEFFold\r\n");
		await new WriteTool(createSession(tmpDir)).execute("call-1", { path: filePath, content: "" });
		expect((await fs.readFile(filePath)).length).toBe(0);
	});

	it("finds the first line break past the binary sniff window", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		// 8190 puts the CRLF inside the 8 KiB window, 8191 splits it across the edge, 9000 is past it.
		for (const firstLineLength of [8190, 8191, 9000]) {
			const filePath = path.join(tmpDir, `long-${firstLineLength}.txt`);
			await fs.writeFile(filePath, `${"a".repeat(firstLineLength)}\r\nold\r\n`);
			await tool.execute(`call-${firstLineLength}`, { path: filePath, content: "new\ntext\n" });
			expect(await fs.readFile(filePath, "latin1")).toBe("new\r\ntext\r\n");
		}
	});

	it("follows the first line break of a mixed file, as edit does", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const lfFirst = path.join(tmpDir, "lf-first.txt");
		await fs.writeFile(lfFirst, "a\nb\r\nc\r\n");
		await tool.execute("call-1", { path: lfFirst, content: "x\ny\n" });
		expect(await fs.readFile(lfFirst, "latin1")).toBe("x\ny\n");

		const crlfFirst = path.join(tmpDir, "crlf-first.txt");
		await fs.writeFile(crlfFirst, "a\r\nb\nc\n");
		await tool.execute("call-2", { path: crlfFirst, content: "x\ny\n" });
		expect(await fs.readFile(crlfFirst, "latin1")).toBe("x\r\ny\r\n");
	});

	it("names nothing for a write that a later call in the same batch will format", async () => {
		const filePath = path.join(tmpDir, "batched.bat");
		await fs.writeFile(filePath, "@echo off\r\n");
		const context = {
			toolCall: {
				batchId: "batch-1",
				index: 0,
				total: 2,
				toolCalls: [
					{ id: "call-1", name: "write" },
					{ id: "call-2", name: "edit" },
				],
			},
		} as unknown as AgentToolContext;

		const result = await new WriteTool(createSession(tmpDir)).execute(
			"call-1",
			{ path: filePath, content: "@echo on\n" },
			undefined,
			undefined,
			context,
		);

		expect(await fs.readFile(filePath, "latin1")).toBe("@echo on\r\n");
		expect(resultText(result)).not.toContain("Note: kept");
	});

	it("sends an ACP editor the content as given, since its save applies the buffer's own convention", async () => {
		const filePath = path.join(tmpDir, "Editor.cs");
		await fs.writeFile(filePath, "\uFEFFclass A {}\r\n");
		const sent: string[] = [];
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true, writeTextFile: true },
			readTextFile: async () => "class A {}\r\n",
			writeTextFile: async ({ path: target, content }) => {
				sent.push(content);
				await Bun.write(target, content);
			},
		};

		const result = await new WriteTool(createSession(tmpDir, bridge)).execute("call-1", {
			path: filePath,
			content: "class B {}\n",
		});

		expect(sent).toEqual(["class B {}\n"]);
		expect(resultText(result)).toContain("Successfully wrote 11 bytes to Editor.cs");
		expect(resultText(result)).not.toContain("Note: kept");
	});

	it("does not write once the call is cancelled during a long first-line scan", async () => {
		const filePath = path.join(tmpDir, "one-line.txt");
		const original = `${"a".repeat(200_000)}\r\n`;
		await fs.writeFile(filePath, original);
		const controller = new AbortController();
		// `untilAborted` rejects at once and lets the work run on; it removes its abort listener when
		// that work settles, which is the point to check the file.
		const settled = Promise.withResolvers<void>();
		const signal = controller.signal;
		const removeListener = signal.removeEventListener.bind(signal);
		signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => {
			removeListener(...args);
			settled.resolve();
		};
		// Cancel when the scan reads past the 8 KiB sniff window.
		const realFile = Bun.file;
		const fileSpy = spyOn(Bun, "file").mockImplementation(((target: string, options?: BlobPropertyBag) => {
			const file = realFile(target, options);
			if (target !== filePath) return file;
			return new Proxy(file, {
				get(base, key) {
					if (key === "slice") {
						return (start?: number, end?: number) => {
							if ((start ?? 0) > 0) controller.abort();
							return base.slice(start, end);
						};
					}
					const value = Reflect.get(base, key, base);
					return typeof value === "function" ? value.bind(base) : value;
				},
			});
		}) as typeof Bun.file);

		try {
			const call = new WriteTool(createSession(tmpDir)).execute(
				"call-1",
				{ path: filePath, content: "replaced\n" },
				signal,
			);
			await rejectionOf(call);
			await settled.promise;
		} finally {
			fileSpy.mockRestore();
		}
		expect(await fs.readFile(filePath, "latin1")).toBe(original);
	});
});
