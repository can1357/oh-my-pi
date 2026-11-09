import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSherpaRuntime, SHERPA_PACKAGE } from "@oh-my-pi/pi-coding-agent/stt/sherpa-runtime";
import * as utils from "@oh-my-pi/pi-utils";

async function writeRuntime(runtimeDir: string, source: string): Promise<void> {
	const dir = path.join(runtimeDir, "node_modules", SHERPA_PACKAGE);
	await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name: SHERPA_PACKAGE, main: "index.js" }));
	await Bun.write(path.join(dir, "index.js"), source);
}

describe("sherpa on-demand runtime", () => {
	let tmp = "";

	afterEach(async () => {
		mock.restore();
		await utils.removeWithRetries(tmp);
	});

	it("propagates runtime initialization errors without retrying installation", async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sherpa-runtime-"));
		await writeRuntime(tmp, "throw new Error('unexpected sherpa initialization failure');\n");
		const install = spyOn(utils, "ensureRuntimeInstalled").mockResolvedValue(tmp);

		await expect(loadSherpaRuntime()).rejects.toThrow("unexpected sherpa initialization failure");

		expect(install).toHaveBeenCalledTimes(1);
	});
});
