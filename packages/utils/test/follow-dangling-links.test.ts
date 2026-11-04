import { afterEach, describe, expect, it, onTestFinished, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";

const follow = { throughMissing: true, followDanglingLinks: true } as const;

function errno(code: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`${code}: readlink`);
	error.code = code;
	return error;
}

describe("resolveEquivalentPath followDanglingLinks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Another process can replace or remove a link while the walk reads it. The
	// walk then resolves the component as what it now is, and never throws: a
	// throw here fails the edit whose lint-on-write asked for the path.
	for (const code of ["ENOENT", "EINVAL"]) {
		it.skipIf(process.platform === "win32")(
			`takes a link that reads back ${code} (removed or replaced mid-walk) as a plain component`,
			() => {
				const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-follow-links-")));
				onTestFinished(() => fs.rmSync(temp, { recursive: true, force: true }));
				fs.mkdirSync(path.join(temp, "target"));
				const link = path.join(temp, "link");
				fs.symlinkSync("target", link);
				const readlink = fs.readlinkSync;
				vi.spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, ...rest: never[]) => {
					if (String(file) === link) throw errno(code);
					return readlink(file, ...rest);
				}) as typeof fs.readlinkSync);

				expect(resolveEquivalentPath(path.join(link, "sub", "file.ts"), follow)).toBe(
					path.join(link, "sub", "file.ts"),
				);
			},
		);
	}
});
