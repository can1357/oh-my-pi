import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeEmbedTarget } from "../../natives/scripts/embed-native";
import { buildAgyTransport } from "./build-agy-transport";

/** Deterministic native resource overlays; no source-tree generated manifest. */
export async function embeddedAgyTransportFiles(
	target: NativeEmbedTarget,
): Promise<Record<string, string | Uint8Array>> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-build-"));
	try {
		const filename = `agy-transport${target.platform === "win32" || target.platform === "windows" ? ".exe" : ""}`;
		const executable = await buildAgyTransport({ ...target, out: path.join(directory, filename) });
		const bytes = await fs.readFile(executable);
		const sha256 = Bun.SHA256.hash(bytes, "hex");
		const frame = await Bun.zstdCompress(bytes, { level: 19 });
		const providerDir = await fs.realpath(path.resolve(import.meta.dir, "../src/providers"));
		const resourceName = `agy-transport-${target.platform}-${target.arch}.zst`;
		return {
			[path.join(providerDir, resourceName)]: frame,
			[path.join(providerDir, "agy-embedded.ts")]:
				`import zstdPath from ${JSON.stringify(`./${resourceName}`)} with { type: "file" };\nexport const embeddedAgyTransport = ${JSON.stringify({ sha256, filename, size: bytes.length }).slice(0, -1)}, zstdPath };\n`,
		};
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}
