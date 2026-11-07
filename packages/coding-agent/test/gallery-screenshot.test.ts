import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureGalleryScreenshots } from "@oh-my-pi/pi-coding-agent/cli/gallery-screenshot";
import { quotePosixArgument } from "@oh-my-pi/pi-coding-agent/utils/shell-quote";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as piUtils from "@oh-my-pi/pi-utils";

/**
 * A stand-in for VHS 0.12.1 that keeps the behaviour a tape's safety rests on:
 * a string token runs from its opening quote to the next same quote with no
 * escape processing (`lexer.readString`), and `Type` text is typed into a bash
 * whose working directory is VHS's own. `Screenshot` saves what that shell
 * printed, standing in for the captured frame.
 */
function vhsStandIn(markerPath: string): string {
	return `#!/bin/bash
export OMP_GALLERY_MARKER=${quotePosixArgument(markerPath)}
typed=""
while IFS= read -r line; do
	case $line in
		'Type "'*) rest=\${line#Type \\"}; typed+=\${rest%%\\"*} ;;
		Enter) typed+=$'\\n' ;;
		'Screenshot "'*)
			rest=\${line#Screenshot \\"}
			printf 'clear() { :; }\\nsleep() { :; }\\n%s' "$typed" | bash --noprofile --norc > "\${rest%%\\"*}" 2>&1
			;;
	esac
done < "$1"
`;
}

const SECTIONS = [{ heading: "probe", lines: ["\x1b[1mgallery line one\x1b[0m", "gallery line two"] }];

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("captureGalleryScreenshots", () => {
	async function withStandIn(run: (root: string, marker: string) => Promise<void>): Promise<void> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gallery-shot-"));
		const marker = path.join(root, "marker");
		const standIn = path.join(root, "vhs");
		try {
			await Bun.write(standIn, vhsStandIn(marker));
			await fs.chmod(standIn, 0o755);
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "vhs" ? standIn : null));
			await run(root, marker);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}

	it("captures to an output path holding shell syntax without running it", async () => {
		await withStandIn(async (root, marker) => {
			// The apostrophes end a single-quoted copy of the path, so the `$(…)` between them runs.
			const outDir = path.join(root, "x'$(printf PWNED >$OMP_GALLERY_MARKER)'y");
			const out = path.join(outDir, "shot.png");

			const paths = await captureGalleryScreenshots(SECTIONS, { width: 40, out });

			expect(await Bun.file(marker).exists()).toBe(false);
			expect(paths).toEqual([out]);
			expect(Bun.stripANSI(await Bun.file(out).text())).toBe("gallery line one\r\ngallery line two\r\n");
			expect(await fs.readdir(outDir)).toEqual(["shot.png"]);
		});
	});

	it("rejects a font family VHS cannot carry before running VHS", async () => {
		await withStandIn(async root => {
			const out = path.join(root, "shot.png");
			// VHS evaluates the family as `term.options.fontFamily = '<family>'` in the page that types into the shell.
			const font = "Mono' + term.paste('printf PWNED' + String.fromCharCode(13)) + '";

			await expect(captureGalleryScreenshots(SECTIONS, { width: 40, out, font })).rejects.toThrow(
				/cannot contain quotes, backslashes or control characters/,
			);
			expect(await fs.readdir(root)).toEqual(["vhs"]);
		});
	});
});
