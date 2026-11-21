/**
 * Read and search tools under the OS sandbox: read, grep, glob and the ast_edit preview walk and
 * read inside the contained host, so the container refuses a file omp's path check never saw (a
 * symlink inside the workspace, or a call that skipped the check). The contained cases skip where
 * no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContainedFileAccess } from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import type { HostFileMutation } from "@oh-my-pi/pi-coding-agent/sandbox/host-protocol";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxDenyRead } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import {
	beginContainedSandboxTest,
	CONTAINED_SOURCE_RUNS,
	type ContainedSandboxTest,
	containedToolSession,
	endContainedSandboxTest,
	outcome,
	SANDBOX_BACKEND_PRESENT,
} from "../helpers/sandbox-test-state";

let fixture: ContainedSandboxTest;
let workspace: string;
/** Not the workspace, and denied for reads in these tests. */
let outside: string;

function toolSession(): ToolSession {
	return containedToolSession(fixture);
}

/** `<workspace>/bundle.tar` holding `notes/member.txt` with the `ARCHIVE_NEEDLE_9` line. */
async function writeBundle(): Promise<void> {
	const tar = await new Bun.Archive({ "notes/member.txt": "ARCHIVE_NEEDLE_9\n" }).bytes();
	fs.writeFileSync(path.join(workspace, "bundle.tar"), tar);
}

/** `<scratch>/elsewhere`: readable, but not writable for contained processes. */
function makeElsewhere(): string {
	const elsewhere = path.join(path.dirname(workspace), "elsewhere");
	fs.mkdirSync(elsewhere);
	return elsewhere;
}

beforeEach(async () => {
	fixture = await beginContainedSandboxTest("contained-search");
	({ workspace, outside } = fixture);
	cfgSandboxDenyRead.set(fixture.settings, [outside]);
});

afterEach(() => endContainedSandboxTest(fixture));

describe.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)("contained read and search tools", () => {
	it("greps workspace files and never returns the matches of a symlinked denied file", async () => {
		fs.writeFileSync(path.join(workspace, "plain.txt"), "PUBLIC_VALUE_7\n");
		fs.writeFileSync(path.join(outside, "secret.txt"), "TOPSECRET_VALUE_42\n");
		fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "innocent.txt"));
		const tool = new GrepTool(toolSession());
		const pattern = "(TOPSECRET|PUBLIC)_\\w+";

		const walk = await outcome(tool.execute("call-walk", { pattern, path: "." }));
		expect(walk).toContain("PUBLIC_VALUE_7");
		expect(walk).not.toContain("VALUE_42");

		// Named directly, the link is resolved by the search itself: only the container can refuse it.
		const direct = await outcome(tool.execute("call-direct", { pattern, path: "innocent.txt" }));
		expect(direct).not.toContain("VALUE_42");
	});

	it("greps an archive member through a scratch copy the host writes and removes", async () => {
		await writeBundle();
		const tool = new GrepTool(toolSession());

		const found = await outcome(
			tool.execute("call-archive", { pattern: "ARCHIVE_\\w+", path: "bundle.tar:notes/member.txt" }),
		);
		expect(found).toContain("ARCHIVE_NEEDLE_9");
		const tempDir = (await SandboxRuntime.for(workspace)).tempDir();
		expect(fs.readdirSync(tempDir).filter(name => name.startsWith("omp-search-archive-"))).toEqual([]);
	});

	it("never writes an archive member's scratch copy where a contained process redirected the temp dir", async () => {
		fs.writeFileSync(path.join(workspace, "plain.txt"), "PUBLIC_VALUE_7\n");
		await writeBundle();
		const elsewhere = makeElsewhere();
		const tool = new GrepTool(toolSession());
		// Starts the session's pooled host under the real temp dir.
		const warm = await outcome(tool.execute("call-warm", { pattern: "PUBLIC_\\w+", path: "plain.txt" }));
		expect(warm).toContain("PUBLIC_VALUE_7");

		// What a contained job swapping a symlink into the temp dir achieves, made deterministic: the
		// scratch location omp resolves now leads out of the writable roots.
		const runtime = await SandboxRuntime.for(workspace);
		const redirect = path.join(runtime.tempDir(), "redirect");
		fs.symlinkSync(elsewhere, redirect);
		vi.spyOn(runtime, "tempDir").mockReturnValue(redirect);

		const result = await outcome(
			tool.execute("call-redirected", { pattern: "ARCHIVE_\\w+", path: "bundle.tar:notes/member.txt" }),
		);
		expect(result).not.toContain("ARCHIVE_NEEDLE_9");
		expect(fs.readdirSync(elsewhere)).toEqual([]);
	});

	it("never writes an archive member's scratch copy into a dir a contained process swapped after it was made", async () => {
		await writeBundle();
		const elsewhere = makeElsewhere();
		const original = ContainedFileAccess.prototype.mutate;
		// The race window between creating the scratch dir and writing into it: once the host made the
		// dir, a contained job replaces it with a symlink out of the writable roots.
		const mutate = vi.spyOn(ContainedFileAccess.prototype, "mutate").mockImplementation(async function (
			this: ContainedFileAccess,
			mutation: HostFileMutation,
		) {
			await original.call(this, mutation);
			if (mutation.kind === "mkdir") {
				fs.rmSync(mutation.path, { recursive: true });
				fs.symlinkSync(elsewhere, mutation.path);
			}
		});
		try {
			const tool = new GrepTool(toolSession());
			const result = await outcome(
				tool.execute("call-swapped", { pattern: "ARCHIVE_\\w+", path: "bundle.tar:notes/member.txt" }),
			);
			expect(mutate).toHaveBeenCalled();
			expect(result).not.toContain("ARCHIVE_NEEDLE_9");
			expect(fs.readdirSync(elsewhere)).toEqual([]);
		} finally {
			mutate.mockRestore();
		}
	});

	it("previews an AST rewrite in the workspace and shows none for a symlinked denied file", async () => {
		const source = "const value = oldName();\n";
		fs.writeFileSync(path.join(workspace, "inside.ts"), source);
		fs.writeFileSync(path.join(outside, "beyond.ts"), source);
		fs.symlinkSync(path.join(outside, "beyond.ts"), path.join(workspace, "linked.ts"));
		const tool = new AstEditTool(toolSession());
		const ops = [{ pat: "oldName()", out: "newName()" }];

		const inside = await outcome(tool.execute("call-inside", { ops, paths: ["inside.ts"] }));
		expect(inside).toContain("newName");

		const linked = await outcome(tool.execute("call-linked", { ops, paths: ["linked.ts"] }));
		expect(linked).not.toContain("newName");
		// A preview writes nothing.
		expect(fs.readFileSync(path.join(outside, "beyond.ts"), "utf8")).toBe(source);
		expect(fs.readFileSync(path.join(workspace, "inside.ts"), "utf8")).toBe(source);
	});

	it("refuses a read through a workspace symlink to a denied file", async () => {
		const secret = path.join(outside, "secret.txt");
		fs.writeFileSync(secret, "top secret\n");
		fs.symlinkSync(secret, path.join(workspace, "link.txt"));
		// Called on the tool directly, so omp's path check never runs: the container must refuse it.
		const tool = new ReadTool(toolSession());
		for (const target of ["link.txt", "link.txt:raw"]) {
			expect(await outcome(tool.execute("call-escape", { path: target }))).not.toContain("top secret");
		}
		fs.writeFileSync(path.join(workspace, "inside.txt"), "kept\n");
		expect(await outcome(tool.execute("call-inside", { path: "inside.txt" }))).toContain("kept");
	});

	it("queries a workspace JSON file and refuses a symlink to a denied one", async () => {
		const secret = path.join(outside, "secret.json");
		fs.writeFileSync(secret, '{"a": "top secret"}\n');
		fs.writeFileSync(path.join(workspace, "data.json"), '{"a": "kept"}\n');
		fs.symlinkSync(secret, path.join(workspace, "link.json"));
		const tool = new ReadTool(toolSession());
		expect(await outcome(tool.execute("call-json", { path: "data.json?q=.a" }))).toContain("kept");
		expect(await outcome(tool.execute("call-json-escape", { path: "link.json?q=.a" }))).not.toContain("top secret");
	});

	it("lists a directory without revealing the entries of a denied one", async () => {
		const vault = path.join(workspace, "vault");
		fs.mkdirSync(vault);
		fs.writeFileSync(path.join(vault, "key.txt"), "key\n");
		fs.writeFileSync(path.join(workspace, "visible.txt"), "visible\n");
		cfgSandboxDenyRead.set(fixture.settings, [vault]);
		const tool = new ReadTool(toolSession());
		const listing = await outcome(tool.execute("call-list", { path: "." }));
		expect(listing).toContain("visible.txt");
		expect(listing).not.toContain("key.txt");
		expect(await outcome(tool.execute("call-list-denied", { path: "vault" }))).not.toContain("key.txt");
	});
});
