/**
 * The file `openPrivateTempFileSync` opens, as the rewrite spool holds it:
 * only its first close closes its descriptor, since after it the process can
 * give the number to another file.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { openPrivateTempFileSync } from "@oh-my-pi/pi-coding-agent/utils/owner-private-dir";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

/** A private temporary file of this account opened under `tmp`, standing for `os.tmpdir()`. */
function openUnder(tmp: TempDir) {
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("This platform gives no account id");
	return openPrivateTempFileSync("omp-probe", uid, "Probe directory");
}

describe.skipIf(process.getuid === undefined)("a private temporary file", () => {
	// If this regresses, a spool released twice closes the descriptor of whatever file the process
	// opened in between.
	it("closes its descriptor only on the first close, leaving the file that took the number open", async () => {
		using tmp = TempDir.createSync("@omp-private-temp-file-");
		await Bun.write(tmp.join("other"), "other bytes");
		const file = openUnder(tmp);
		const number = file.fd;
		// Nothing runs between the close and the open, so the open takes the number the close freed.
		file.close();
		const other = fs.openSync(tmp.join("other"), "r");
		try {
			file.close();
			expect({ reusedNumber: other === number, other: await Bun.file(other).text() }).toEqual({
				reusedNumber: true,
				other: "other bytes",
			});
		} finally {
			fs.closeSync(other);
		}
	});
});
