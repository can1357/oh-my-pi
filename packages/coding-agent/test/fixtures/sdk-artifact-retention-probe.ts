import { heapStats } from "bun:jsc";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const manager = SessionManager.inMemory();

async function collectHeapSize(): Promise<number> {
	for (let pass = 0; pass < 3; pass++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
	return heapStats().heapSize;
}

async function saveBulkArtifact(): Promise<void> {
	await manager.saveArtifact(Buffer.alloc(8 * 1024 * 1024, 0x61).toString("base64"), "read");
}

const baselineBytes = await collectHeapSize();
await saveBulkArtifact();
const liveBytes = await collectHeapSize();
await manager.close();
manager.releaseRetainedEntries();
const releasedBytes = await collectHeapSize();

process.stdout.write(
	JSON.stringify({ baselineBytes, liveBytes, releasedBytes, retainedEntries: manager.getEntries().length }),
);
