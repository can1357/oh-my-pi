import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	expandPromptTemplate,
	loadPromptTemplates,
	type PromptTemplate,
} from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	buildSnippetChoices,
	deleteSnippet,
	parseDeleteArgs,
	parseSaveArgs,
	resolveSnippetText,
	saveSnippet,
	snippetExists,
	snippetPath,
} from "@oh-my-pi/pi-coding-agent/config/snippets";

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snippets-test-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("saveSnippet", () => {
	test("saved bodies reload verbatim as prompt templates, including bodies that look like frontmatter", async () => {
		const dir = path.join(tmp, "prompts");
		const bodies = ["---\nnot frontmatter\n---\nafter", 'use {{x}} and $1: "q" # c'];
		for (const [index, body] of bodies.entries()) {
			expect(await saveSnippet({ dir, name: `s${index}`, text: body, force: false })).toEqual({
				kind: "saved",
				path: path.join(dir, `s${index}.md`),
			});
		}
		const templates = await loadPromptTemplates({ cwd: path.join(tmp, "project"), agentDir: tmp });
		const byName = new Map(templates.map(t => [t.name, t]));
		expect(byName.get("s0")?.content).toBe(bodies[0]!);
		expect(byName.get("s1")?.content).toBe(bodies[1]!);
		expect(byName.get("s0")?.description).toContain("---");
		expect(byName.get("s1")?.description).toContain('use {{x}} and $1: "q" # c');
	});

	test("long names can be saved exclusively and replaced with force", async () => {
		const dir = path.join(tmp, "prompts");
		const name = "a".repeat(212);
		await saveSnippet({ dir, name, text: "first", force: false });
		expect((await saveSnippet({ dir, name, text: "second", force: false })).kind).toBe("exists");
		expect(await Bun.file(snippetPath(dir, name)).text()).toContain("first");
		expect((await saveSnippet({ dir, name, text: "second", force: true })).kind).toBe("saved");
		expect(await Bun.file(snippetPath(dir, name)).text()).toContain("second");
	});

	test("rejects names that could escape the prompts dir", async () => {
		for (const name of ["../x", "1a", "a b"]) {
			expect(() => snippetPath(tmp, name)).toThrow("Invalid snippet name");
			await expect(saveSnippet({ dir: tmp, name, text: "x", force: false })).rejects.toThrow("Invalid snippet name");
		}
	});

	test("a symlinked snippet reports exists without force and is replaced, not followed, with force", async () => {
		const dir = path.join(tmp, "prompts");
		await fs.mkdir(dir, { recursive: true });
		const outside = path.join(tmp, "outside.txt");
		await Bun.write(outside, "precious");
		await fs.symlink(outside, path.join(dir, "linked.md"));

		expect((await saveSnippet({ dir, name: "linked", text: "new body", force: false })).kind).toBe("exists");
		expect((await saveSnippet({ dir, name: "linked", text: "new body", force: true })).kind).toBe("saved");

		expect(await Bun.file(outside).text()).toBe("precious");
		expect(await Bun.file(path.join(dir, "linked.md")).text()).toContain("new body");
		expect((await fs.lstat(path.join(dir, "linked.md"))).isSymbolicLink()).toBe(false);
		expect((await fs.readdir(dir)).filter(f => f.endsWith(".tmp"))).toEqual([]);
	});

	test("a long first line of wide characters is cut on a character boundary", async () => {
		const dir = path.join(tmp, "prompts");
		await saveSnippet({ dir, name: "wide", text: "😀".repeat(100), force: false });
		const [template] = await loadPromptTemplates({ cwd: path.join(tmp, "project"), agentDir: tmp });
		const saved = await Bun.file(path.join(dir, "wide.md")).text();
		expect(saved).not.toContain("\ufffd");
		expect(saved.isWellFormed()).toBe(true);
		expect(template?.description).toContain("…");
	});
});

describe("deleteSnippet", () => {
	test("reports deleted then missing", async () => {
		await saveSnippet({ dir: tmp, name: "gone", text: "x", force: false });
		expect(await deleteSnippet(tmp, "gone")).toBe("deleted");
		expect(await deleteSnippet(tmp, "gone")).toBe("missing");
	});

	test("a dangling symlink counts as present and is removed itself", async () => {
		await fs.symlink(path.join(tmp, "missing-target"), path.join(tmp, "dangling.md"));
		expect(await snippetExists(tmp, "dangling")).toBe(true);
		expect(await snippetExists(tmp, "absent")).toBe(false);
		expect(await deleteSnippet(tmp, "dangling")).toBe("deleted");
		expect(await snippetExists(tmp, "dangling")).toBe(false);
	});
});

describe("parseSaveArgs", () => {
	test("parses options and keeps the multi-line text intact", () => {
		expect(parseSaveArgs("review --scope project --force line1\nline2")).toEqual({
			name: "review",
			scope: "project",
			force: true,
			text: "line1\nline2",
		});
	});

	test("rejects bad scope and bad names; unknown flag starts the text", () => {
		expect(parseSaveArgs("x --scope nope")).toEqual({ error: "--scope must be user or project" });
		expect(parseSaveArgs("bad/name")).toHaveProperty("error");
		expect(parseSaveArgs("")).toHaveProperty("error");
		expect(parseSaveArgs("x --keep")).toEqual({ name: "x", scope: "user", force: false, text: "--keep" });
	});
});

describe("parseDeleteArgs", () => {
	test("leaves scope undefined unless given", () => {
		expect(parseDeleteArgs("a")).toEqual({ name: "a" });
		expect(parseDeleteArgs("a --scope project")).toEqual({ name: "a", scope: "project" });
		expect(parseDeleteArgs("a --nope")).toEqual({ error: "Unknown option: --nope" });
	});
});

describe("resolveSnippetText", () => {
	test("inline beats history, blank inline falls back to the last prompt, both blank is undefined", () => {
		const history = [{ text: "old" }, { text: " last " }];
		expect(resolveSnippetText(" inline ", history)).toBe("inline");
		expect(resolveSnippetText("  ", history)).toBe("last");
		expect(resolveSnippetText("", [])).toBeUndefined();
		expect(resolveSnippetText("", [{ text: "  " }])).toBeUndefined();
	});
});

const start = { atDraftStart: true, reservedCommands: new Set<string>() };
const midDraft = { atDraftStart: false, reservedCommands: new Set<string>() };

describe("buildSnippetChoices", () => {
	const template = (name: string, content: string, source = "(user)"): PromptTemplate => ({
		name,
		description: "",
		content,
		source,
	});

	test("only argument templates insert the namespaced /snippet:name invocation at the draft start", () => {
		const choices = buildSnippetChoices(
			[template("hello", "Say hello to $1"), template("plain", "just text")],
			start,
		);
		expect(choices.map(c => c.insertText)).toEqual(["/snippet:hello ", "just text"]);
		expect(choices[0]?.description).toContain("/snippet:hello");
	});

	test("argument templates insert their body mid-draft, where a slash command would not expand", () => {
		const choices = buildSnippetChoices([template("hello", "Say hello to $1")], midDraft);
		expect(choices[0]?.insertText).toBe("Say hello to $1");
		expect(choices[0]?.description).not.toContain("/snippet:hello");
	});

	test("duplicate names get unique source-qualified labels and raw bodies", () => {
		const choices = buildSnippetChoices(
			[template("dup", "a $1", "(project)"), template("dup", "b $1", "(user)")],
			start,
		);
		expect(choices.map(c => c.label)).toEqual(["dup (project)", "dup (user)"]);
		expect(choices.map(c => c.insertText)).toEqual(["a $1", "b $1"]);
	});

	test("a name with a space never gets the invocation form, which would split at the space", () => {
		const [choice] = buildSnippetChoices([template("code review", "Review $1")], start);
		expect(choice?.insertText).toBe("Review $1");
	});

	test("control sequences and tabs never reach the picker text or the inserted body", () => {
		const [choice] = buildSnippetChoices([template("raw", "a\x1b]0;x\x07b\tc\x1b[31md")], start);
		expect(choice?.description).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		expect(choice?.insertText).toMatch(/^ab +cd$/);
	});

	test("a command that already owns the snippet: token keeps the invocation form out of the editor", () => {
		const reserved = { atDraftStart: true, reservedCommands: new Set(["snippet:hello"]) };
		expect(buildSnippetChoices([template("hello", "Say hello to $1")], reserved)[0]?.insertText).toBe(
			"Say hello to $1",
		);
	});

	test("tabs and newlines in a name or source cannot add rows or leave tabs in the picker text", () => {
		const [choice] = buildSnippetChoices([template("a\tb\nc", "body", "(project:x\ty)")], start);
		expect(choice?.label).toBe("a b c");
		expect(`${choice?.label}${choice?.description}`).not.toMatch(/[\t\n]/);
	});

	test("names that clean up to the same text still get distinct labels the picker can return", () => {
		const choices = buildSnippetChoices([template("a b", "one"), template("a\tb", "two")], start);
		const labels = choices.map(c => c.label);
		expect(new Set(labels).size).toBe(2);
		expect(choices.map(c => c.insertText).sort()).toEqual(["one", "two"]);
	});

	test("a template literally named snippet:<name> reserves that token, so the alias is not emitted", () => {
		const choices = buildSnippetChoices([template("foo", "Say $1"), template("snippet:foo", "Other $1")], start);
		expect(choices.find(c => c.label === "foo")?.insertText).toBe("Say $1");
	});
});

describe("snippet: command namespace", () => {
	const templates: PromptTemplate[] = [
		{ name: "hello", description: "", content: "Say hello to $1", source: "(user)" },
	];

	test("/snippet:<name> expands like /<name>; other prefixes and unknown names are left alone", () => {
		expect(expandPromptTemplate("/snippet:hello world", templates)).toBe("Say hello to world");
		expect(expandPromptTemplate("/hello world", templates)).toBe("Say hello to world");
		expect(expandPromptTemplate("/snippet:nope world", templates)).toBe("/snippet:nope world");
		expect(expandPromptTemplate("/skill:hello world", templates)).toBe("/skill:hello world");
	});
});

describe("default save text after branching", () => {
	test("the active-branch listing excludes prompts from an abandoned branch", async () => {
		const authStorage = await AuthStorage.create(path.join(tmp, "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tmp, "models.yml")),
		});
		try {
			const first = session.sessionManager.appendMessage({ role: "user", content: "active prompt", timestamp: 1 });
			session.sessionManager.appendMessage({ role: "user", content: "abandoned prompt", timestamp: 2 });
			session.sessionManager.branch(first);

			expect(session.getUserMessagesForBranching().map(m => m.text)).toEqual(["active prompt", "abandoned prompt"]);
			const active = session.getUserMessagesForBranching({ activeBranchOnly: true });
			expect(active.map(m => m.text)).toEqual(["active prompt"]);
			expect(resolveSnippetText("", active)).toBe("active prompt");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
