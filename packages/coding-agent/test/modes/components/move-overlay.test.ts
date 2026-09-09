import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import {
	MoveOverlay,
	type MoveOverlayResult,
	resolveExistingDirectory,
	resolveMovePath,
} from "../../../src/modes/components/move-overlay";
import { getThemeByName, setThemeInstance, type Theme } from "../../../src/modes/theme/theme";

// Strip SGR colors so assertions see visible text only.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const strip = (lines: readonly string[]): string => lines.map(stripAnsi).join("\n");

describe("resolveMovePath", () => {
	it("expands ~ to homedir", () => {
		expect(resolveMovePath("~", "/anywhere")).toBe(os.homedir());
	});
	it("expands ~/sub to homedir/sub", () => {
		expect(resolveMovePath("~/foo", "/anywhere")).toBe(path.join(os.homedir(), "foo"));
	});
	it("resolves relative paths against cwd", () => {
		expect(resolveMovePath("foo/bar", "/parent")).toBe(path.resolve("/parent", "foo/bar"));
	});
	it("passes absolute paths through (normalized)", () => {
		expect(resolveMovePath("/abs/path", "/anywhere")).toBe(path.normalize("/abs/path"));
	});
});

describe("resolveExistingDirectory", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-resolve-"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	it("returns the resolved path for an existing directory", () => {
		const sub = path.join(tmp, "sub");
		fs.mkdirSync(sub);
		expect(resolveExistingDirectory(sub, "/anywhere")).toBe(path.resolve(sub));
	});
	it("returns null for a non-existent path", () => {
		expect(resolveExistingDirectory(path.join(tmp, "nope"), "/anywhere")).toBeNull();
	});
	it("returns null for a file (not a directory)", () => {
		const file = path.join(tmp, "file.txt");
		fs.writeFileSync(file, "x");
		expect(resolveExistingDirectory(file, "/anywhere")).toBeNull();
	});
});

describe("MoveOverlay", () => {
	let tmp: string;
	let cwd: string;
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-overlay-"));
		cwd = tmp;
		fs.mkdirSync(path.join(tmp, "alpha"));
		fs.mkdirSync(path.join(tmp, "beta"));
		fs.mkdirSync(path.join(tmp, ".hidden"));
		fs.writeFileSync(path.join(tmp, "file.txt"), "x");
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	it("renders a box with a title and input prompt", () => {
		const overlay = new MoveOverlay(cwd, () => {});
		const text = strip(overlay.render(80));
		expect(text).toContain("Move to directory");
		expect(text).toContain("Path:");
	});

	it("renders every frame row at the assigned overlay width", () => {
		const overlay = new MoveOverlay(cwd, () => {});
		const lines = overlay.render(72);
		const plainLines = lines.map(stripAnsi);

		expect(lines.map(line => visibleWidth(line))).toEqual(Array(lines.length).fill(72));
		expect(plainLines[0]!.endsWith(uiTheme.boxRound.topRight)).toBe(true);
		expect(plainLines.at(-1)!.endsWith(uiTheme.boxRound.bottomRight)).toBe(true);
		for (const line of plainLines.slice(1, -1)) {
			expect(line.endsWith(uiTheme.boxRound.vertical)).toBe(true);
		}
	});

	it("lists child directories (excluding hidden and files) on empty input", () => {
		const overlay = new MoveOverlay(cwd, () => {});
		const text = strip(overlay.render(80));
		expect(text).toContain("alpha/");
		expect(text).toContain("beta/");
		expect(text).not.toContain(".hidden/");
		expect(text).not.toContain("file.txt");
	});

	it("filters results as the user types", () => {
		const overlay = new MoveOverlay(cwd, () => {});
		overlay.handleInput("a");
		overlay.handleInput("l");
		const text = strip(overlay.render(80));
		expect(text).toContain("alpha/");
		expect(text).not.toContain("beta/");
	});

	it("shows dot directories after a dot prefix is typed", () => {
		const overlay = new MoveOverlay(cwd, () => {});
		overlay.handleInput(".");
		const text = strip(overlay.render(80));
		expect(text).toContain(".hidden/");
	});

	it("accepts bracketed paste and multi-byte input while filtering controls", () => {
		let result: MoveOverlayResult | undefined;
		const overlay = new MoveOverlay(cwd, r => {
			result = r;
		});
		overlay.handleInput("\x1b[200~new\nø\x1b[201~");
		overlay.handleInput("\r");
		expect(result).toBeDefined();
		expect(result!.directory).toBe("newø");
	});

	it("calls done with undefined on Escape", () => {
		let result: MoveOverlayResult | undefined = "sentinel" as unknown as MoveOverlayResult;
		const overlay = new MoveOverlay(cwd, r => {
			result = r;
		});
		overlay.handleInput("\x1b");
		expect(result).toBeUndefined();
	});

	it("calls done with the highlighted directory on Enter", () => {
		let result: MoveOverlayResult | undefined;
		const overlay = new MoveOverlay(cwd, r => {
			result = r;
		});
		// First result should be "alpha/" (sorted alphabetically).
		overlay.handleInput("\r");
		expect(result).toBeDefined();
		expect(result!.directory).toBe(path.join(cwd, "alpha"));
	});

	it("calls done with the typed path on Enter when no results match", () => {
		let result: MoveOverlayResult | undefined;
		const overlay = new MoveOverlay(cwd, r => {
			result = r;
		});
		// Type a path that won't match any directory in cwd.
		overlay.handleInput("z");
		overlay.handleInput("z");
		overlay.handleInput("\r");
		expect(result).toBeDefined();
		expect(result!.directory).toBe("zz");
	});

	it("Tab accepts the highlighted suggestion into the input", () => {
		let result: MoveOverlayResult | undefined;
		const overlay = new MoveOverlay(cwd, r => {
			result = r;
		});
		overlay.handleInput("\t");
		// After tab, the input should be the full path of the first result.
		// Press Enter to confirm — the result should be the alpha directory.
		overlay.handleInput("\r");
		expect(result).toBeDefined();
		expect(result!.directory).toBe(path.join(cwd, "alpha"));
	});

	it("does not stat every directory entry per keystroke", async () => {
		// Regression: `readDirCached` used to cache names and re-`statSync` every
		// entry per keystroke. Populate with mostly files so the old code path
		// would have stat'd all of them; the fix classifies via `Dirent` and only
		// falls back to `statSync` on symlink entries.
		const bulk = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-overlay-bulk-"));
		try {
			for (let i = 0; i < 60; i++) {
				fs.writeFileSync(path.join(bulk, `f_${String(i).padStart(3, "0")}.txt`), "x");
			}
			for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(bulk, `sub_${i}`));

			const statSpy = spyOn(fs, "statSync");
			try {
				const overlay = new MoveOverlay(bulk, () => {});
				statSpy.mockClear();
				overlay.handleInput("s");
				overlay.handleInput("u");
				overlay.handleInput("b");
				// Each keystroke may `statSync` at most once — the
				// `resolveExistingDirectory` probe on the typed prefix. Entries
				// are classified via `Dirent`, not one stat apiece.
				expect(statSpy.mock.calls.length).toBeLessThanOrEqual(3);
			} finally {
				statSpy.mockRestore();
			}
		} finally {
			await fsp.rm(bulk, { recursive: true, force: true });
		}
	});

	it("classifies unknown-type Dirents via statSync fallback", async () => {
		// Regression: filesystems that report UV_DIRENT_UNKNOWN return Dirents
		// whose isDirectory()/isFile()/isSymbolicLink() all report false. Those
		// entries must fall back to statSync so /move still lists real
		// directories on NFS/FUSE/older SMB.
		const unknownFs = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-overlay-unknown-"));
		try {
			const realDir = path.join(unknownFs, "real-dir");
			const realFile = path.join(unknownFs, "real-file.txt");
			fs.mkdirSync(realDir);
			fs.writeFileSync(realFile, "x");

			const fakeDirent = (name: string): fs.Dirent =>
				({
					name,
					isDirectory: () => false,
					isFile: () => false,
					isSymbolicLink: () => false,
					isBlockDevice: () => false,
					isCharacterDevice: () => false,
					isFIFO: () => false,
					isSocket: () => false,
				}) as fs.Dirent;
			const readdirSpy = spyOn(fs, "readdirSync").mockReturnValue([
				fakeDirent("real-dir"),
				fakeDirent("real-file.txt"),
			] as never);
			try {
				const overlay = new MoveOverlay(unknownFs, () => {});
				const text = strip(overlay.render(80));
				expect(text).toContain("real-dir/");
				expect(text).not.toContain("real-file.txt");
			} finally {
				readdirSpy.mockRestore();
			}
		} finally {
			await fsp.rm(unknownFs, { recursive: true, force: true });
		}
	});
});
