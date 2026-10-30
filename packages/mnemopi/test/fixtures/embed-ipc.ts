import { spyOn } from "bun:test";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import type * as Fastembed from "fastembed";
import { runCli } from "../../src/cli";
import { embed, setLocalModelInitializer } from "../../src/core/embeddings";
import * as fastembedRuntime from "../../src/core/fastembed-runtime";
import { withMnemopiRuntimeOptions } from "../../src/core/runtime-options";

const [mode, dir, ...args] = Bun.argv.slice(2);
if (!dir) throw new Error("fixture directory required");
spyOn(utils, "getMnemopiEmbedRuntimeDir").mockReturnValue(path.join(dir, "run"));
spyOn(utils, "getFastembedCacheDir").mockReturnValue(path.join(dir, "cache"));
let loads = 0;
let active = 0;
const fakeRuntime = {
	FlagEmbedding: {
		async init() {
			loads++;
			return {
				async *embed(texts: string[]) {
					if (active++) throw new Error("overlapping inference");
					try {
						if (texts.includes("hold")) {
							process.stdout.write("inference-started\n");
							await Promise.withResolvers<void>().promise;
						}
						if (texts.includes("fail")) throw new Error("fake inference failed");
						await Bun.sleep(10);
						yield texts.map(text => [text.length, mode === "serve" ? 7 : 3]);
					} finally {
						active--;
					}
				},
			};
		},
	},
} as unknown as typeof Fastembed;
spyOn(fastembedRuntime, "loadFastembed").mockResolvedValue(fakeRuntime);
// Keep the session-budget wrapper away from the real optional ONNX package.
spyOn(fastembedRuntime, "withEmbedSessionBudget").mockImplementation((_cache, work) => work());

if (mode === "serve") {
	try {
		process.exit(await runCli(["embed-serve", ...args]));
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		process.exit(1);
	}
} else {
	if (mode === "host") {
		setLocalModelInitializer(async () => ({
			async *embed(texts) {
				yield texts.map(text => [text.length, 9]);
			},
		}));
	}
	for await (const line of readLines(Bun.stdin.stream())) {
		const text = new TextDecoder().decode(line);
		const vectors = await withMnemopiRuntimeOptions(
			{ embeddings: { model: "BAAI/bge-small-en-v1.5", disabled: false, apiUrl: "" } },
			() => embed([text]),
		);
		process.stdout.write(`${JSON.stringify({ vectors: vectors?.map(row => Array.from(row)) ?? null, loads })}\n`);
	}
}
