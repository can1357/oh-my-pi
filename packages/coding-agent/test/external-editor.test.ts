import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getEditorCommand, getEditorName, openInEditor, resolveEditorSpawnCommand } from "../src/utils/external-editor";

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

	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalVisual === undefined) delete Bun.env.VISUAL;
		else Bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete Bun.env.EDITOR;
		else Bun.env.EDITOR = originalEditor;
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

describe("getEditorName", () => {
	it("names Windows' default editor Notepad", () => {
		expect(getEditorName("notepad")).toBe("Notepad");
		expect(getEditorName("C:\\Windows\\System32\\notepad.exe")).toBe("Notepad");
	});

	it("names the program, without its directory, quotes, arguments or extension", () => {
		expect(getEditorName("nvim")).toBe("nvim");
		expect(getEditorName("code --wait")).toBe("code");
		expect(getEditorName('"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" --wait')).toBe("code");
		expect(getEditorName("'/opt/My Editors/subl' -w")).toBe("subl");
	});

	it("is undefined without an editor", () => {
		expect(getEditorName("")).toBeUndefined();
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

	it.skipIf(process.platform === "win32")(
		"returns the caller's own bytes when the editor saves them unchanged",
		async () => {
			// An ask answer reaches the model byte for byte: an editor that writes the file back
			// unchanged must not cost the person the newline their text ended with.
			const tempDir = TempDir.createSync("@external-editor-");
			try {
				const editorPath = path.join(tempDir.path(), "noop");
				await Bun.write(editorPath, "#!/bin/sh\nexit 0\n");
				fs.chmodSync(editorPath, 0o755);

				expect(await openInEditor(editorPath, "tail\n")).toBe("tail\n");
				expect(await openInEditor(editorPath, "tail\n\n")).toBe("tail\n\n");
				expect(await openInEditor(editorPath, "tail")).toBe("tail");
			} finally {
				await tempDir.remove();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"drops the final newline an editor adds to newline-free content",
		async () => {
			// vi and friends terminate the last line on save; a one-line answer must stay one line.
			const tempDir = TempDir.createSync("@external-editor-");
			try {
				const editorPath = path.join(tempDir.path(), "terminate");
				await Bun.write(editorPath, '#!/bin/sh\nprintf "answer\\n" > "$1"\n');
				fs.chmodSync(editorPath, 0o755);

				expect(await openInEditor(editorPath, "answer")).toBe("answer");
				expect(await openInEditor(editorPath, "answer", { trimTrailingNewline: false })).toBe("answer\n");
			} finally {
				await tempDir.remove();
			}
		},
	);
});
