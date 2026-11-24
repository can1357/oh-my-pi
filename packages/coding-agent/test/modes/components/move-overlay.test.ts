import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../../src/config/settings";
import { MoveOverlay } from "../../../src/ui/overlays/panels/move-overlay";
import { extensionOverlay } from "../../../src/modes/controllers/extension-ui-blocks";
import { singleNode } from "../../../src/ui/extensions/render-output";
import { nativeShell } from "../../helpers/native-shell";
import { mountOverlay } from "../../helpers/overlay-terminal";
import { type MoveOverlayResult } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/move-overlay";
import {
	moveDirectorySource,
	resolveExistingDirectory,
	resolveMovePath,
} from "../../../src/modes/move-directory-source";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** The move overlay over `cwd` on a terminal, its root focused (it owns the keys), `onDone` recording. */
function mount(cwd: string, onDone: (result: MoveOverlayResult | undefined) => void = () => {}): TestTerminal {
	return mountOverlay(() => MoveOverlay({ cwd, source: moveDirectorySource, onDone }), {
		columns: 80,
		focusKind: "col",
	});
}

const screen = (term: TestTerminal): string => {
	term.render();
	return term.screen().join("\n");
};

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
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
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

	it("routes native selection, buttons and activation inside the mounted /move extension layer", async () => {
		await using ui = await nativeShell();
		const results: (MoveOverlayResult | undefined)[] = [];
		const show = () =>
			ui.shell.overlays.show(
				() =>
					extensionOverlay(
						singleNode(MoveOverlay({ cwd, source: moveDirectorySource, onDone: result => results.push(result) })),
						false,
						true,
					),
				{ focus: root => root.children()[0]! },
			);
		const first = show();
		const list = ui.node("list", "results");
		const beta = list.c[1]!;
		ui.send({ ev: "select", sf: ui.sf, id: list.id, item: beta });
		expect(ui.node("list", "results").p.selected).toBe(beta);
		expect(results).toEqual([]);
		ui.click("button", "accept");
		expect(ui.node("input").p.text).toBe(path.join(cwd, "beta"));
		ui.click("button", "confirm");
		expect(results).toEqual([{ directory: path.join(cwd, "beta") }]);
		first.close();

		show();
		ui.send({ ev: "edit", sf: ui.sf, id: ui.node("input").id, from: 0, to: 0, text: "alp", cursor: 3, len: 0 });
		expect(ui.node("input").p.text).toBe("alp");
		const filtered = ui.node("list", "results");
		ui.send({ ev: "activate", sf: ui.sf, id: filtered.id, item: filtered.c[0]! });
		expect(results[1]).toEqual({ directory: path.join(cwd, "alpha") });
	});

	it("lists child directories (excluding hidden and files) on empty input", () => {
		const term = mount(cwd);
		const text = screen(term);
		term.dispose();
		expect(text).toContain("alpha/");
		expect(text).toContain("beta/");
		expect(text).not.toContain(".hidden/");
		expect(text).not.toContain("file.txt");
	});

	it("filters results as the user types", () => {
		const term = mount(cwd);
		term.type("al");
		const text = screen(term);
		term.dispose();
		expect(text).toContain("alpha/");
		expect(text).not.toContain("beta/");
	});

	it("shows dot directories after a dot prefix is typed", () => {
		const term = mount(cwd);
		term.type(".");
		const text = screen(term);
		term.dispose();
		expect(text).toContain(".hidden/");
	});

	it("accepts bracketed paste and multi-byte input while filtering controls", () => {
		let result: MoveOverlayResult | undefined;
		const term = mount(cwd, r => {
			result = r;
		});
		term.paste("new\nø");
		term.press("enter");
		term.dispose();
		expect(result).toBeDefined();
		expect(result!.directory).toBe("newø");
	});

	it("calls done with undefined on Escape", () => {
		let result: MoveOverlayResult | undefined = "sentinel" as unknown as MoveOverlayResult;
		const term = mount(cwd, r => {
			result = r;
		});
		term.press("escape");
		term.dispose();
		expect(result).toBeUndefined();
	});

	it("calls done with the highlighted directory on Enter", () => {
		let result: MoveOverlayResult | undefined;
		const term = mount(cwd, r => {
			result = r;
		});
		// First result should be "alpha/" (sorted alphabetically).
		term.press("enter");
		term.dispose();
		expect(result).toBeDefined();
		expect(result!.directory).toBe(path.join(cwd, "alpha"));
	});

	it("calls done with the typed path on Enter when no results match", () => {
		let result: MoveOverlayResult | undefined;
		const term = mount(cwd, r => {
			result = r;
		});
		// Type a path that won't match any directory in cwd.
		term.type("zz");
		term.press("enter");
		term.dispose();
		expect(result).toBeDefined();
		expect(result!.directory).toBe("zz");
	});

	it("Tab accepts the highlighted suggestion into the input", () => {
		let result: MoveOverlayResult | undefined;
		const term = mount(cwd, r => {
			result = r;
		});
		term.press("tab");
		// After tab, the input should be the full path of the first result.
		// Press Enter to confirm — the result should be the alpha directory.
		term.press("enter");
		term.dispose();
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
				const term = mount(bulk);
				statSpy.mockClear();
				term.type("sub");
				term.dispose();
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
				const term = mount(unknownFs);
				const text = screen(term);
				term.dispose();
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
