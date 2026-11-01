import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/** argv[2]: `fail-closed` opens the way resume does (`throwIfMissing`), with its content-digest check; anything else opens plainly. */
const FAIL_CLOSED = process.argv[2] === "fail-closed";
/** argv[3]: synthetic session size in bytes, defaulting to just past the 2 GiB string limit. */
const TARGET_BYTES = Number(process.argv[3] ?? 2 ** 31 + 32 * 1024 * 1024);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-large-rewrite-"));
const cwd = path.join(root, "project");
const sessionDir = path.join(root, "sessions");
const sessionFile = path.join(sessionDir, "synthetic.jsonl");

async function liveBytes(): Promise<number> {
	for (let pass = 0; pass < 2; pass++) {
		Bun.gc(true);
		await Bun.sleep(0);
	}
	const memory = process.memoryUsage();
	return Math.max(memory.heapUsed, memory.external);
}

async function writeSyntheticSession(): Promise<number> {
	await fs.mkdir(sessionDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	const sink = Bun.file(sessionFile).writer({ highWaterMark: 1 << 20 });
	let bytes = 0;
	const write = (entry: unknown) => {
		const line = `${JSON.stringify(entry)}\n`;
		bytes += Buffer.byteLength(line, "utf8");
		sink.write(line);
	};
	const timestamp = "2026-10-11T00:00:00.000Z";
	write({ type: "session", version: 3, id: crypto.randomUUID(), timestamp, cwd });
	const item = "x".repeat(200);
	const items = Array.from({ length: 5_000 }, (_, index) => `${index}:${item}`);
	let parentId: string | null = null;
	for (let index = 0; bytes < TARGET_BYTES; index++) {
		const id = index.toString(16).padStart(8, "0");
		write({ type: "custom", customType: "synthetic-bloat", id, parentId, timestamp, data: { index, items } });
		parentId = id;
	}
	await sink.end();
	return bytes;
}

let manager: SessionManager | undefined;
try {
	const sourceBytes = await writeSyntheticSession();
	manager = await SessionManager.open(sessionFile, sessionDir, undefined, {
		throwIfMissing: FAIL_CLOSED,
		suppressBreadcrumb: true,
	});
	const liveBeforeRewrite = await liveBytes();
	await manager.rewriteEntries();
	await manager.flush();
	const retainedBytes = Math.max(0, (await liveBytes()) - liveBeforeRewrite);
	const peakBytes = process.resourceUsage().maxRSS * 1024;
	const rewrittenBytes = (await Bun.file(sessionFile).size) ?? 0;
	process.stdout.write(JSON.stringify({ sourceBytes, rewrittenBytes, peakBytes, retainedBytes }));
} finally {
	await manager?.close();
	await fs.rm(root, { recursive: true, force: true });
}
