import { expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { harnessHash } from "../../bench/memory-eval/run";

// An LF and a CRLF (native Windows) checkout of one revision must fingerprint alike, or `diff` refuses to compare them.
it("fingerprints harness sources the same across line endings, but not across edits", async () => {
	await using lf = await TempDir.create("@memory-eval-hash-lf-");
	await using crlf = await TempDir.create("@memory-eval-hash-crlf-");
	const sources = { "run.ts": "export const a = 1;\nexport const b = 2;\n", "py/x.py": "A = 1\nB = 2\n" };
	for (const [name, text] of Object.entries(sources)) {
		await Bun.write(lf.join(name), text);
		await Bun.write(crlf.join(name), text.replaceAll("\n", "\r\n"));
	}
	expect(await harnessHash(crlf.path())).toBe(await harnessHash(lf.path()));
	await Bun.write(crlf.join("py/x.py"), "A = 1\r\nB = 3\r\n");
	expect(await harnessHash(crlf.path())).not.toBe(await harnessHash(lf.path()));
});
