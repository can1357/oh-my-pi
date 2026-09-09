import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractFileMentions, generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await removeWithRetries(dir);
	}
});

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-mentions-"));
	tempDirs.push(dir);
	return dir;
}

describe("generateFileMentionMessages path resolution", () => {
	test("auto-reads an exact file path", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await Bun.write(path.join(cwd, "src", "config.ts"), "export const x = 1;");

		const messages = await generateFileMentionMessages(["src/config.ts"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(1);
		expect(message.files[0]?.path).toBe("src/config.ts");
		expect(message.files[0]?.content).toContain("export const x = 1;");
	});

	test("lists an exact directory path", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await Bun.write(path.join(cwd, "src", "index.ts"), "ok");

		const messages = await generateFileMentionMessages(["src"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files[0]?.path).toBe("src");
		expect(message.files[0]?.content).toContain("index.ts");
	});

	test("does not fuzzy- or prefix-resolve mentions that are not real paths", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "docs", "readme.md"), "hello");
		await fs.mkdir(path.join(cwd, "assets"), { recursive: true });
		await Bun.write(path.join(cwd, "assets", "widget-input.svg"), "<svg/>");

		// Partial path (old prefix match), scope-style token and bare substring (old fuzzy
		// match) must all resolve to nothing: the @-selector turns these into real paths
		// before send, so an unresolved mention is prose, not a file reference.
		expect(await generateFileMentionMessages(["docs/rea"], cwd)).toHaveLength(0);
		expect(await generateFileMentionMessages(["widget/"], cwd)).toHaveLength(0);
		expect(await generateFileMentionMessages(["widget"], cwd)).toHaveLength(0);
	});

	test("reads only the mentions that resolve to real paths", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "real.txt"), "present");

		const messages = await generateFileMentionMessages(["real.txt", "does-not-exist.txt"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(1);
		expect(message.files[0]?.path).toBe("real.txt");
		expect(message.files[0]?.content).toContain("present");
	});

	test("resolves quoted paths containing spaces", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "My Folder"), { recursive: true });
		await Bun.write(path.join(cwd, "My Folder", "my file.png"), "image content");

		const mentions = extractFileMentions("Please see @\"My Folder/my file.png\" and @'My Folder/my file.png'");
		expect(mentions).toEqual(["My Folder/my file.png"]);

		const messages = await generateFileMentionMessages(mentions, cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(1);
		expect(message.files[0]?.path).toBe("My Folder/my file.png");
	});

	test("skips auto-reading a binary file instead of injecting raw bytes", async () => {
		const cwd = await createTempDir();
		// TTF header begins with a NUL run; auto-reading it as text would leak
		// control bytes into the conversation (the reported bug).
		await Bun.write(path.join(cwd, "Silver.ttf"), Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x0c, 0x4f, 0x53]));
		// A non-NUL invalid-UTF8 blob must be refused too, not just NUL-bearing files.
		await Bun.write(path.join(cwd, "blob.bin"), Buffer.from([0x4d, 0x5a, 0xff, 0xfe, 0xc0, 0xc0]));

		const messages = await generateFileMentionMessages(["Silver.ttf", "blob.bin"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(2);
		for (const file of message.files) {
			expect(file.skippedReason).toBe("binary");
			expect(file.content).toContain("binary file");
			expect(file.content).not.toContain("\u0000");
		}
	});
});
