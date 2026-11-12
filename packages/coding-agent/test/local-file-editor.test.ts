import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InternalUrlRouter, type LocalFileEntry, LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { buildLocalFileArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import {
	openLocalFileInEditor,
	resolveLocalEditorTarget,
	revalidateLocalEditorEntry,
} from "@oh-my-pi/pi-coding-agent/modes/local-file-editor";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { vi } from "bun:test";

describe("resolveLocalEditorTarget", () => {
	beforeEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	it("accepts bare, local:// and local:/ names for the same file", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		const planPath = path.join(tmp.path(), "local", "plan.md");
		await Bun.write(planPath, "# plan");
		const expected = await fs.realpath(planPath);

		for (const target of ["plan.md", "local://plan.md", "  local:/plan.md  "]) {
			expect((await resolveLocalEditorTarget(target, options)).path).toBe(expected);
		}
	});

	it("rejects missing files, directories, and paths escaping the local root", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		await Bun.write(path.join(tmp.path(), "local", "sub", "inner.md"), "x");
		await Bun.write(path.join(tmp.path(), "escape.md"), "outside");

		await expect(resolveLocalEditorTarget("nope.md", options)).rejects.toThrow(
			"Local file not found: local://nope.md",
		);
		await expect(resolveLocalEditorTarget("sub", options)).rejects.toThrow(
			"local://sub is a directory; name a file inside it.",
		);
		await expect(resolveLocalEditorTarget("../escape.md", options)).rejects.toThrow();
	});

	it("opens bare names containing %, #, and ? without double-decoding an encoded local:// URL", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		// Windows filenames cannot contain `?`.
		const names = ["100%.md", "a#b.md", "sub/a#b.md", ...(process.platform === "win32" ? [] : ["a?b.md"])];
		for (const name of names) {
			await Bun.write(path.join(tmp.path(), "local", name), name);
		}

		for (const name of names) {
			const resolved = await resolveLocalEditorTarget(name, options);
			expect(resolved.path).toBe(await fs.realpath(path.join(tmp.path(), "local", name)));
			expect(resolved.url).toBe(`local://${name}`);
		}
		expect((await resolveLocalEditorTarget("local://100%25.md", options)).path).toBe(
			await fs.realpath(path.join(tmp.path(), "local", "100%.md")),
		);
	});

	// Windows reserves `:` in filenames (it names an NTFS stream instead).
	it.skipIf(process.platform === "win32")(
		"treats a literal `local:`-prefixed filename as a name, not a URL",
		async () => {
			using tmp = TempDir.createSync("@omp-local-editor-");
			const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
			await Bun.write(path.join(tmp.path(), "local", "local:notes.md"), "colon");

			const resolved = await resolveLocalEditorTarget("local:notes.md", options);
			expect(resolved.path).toBe(await fs.realpath(path.join(tmp.path(), "local", "local:notes.md")));
		},
	);

	it("strips control bytes from errors shown for missing control-byte names", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const editorBackup = process.env.EDITOR;
		process.env.EDITOR = "true";
		const showError = vi.fn();
		const ctx = {
			sessionManager: { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" },
			showError,
		} as unknown as InteractiveModeContext;
		try {
			await openLocalFileInEditor(ctx, "no\x1bpe.md");
		} finally {
			if (editorBackup === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = editorBackup;
		}

		expect(showError).toHaveBeenCalledTimes(1);
		const shown = showError.mock.calls[0]![0] as string;
		expect(shown).not.toContain("\x1b");
		expect(shown).toContain("noe.md");
	});

	it("rejects a name whose file is a symlink to outside the local root", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		const outside = path.join(tmp.path(), "outside.md");
		await Bun.write(outside, "secret");
		await fs.mkdir(path.join(tmp.path(), "local"));
		await fs.symlink(outside, path.join(tmp.path(), "local", "normal.md"));

		await expect(resolveLocalEditorTarget("normal.md", options)).rejects.toThrow(/escapes/);
	});

	it("revalidates an already-picked entry without trimming filenames that start or end with spaces", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		const spaceName = " plan.md";
		const normalName = "plan.md";
		await Bun.write(path.join(tmp.path(), "local", spaceName), "spaced");
		await Bun.write(path.join(tmp.path(), "local", normalName), "normal");

		const spaceEntry: LocalFileEntry = {
			name: spaceName,
			url: `local://${spaceName}`,
			path: path.join(tmp.path(), "local", spaceName),
			size: 6,
			mtimeMs: Date.now(),
		};
		const revalidated = await revalidateLocalEditorEntry(spaceEntry, options);
		expect(revalidated.path).toBe(await fs.realpath(path.join(tmp.path(), "local", spaceName)));
		expect(revalidated.url).toBe(`local://${spaceName}`);
	});

	it("revalidates an already-picked entry and rejects symlink escape at use time", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		const outside = path.join(tmp.path(), "outside.md");
		await Bun.write(outside, "secret");
		await fs.mkdir(path.join(tmp.path(), "local"));
		await Bun.write(path.join(tmp.path(), "local", "normal.md"), "original");

		const entry: LocalFileEntry = {
			name: "normal.md",
			url: "local://normal.md",
			path: path.join(tmp.path(), "local", "normal.md"),
			size: 8,
			mtimeMs: Date.now(),
		};

		await fs.unlink(path.join(tmp.path(), "local", "normal.md"));
		await fs.symlink(outside, path.join(tmp.path(), "local", "normal.md"));

		await expect(revalidateLocalEditorEntry(entry, options)).rejects.toThrow(/escapes/);
	});

	it("rejects openLocalFileInEditor when collabGuest is active", async () => {
		const showStatus = vi.fn();
		const ctx = {
			collabGuest: {} as unknown as InteractiveModeContext["collabGuest"],
			showStatus,
		} as unknown as InteractiveModeContext;

		await openLocalFileInEditor(ctx);
		expect(showStatus).toHaveBeenCalledWith("/local is host-only during a collab session");
	});
});

describe("buildLocalFileArgumentCompletions", () => {
	beforeEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	const completerFor = (options: { getArtifactsDir: () => string; getSessionId: () => string }) =>
		buildLocalFileArgumentCompletions({
			ctx: { sessionManager: options },
		} as never);

	it("inserts an encoded local:// URL so whitespace and metachar names survive trimming", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		await Bun.write(path.join(tmp.path(), "local", " plan.md"), "spaced");
		await Bun.write(path.join(tmp.path(), "local", "a#b.md"), "hash");

		const items = await completerFor(options)("");
		const byValue = new Map(items!.map(i => [i.value, i.label]));
		expect(byValue.get("local://%20plan.md")).toBe(" plan.md");
		expect(byValue.get("local://a%23b.md")).toBe("a#b.md");

		// The inserted value resolves back to the exact file — a leading-space
		// name does not collapse onto the "plan.md" sibling.
		const resolved = await resolveLocalEditorTarget("local://%20plan.md", options);
		expect(resolved.path).toBe(await fs.realpath(path.join(tmp.path(), "local", " plan.md")));
	});

	// Windows filenames cannot contain control bytes.
	it.skipIf(process.platform === "win32")(
		"strips ANSI/control bytes from completion labels but keeps the exact value",
		async () => {
			using tmp = TempDir.createSync("@omp-local-editor-");
			const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
			const evilName = "evil\x1b[31m.md";
			await Bun.write(path.join(tmp.path(), "local", evilName), "x");

			const items = await completerFor(options)("");
			const item = items!.find(i => i.value === `local://${encodeURIComponent(evilName)}`);
			expect(item).toBeDefined();
			expect(item!.label).not.toContain("\x1b");
		},
	);
});
