import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getEditorCommand, openInEditor, resolveEditorSpawnCommand } from "../src/utils/external-editor";

interface MutableProcess {
	platform: NodeJS.Platform;
}

function setPlatform(value: NodeJS.Platform): void {
	(process as unknown as MutableProcess).platform = value;
}

describe("getEditorCommand", () => {
	const originalPlatform = process.platform;
	const originalVisual = Bun.env.VISUAL;
	const originalEditor = Bun.env.EDITOR;
	const originalOmpEditor = Bun.env.OMP_EDITOR;
	const originalPiEditor = Bun.env.PI_EDITOR;

	beforeEach(() => {
		delete Bun.env.OMP_EDITOR;
		delete Bun.env.PI_EDITOR;
	});
	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalVisual === undefined) delete Bun.env.VISUAL;
		else Bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete Bun.env.EDITOR;
		else Bun.env.EDITOR = originalEditor;
		if (originalOmpEditor === undefined) delete Bun.env.OMP_EDITOR;
		else Bun.env.OMP_EDITOR = originalOmpEditor;
		if (originalPiEditor === undefined) delete Bun.env.PI_EDITOR;
		else Bun.env.PI_EDITOR = originalPiEditor;
	});

	it("prefers $VISUAL over $EDITOR and the platform default", () => {
		Bun.env.VISUAL = "nvim";
		Bun.env.EDITOR = "nano";
		setPlatform("win32");
		expect(getEditorCommand()).toBe("nvim");
	});

	it("falls back to $EDITOR when $VISUAL is unset", () => {
		delete Bun.env.VISUAL;
		Bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("nano");
	});

	it("prefers $OMP_EDITOR over $VISUAL and $EDITOR", () => {
		Bun.env.OMP_EDITOR = "hx";
		Bun.env.VISUAL = "nvim";
		Bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("hx");
	});

	it("prefers $PI_EDITOR over $VISUAL and $EDITOR", () => {
		Bun.env.PI_EDITOR = "micro";
		Bun.env.VISUAL = "nvim";
		Bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("micro");
	});

	it("prefers $OMP_EDITOR over $PI_EDITOR", () => {
		Bun.env.OMP_EDITOR = "code --wait";
		Bun.env.PI_EDITOR = "micro";
		expect(getEditorCommand()).toBe("code --wait");
	});

	it("falls back from a whitespace-only $OMP_EDITOR to $VISUAL", () => {
		Bun.env.OMP_EDITOR = "   ";
		Bun.env.VISUAL = "nvim";
		Bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("nvim");
	});

	it("trims whitespace so an accidentally padded value still works", () => {
		Bun.env.VISUAL = "  code --wait  ";
		delete Bun.env.EDITOR;
		expect(getEditorCommand()).toBe("code --wait");
	});

	it("treats a whitespace-only $VISUAL as unset and consults $EDITOR", () => {
		Bun.env.VISUAL = "   ";
		Bun.env.EDITOR = "vim";
		expect(getEditorCommand()).toBe("vim");
	});

	it("defaults to notepad on Windows when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("win32");
		expect(getEditorCommand()).toBe("notepad");
	});

	it("returns undefined on POSIX when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("linux");
		expect(getEditorCommand()).toBeUndefined();
	});
});

describe("openInEditor", () => {
	it("always inherits the pane stdio", async () => {
		const spawn = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(1),
		} as never);
		try {
			await openInEditor("editor", "original", {
				extension: ".md",
				stdio: [0, 1, 2],
			} as never);

			expect(spawn).toHaveBeenCalledTimes(1);
			expect(spawn.mock.calls[0]?.[1]).toMatchObject({
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
		} finally {
			spawn.mockRestore();
		}
	});

	it("passes the cmd.exe command line verbatim on Windows", () => {
		const tmpFile = String.raw`C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md`;

		expect(resolveEditorSpawnCommand('"C:\\Program Files\\Code.exe" --wait', tmpFile, "win32")).toEqual({
			cmd: [
				"cmd.exe",
				"/d",
				"/s",
				"/c",
				String.raw`""C:\Program Files\Code.exe" --wait "C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md""`,
			],
			windowsVerbatimArguments: true,
		});
	});

	it.skipIf(process.platform === "win32")("supports quoted editor paths containing spaces", async () => {
		const tempDir = TempDir.createSync("@external-editor-");
		try {
			const editorPath = path.join(tempDir.path(), "My Editor", "edit");
			fs.mkdirSync(path.dirname(editorPath), { recursive: true });
			await Bun.write(editorPath, '#!/bin/sh\nprintf "edited" > "$1"\n');
			fs.chmodSync(editorPath, 0o755);

			const result = await openInEditor(`"${editorPath}"`, "original");

			expect(result).toBe("edited");
		} finally {
			await tempDir.remove();
		}
	});
});
