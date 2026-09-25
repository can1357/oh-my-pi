import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openCloexecSync } from "../src/fs-open";
import { removeWithRetries } from "../src/temp";

const ROOTS: string[] = [];

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

async function mkRoot(): Promise<string> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fs-open-test-"));
	ROOTS.push(root);
	return root;
}

/**
 * The close-on-exec bit is OR-ed into the raw flags, so a wrong per-platform
 * value would come back as `EINVAL` from `open(2)` and take every session
 * append and log line down with it.
 */
test("appends through a descriptor the platform accepted", async () => {
	const root = await mkRoot();
	const target = path.join(root, "session.jsonl");
	const fd = openCloexecSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
	try {
		fs.writeSync(fd, "first\n");
		fs.writeSync(fd, "second\n");
	} finally {
		fs.closeSync(fd);
	}
	expect(await Bun.file(target).text()).toBe("first\nsecond\n");
});

test.skipIf(process.platform !== "linux")("marks the descriptor close-on-exec", async () => {
	const root = await mkRoot();
	const fd = openCloexecSync(path.join(root, "log"), fs.constants.O_WRONLY | fs.constants.O_CREAT);
	try {
		const flags = /^flags:\s+(\d+)$/m.exec(await Bun.file(`/proc/self/fdinfo/${fd}`).text())?.[1];
		expect(flags, "fdinfo did not report flags").toBeDefined();
		expect(Number.parseInt(flags as string, 8) & 0o2000000).not.toBe(0);
	} finally {
		fs.closeSync(fd);
	}
});
