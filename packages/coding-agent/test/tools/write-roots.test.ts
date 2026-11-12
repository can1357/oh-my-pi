/**
 * `tools.writeRoots` — opt-in confinement of the write-capable file tools
 * (`write`, `edit` incl. rename/delete, `ast_edit`) to allowed roots.
 *
 * Fails pre-fix: with no setting the tools honor absolute paths, `..` and
 * symlinked directories anywhere on the filesystem.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools } from "@oh-my-pi/pi-coding-agent/tools";

const OUTSIDE_TEXT = "original-outside\n";
const SOURCE_TEXT = `console.log("before");\n`;

function createSession(cwd: string, writeRoots?: string[]): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(writeRoots === undefined ? {} : { "tools.writeRoots": writeRoots }),
		enableLsp: false,
	} as unknown as ToolSession;
}

async function expectRefused(promise: Promise<unknown>, outsideDir: string): Promise<string> {
	const before = fs.readdirSync(outsideDir).sort();
	let message: string;
	try {
		await promise;
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
		expect(message).toContain("tools.writeRoots");
		expect(fs.readdirSync(outsideDir).sort()).toEqual(before);
		return message;
	}
	throw new Error("expected the write to be refused, but it succeeded");
}

describe("tools.writeRoots confinement", () => {
	let base: string;
	let candidate: string;
	let outside: string;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "write-roots-"));
		candidate = path.join(base, "candidate");
		outside = path.join(base, "outside");
		fs.mkdirSync(candidate, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(base);
	});

	it("write inside the root succeeds, absolute and ../.. escapes are refused", async () => {
		const session = createSession(candidate, [candidate]);
		const tool = new WriteTool(session);

		const inside = await tool.execute("ok", { path: "inside.md", content: "hello\n" });
		expect(inside.isError).not.toBe(true);
		expect(fs.readFileSync(path.join(candidate, "inside.md"), "utf8")).toBe("hello\n");

		await expectRefused(tool.execute("abs", { path: path.join(outside, "abs.md"), content: "escaped\n" }), outside);
		await expectRefused(tool.execute("rel", { path: "../outside/rel.md", content: "escaped\n" }), outside);
	});

	it("write with the setting off is unrestricted (default)", async () => {
		const session = createSession(candidate);
		const tool = new WriteTool(session);
		const result = await tool.execute("abs", { path: path.join(outside, "abs.md"), content: "x\n" });
		expect(result.isError).not.toBe(true);
		expect(fs.existsSync(path.join(outside, "abs.md"))).toBe(true);
	});

	it("reads outside the root stay allowed", async () => {
		fs.writeFileSync(path.join(outside, "allowed.md"), "records\n");
		const session = createSession(candidate, [candidate]);
		const result = await new ReadTool(session).execute("read-outside", {
			path: path.join(outside, "allowed.md"),
		} as never);
		expect(result.isError).not.toBe(true);
		expect(JSON.stringify(result.content)).toContain("records");
	});

	it("edit create/update inside succeeds; absolute, ../ and symlink escapes refused", async () => {
		const escapeLink = path.join(candidate, "escape");
		fs.symlinkSync(outside, escapeLink);
		const session = createSession(candidate, [candidate]);
		const tool = new EditTool(session, "patch");

		const created = await tool.execute("create", {
			path: "inside.md",
			edits: [{ op: "create", diff: "hello\n" }],
		});
		expect(created.isError ?? false).toBe(false);
		expect(fs.readFileSync(path.join(candidate, "inside.md"), "utf8")).toContain("hello");

		await expectRefused(
			tool.execute("abs", {
				path: path.join(outside, "x.md"),
				edits: [{ op: "create", diff: "escaped\n" }],
			}),
			outside,
		);
		await expectRefused(
			tool.execute("rel", {
				path: "../outside/x.md",
				edits: [{ op: "create", diff: "escaped\n" }],
			}),
			outside,
		);
		await expectRefused(
			tool.execute("link", {
				path: "escape/x.md",
				edits: [{ op: "create", diff: "escaped\n" }],
			}),
			outside,
		);
	});

	it("edit rename and delete outside are refused on both spellings", async () => {
		const escapeLink = path.join(candidate, "escape");
		fs.symlinkSync(outside, escapeLink);
		const victim = path.join(outside, "victim.md");
		fs.writeFileSync(victim, OUTSIDE_TEXT);
		const inner = path.join(candidate, "inner.md");
		fs.writeFileSync(inner, "inner\n");
		const session = createSession(candidate, [candidate]);
		const tool = new EditTool(session, "patch");

		// Rename inside -> outside (absolute destination).
		await expectRefused(
			tool.execute("rename-out", {
				path: "inner.md",
				edits: [{ op: "update", rename: victim, diff: "@@\n-inner\n+inner\n" }],
			}),
			outside,
		);
		expect(fs.existsSync(inner)).toBe(true);

		// Rename outside -> inside (absolute source).
		await expectRefused(
			tool.execute("rename-in", {
				path: victim,
				edits: [{ op: "update", rename: "rescued.md", diff: "@@\n-original-outside\n+rescued\n" }],
			}),
			outside,
		);

		// Delete via absolute, ../ and symlink spellings keeps the file.
		for (const [id, target] of [
			["del-abs", victim],
			["del-rel", "../outside/victim.md"],
			["del-link", "escape/victim.md"],
		] as const) {
			await expectRefused(tool.execute(id, { path: target, edits: [{ op: "delete" }] }), outside);
			expect(fs.readFileSync(victim, "utf8")).toBe(OUTSIDE_TEXT);
		}
	});

	it("ast_edit inside succeeds; absolute and ../ scopes refused", async () => {
		fs.writeFileSync(path.join(candidate, "code.ts"), `${SOURCE_TEXT}`);
		fs.writeFileSync(path.join(outside, "target.ts"), `${SOURCE_TEXT}`);
		const session = createSession(candidate, [candidate]);
		const tool = new AstEditTool(session);

		// No tool-choice queue in this session, so the rewrite stages as a preview
		// instead of applying: success means confinement passed, not that bytes landed.
		const ok = await tool.execute("ok", {
			ops: [{ pat: 'console.log("before")', out: 'console.log("after")' }],
			paths: ["code.ts"],
		});
		expect(ok.isError).not.toBe(true);
		expect(JSON.stringify(ok.content)).toContain("code.ts");

		await expectRefused(
			tool.execute("abs", {
				ops: [{ pat: 'console.log("before")', out: 'console.log("after")' }],
				paths: [path.join(outside, "target.ts")],
			}),
			outside,
		);
		await expectRefused(
			tool.execute("rel", {
				ops: [{ pat: 'console.log("before")', out: 'console.log("after")' }],
				paths: ["../outside/target.ts"],
			}),
			outside,
		);
		expect(fs.readFileSync(path.join(outside, "target.ts"), "utf8")).toBe(SOURCE_TEXT);
	});

	it("ast_edit through a symlinked directory inside the scope is refused", async () => {
		const escapeLink = path.join(candidate, "escape");
		fs.symlinkSync(outside, escapeLink);
		fs.writeFileSync(path.join(outside, "target.ts"), `${SOURCE_TEXT}`);
		const session = createSession(candidate, [candidate]);
		const tool = new AstEditTool(session);

		await expectRefused(
			tool.execute("link", {
				ops: [{ pat: 'console.log("before")', out: 'console.log("after")' }],
				paths: ["escape/target.ts"],
			}),
			outside,
		);
		expect(fs.readFileSync(path.join(outside, "target.ts"), "utf8")).toBe(SOURCE_TEXT);
	});

	it("dangling symlink targets are refused, not followed", async () => {
		const dangling = path.join(candidate, "dangling");
		fs.symlinkSync(path.join(outside, "missing.md"), dangling);
		const session = createSession(candidate, [candidate]);
		const tool = new WriteTool(session);
		await expectRefused(tool.execute("dangling", { path: "dangling", content: "x\n" }), outside);
	});

	it("link/../ escapes resolve through the symlink, not past it", async () => {
		const escapeLink = path.join(candidate, "escape");
		fs.symlinkSync(outside, escapeLink);
		const session = createSession(candidate, [candidate]);
		const tool = new WriteTool(session);
		// Absolute authored path preserves `link/..` through resolution, so the
		// kernel climbs from the link target: the write would land beside
		// outside, not beside the link. The guard must refuse it.
		// NOTE: string concatenation, not path.join — join would collapse
		// `..` before the tool ever sees it, which is exactly the bug shape.
		const authored = `${escapeLink}/../escaped.md`;
		await expectRefused(tool.execute("linkdotdot", { path: authored, content: "escaped\n" }), outside);
		expect(fs.existsSync(path.join(candidate, "escaped.md"))).toBe(false);
		expect(fs.existsSync(path.join(base, "escaped.md"))).toBe(false);
	});

	it("conflict:// writes to files outside the roots are refused", async () => {
		const victim = path.join(outside, "victim.md");
		fs.writeFileSync(
			victim,
			["<<<<<<< ours", "inside", "=======", "outside", ">>>>>>> theirs", ""].join("\n"),
		);
		const session = createSession(candidate, [candidate]);
		const read = new ReadTool(session);
		const seen = await read.execute("read-victim", { path: victim } as never);
		expect(seen.isError).not.toBe(true);
		const tool = new WriteTool(session);
		await expectRefused(tool.execute("conflict", { path: "conflict://1", content: "resolved\n" }), outside);
		expect(fs.readFileSync(victim, "utf8")).toContain("<<<<<<< ours");
	});

	it("apply cannot rewrite files added after the preview outside narrowed roots", async () => {
		fs.writeFileSync(path.join(candidate, "inside.ts"), `${SOURCE_TEXT}`);
		const settings = Settings.isolated({ "tools.writeRoots": [candidate], "tools.xdev": false });
		const queue = new ToolChoiceQueue();
		const session = {
			cwd: candidate,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			steer: () => {},
		} as unknown as ToolSession;
		const tools = await createTools(session, ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		const preview = await tool!.execute("preview", {
			ops: [{ pat: 'console.log("before")', out: 'console.log("after")' }],
			paths: ["**/*.ts"],
		});
		expect(preview.isError).not.toBe(true);
		// A matching file appears outside the roots after the preview.
		fs.writeFileSync(path.join(outside, "late.ts"), `${SOURCE_TEXT}`);
		expect(queue.hasPendingInvoker).toBe(true);
		const invoker = queue.peekPendingInvoker()!;
		const applied = (await invoker({ action: "apply", reason: "apply previewed edit" })) as {
			isError?: boolean;
		};
		expect(applied.isError).toBeUndefined();
		expect(fs.readFileSync(path.join(candidate, "inside.ts"), "utf8")).toContain("after");
		expect(fs.readFileSync(path.join(outside, "late.ts"), "utf8")).toBe(SOURCE_TEXT);
	});
});
