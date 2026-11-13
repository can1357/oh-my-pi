import { spyOn } from "bun:test";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { MnemopiEmbedClient } from "../../src/mnemopi/embed-client";
import * as sharedWorker from "../../src/subprocess/shared-worker";

const dir = Bun.argv[2];
if (!dir) throw new Error("fixture directory required");
spyOn(utils, "getMnemopiEmbedRuntimeDir").mockReturnValue(path.join(dir, "run"));
let spawns = 0;
spyOn(sharedWorker, "spawnDetached").mockImplementation(() => {
	spawns++;
	throw new Error("omp tried to replace the standalone server");
});
const client = new MnemopiEmbedClient();
try {
	const error = await client.load("fast-bge-small-en-v1.5", path.join(dir, "cache"));
	if (error) throw new Error(error);
	const vectors = await client.embed("fast-bge-small-en-v1.5", path.join(dir, "cache"), ["hello", "sky"], undefined);
	process.stdout.write(`${JSON.stringify({ vectors, spawns })}\n`);
} finally {
	await client.terminate();
}
