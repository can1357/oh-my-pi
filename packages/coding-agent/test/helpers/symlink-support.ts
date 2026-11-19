import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Creating a symlink needs Developer Mode or elevation on Windows and is simply absent on
 * some images, so symlink tests are gated on whether this host can make one at all.
 *
 * Probed at module scope, not in `beforeEach`: `skipIf` reads its condition when the test
 * is registered, which happens before any hook runs, so a probe assigned in `beforeEach`
 * would leave the flag undefined and skip the test on every host.
 */
function probeSymlinks(): boolean {
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "omp-symlink-probe-"));
	try {
		const target = path.join(dir, "target");
		nodeFs.writeFileSync(target, "probe");
		nodeFs.symlinkSync(target, path.join(dir, "file-link"), "file");
		nodeFs.symlinkSync(dir, path.join(dir, "dir-link"), "dir");
		return true;
	} catch {
		return false;
	} finally {
		nodeFs.rmSync(dir, { recursive: true, force: true });
	}
}

export const SYMLINKS_USABLE = probeSymlinks();
