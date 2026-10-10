import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type AnnotationContext,
	createAnnotationsAPI,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/api";
import * as fullscreen from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/fullscreen";
import * as review from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import { createResolvedReviewTarget } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/target";
import type { SendUserMessageOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const DIFF = `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1,2 +1,2 @@
 const keep = true;
-const value = 1;
+const value = 2;
`;

function assistantEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-20T00:00:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage,
	};
}

function createContext(
	options: {
		mode?: AnnotationContext["mode"];
		hasUI?: boolean;
		supportsEditor?: boolean;
		branch?: SessionMessageEntry[];
		cwd?: string;
		idle?: boolean;
	} = {},
) {
	const pasteToEditor = vi.fn((_text: string) => undefined);
	const sendUserMessage = vi.fn((_text: string, _options?: SendUserMessageOptions) => undefined);
	const cwd = options.cwd ?? "/workspace";
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		// The materialized cwd is stale; the API must read the live session cwd.
		cwd: "/stale",
		isIdle: () => options.idle ?? true,
		sessionManager: { getBranch: () => options.branch ?? [], getCwd: () => cwd, getSessionId: () => "session-1" },
		ui: { supportsEditor: options.supportsEditor ?? true, pasteToEditor, notify: vi.fn() },
	} as unknown as AnnotationContext;
	return { api: createAnnotationsAPI(() => ctx, sendUserMessage), pasteToEditor, sendUserMessage };
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("annotations API: submit", () => {
	it("quotes the addressed source line and pastes the same feedback /annotate would", async () => {
		const { api, pasteToEditor, sendUserMessage } = createContext();

		const result = await api.submit({
			source: { kind: "text", text: "alpha\r\nbeta\ngamma", label: "notes.md" },
			notes: [{ line: 2, note: "rename this" }, { note: "overall fine" }],
		});

		expect(result.annotations).toEqual([
			{ scope: "line", line: 2, quote: "beta", note: "rename this" },
			{ scope: "text", note: "overall fine" },
		]);
		expect(result.delivered).toBe("paste");
		expect(pasteToEditor).toHaveBeenCalledWith(result.text!);
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(result.text).toContain('"beta"');
		expect(result.text).toContain("rename this");
	});

	it("rejects a note whose line is outside the source instead of quoting nothing", async () => {
		const { api, pasteToEditor } = createContext();

		await expect(
			api.submit({ source: { kind: "text", text: "one\ntwo" }, notes: [{ line: 3, note: "past the end" }] }),
		).rejects.toThrow("line 3 is outside");
		expect(pasteToEditor).not.toHaveBeenCalled();
	});

	it("reads a file source relative to the live session cwd and rejects a missing file", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "annotate-api-"));
		try {
			await fs.writeFile(path.join(directory, "doc.txt"), "first\nsecond\n");
			const { api } = createContext({ cwd: directory });

			const result = await api.submit({
				source: { kind: "file", path: "doc.txt" },
				notes: [{ line: 2, note: "tighten" }],
				deliver: "none",
			});
			expect(result.annotations).toEqual([{ scope: "line", line: 2, quote: "second", note: "tighten" }]);

			await expect(
				api.submit({ source: { kind: "file", path: "absent.txt" }, notes: [{ note: "x" }] }),
			).rejects.toThrow('Unable to read annotation file "absent.txt"');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("annotates the latest assistant reply and refuses an empty branch", async () => {
		const withReply = createContext({
			branch: [assistantEntry("a1", "first reply"), assistantEntry("a2", "latest reply")],
		});
		const result = await withReply.api.submit({
			source: { kind: "last" },
			notes: [{ line: 1, note: "check this" }],
			deliver: "none",
		});
		expect(result.text).toContain("your last reply");
		expect(result.annotations).toEqual([{ scope: "line", line: 1, quote: "latest reply", note: "check this" }]);

		await expect(createContext().api.submit({ source: { kind: "last" }, notes: [{ note: "x" }] })).rejects.toThrow(
			"No non-empty assistant reply",
		);
	});

	it("maps diff notes onto exact hunk rows, honoring the old side for removed lines", async () => {
		const { api } = createContext();

		const result = await api.submit({
			source: { kind: "diff", diff: DIFF },
			notes: [
				{ path: "src/value.ts", line: 2, note: "new side" },
				{ path: "src/value.ts", line: 2, side: "old", note: "old side" },
				{ path: "src/value.ts", note: "file wide" },
			],
			deliver: "none",
		});

		expect(result.annotations).toMatchObject([
			{ scope: "line", newLine: 2, rawLine: "+const value = 2;", hunkHeader: "@@ -1,2 +1,2 @@", note: "new side" },
			{ scope: "line", oldLine: 2, rawLine: "-const value = 1;", note: "old side" },
			{ scope: "file", path: "src/value.ts", occurrence: 1, note: "file wide" },
		]);
		expect(result.review).toBe(false);
		expect(result.text).toContain("file wide");
	});

	it("rejects diff notes for a path or line the diff does not contain", async () => {
		const { api } = createContext();

		await expect(
			api.submit({ source: { kind: "diff", diff: DIFF }, notes: [{ path: "src/other.ts", note: "x" }] }),
		).rejects.toThrow("src/other.ts (occurrence 1) is not in the diff");
		await expect(
			api.submit({ source: { kind: "diff", diff: DIFF }, notes: [{ path: "src/value.ts", line: 99, note: "x" }] }),
		).rejects.toThrow("new line 99 of src/value.ts is not in the diff");
	});

	it("names the exclusion rule when a note targets a file the review filter withholds", async () => {
		const lockDiff = `diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1 +1 @@
-a
+b
${DIFF}`;
		const { api } = createContext();

		await expect(
			api.submit({ source: { kind: "diff", diff: lockDiff }, notes: [{ path: "bun.lock", note: "why" }] }),
		).rejects.toThrow("bun.lock is excluded from review");
	});

	it("builds the full review request with notes as operator focus and sends it", async () => {
		const { api, pasteToEditor, sendUserMessage } = createContext();

		const result = await api.submit({
			source: { kind: "diff", diff: DIFF, label: "Reviewing a patch" },
			notes: [{ path: "src/value.ts", line: 2, note: "is 2 right?" }],
			review: true,
			focus: "watch the constants",
		});

		expect(result.review).toBe(true);
		expect(result.delivered).toBe("send");
		expect(sendUserMessage).toHaveBeenCalledWith(result.text!, undefined);
		expect(pasteToEditor).not.toHaveBeenCalled();
		expect(result.text).toContain("Reviewing a patch");
		expect(result.text).toContain("is 2 right?");
		expect(result.text).toContain("watch the constants");
		expect(result.text).toContain(DIFF.trim());
	});

	it("sends notes automatically without a UI and refuses an explicit paste without an editor", async () => {
		const headless = createContext({ mode: "rpc", hasUI: false });
		const request = { source: { kind: "text" as const, text: "a\nb" }, notes: [{ line: 1, note: "n" }] };

		const sent = await headless.api.submit(request);
		expect(sent.delivered).toBe("send");
		expect(headless.sendUserMessage).toHaveBeenCalledWith(sent.text!, undefined);

		await expect(headless.api.submit({ ...request, deliver: "paste" })).rejects.toThrow(
			"Cannot paste annotation feedback",
		);
		expect(headless.pasteToEditor).not.toHaveBeenCalled();
	});

	it("queues sent feedback as a follow-up while the agent is streaming", async () => {
		const { api, sendUserMessage } = createContext({ idle: false });

		const result = await api.submit({
			source: { kind: "diff", diff: DIFF },
			notes: [{ path: "src/value.ts", note: "after this turn" }],
			review: true,
		});

		expect(result.delivered).toBe("send");
		expect(sendUserMessage).toHaveBeenCalledWith(result.text!, { deliverAs: "followUp" });
	});

	it("rejects anchored notes whose source content drifted", async () => {
		const { api, sendUserMessage } = createContext();

		await expect(
			api.submit({
				source: { kind: "text", text: "alpha\nbeta" },
				notes: [{ line: 2, quote: "gamma", note: "stale text" }],
			}),
		).rejects.toThrow("Annotation 1: line 2 of Text prompt no longer matches its quote");
		await expect(
			api.submit({
				source: { kind: "diff", diff: DIFF },
				notes: [
					{ path: "src/value.ts", line: 1, rawLine: " const keep = true;", note: "anchored" },
					{ path: "src/value.ts", line: 2, rawLine: "+const value = 3;", note: "stale diff" },
				],
			}),
		).rejects.toThrow("Annotation 2: new line 2 of src/value.ts no longer matches its rawLine");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("resolves a PR reference through the central fetcher and rejects a malformed reference", async () => {
		spyOn(review, "fetchPrReviewTarget").mockImplementation(async (cwd, ref) =>
			createResolvedReviewTarget("pr", `PR ${ref.repo}#${ref.number} in ${cwd}`, DIFF, "empty"),
		);
		const { api } = createContext({ cwd: "/live-worktree" });

		const result = await api.submit({
			source: { kind: "pr", ref: "https://github.com/acme/project/pull/42" },
			notes: [{ path: "src/value.ts", note: "pr note" }],
			review: true,
			deliver: "none",
		});

		expect(result.text).toContain("PR acme/project#42 in /live-worktree");
		expect(result.text).toContain("pr note");
		await expect(
			api.submit({ source: { kind: "pr", ref: "not a pr" }, notes: [{ path: "x", note: "y" }] }),
		).rejects.toThrow("Not a GitHub pull request reference");
	});
});

describe("annotations API: open", () => {
	it("mounts the overlay on the supplied text, returns the operator's notes, and honors an edit", async () => {
		const showText = spyOn(fullscreen, "showTextReviewOverlay").mockResolvedValue({
			action: "paste",
			annotations: [{ scope: "line", line: 1, quote: "rewritten", note: "better" }],
			editedText: "rewritten\nkept",
		});
		const { api, pasteToEditor } = createContext();

		const result = await api.open({ source: { kind: "text", text: "original\nkept" } });

		expect(showText).toHaveBeenCalledTimes(1);
		if (result?.kind !== "text") throw new Error("expected a text result");
		expect(result.editedText).toBe("rewritten\nkept");
		expect(result?.text).toContain("rewritten\nkept");
		expect(result?.delivered).toBe("paste");
		expect(pasteToEditor).toHaveBeenCalledWith(result!.text!);
	});

	it("returns undefined and delivers nothing when the operator dismisses the overlay", async () => {
		spyOn(fullscreen, "showCodeReviewOverlay").mockResolvedValue(undefined);
		const { api, pasteToEditor, sendUserMessage } = createContext();

		expect(await api.open({ source: { kind: "diff", diff: DIFF } })).toBeUndefined();
		expect(pasteToEditor).not.toHaveBeenCalled();
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("sends the review request when the operator continues with the LLM review", async () => {
		spyOn(fullscreen, "showCodeReviewOverlay").mockResolvedValue({
			action: "review",
			annotations: [{ scope: "file", path: "src/value.ts", occurrence: 1, note: "look closer" }],
		});
		const { api, sendUserMessage } = createContext();

		const result = await api.open({ source: { kind: "diff", diff: DIFF }, focus: "be strict" });

		expect(result?.review).toBe(true);
		expect(result?.delivered).toBe("send");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(result?.text).toContain("be strict");
	});

	it("rejects an oversized supplied patch before the operator can annotate it", async () => {
		const showCode = spyOn(fullscreen, "showCodeReviewOverlay");
		const { api } = createContext();

		await expect(
			api.open({ source: { kind: "diff", diff: DIFF + " ".repeat(50_001 - DIFF.length) } }),
		).rejects.toThrow("exceeds the review limit");
		expect(showCode).not.toHaveBeenCalled();
	});

	it("refuses to open the overlay outside the interactive TUI", async () => {
		const showText = spyOn(fullscreen, "showTextReviewOverlay");
		const { api } = createContext({ mode: "rpc", hasUI: true });

		await expect(api.open({ source: { kind: "text", text: "x" } })).rejects.toThrow("needs the interactive TUI");
		expect(showText).not.toHaveBeenCalled();
	});
});

describe("annotations API: review regressions", () => {
	it("attaches a note to the file at that exact path before a rename's old name can capture it", async () => {
		const renameThenNew = `diff --git a/A.ts b/B.ts
similarity index 90%
rename from A.ts
rename to B.ts
--- a/A.ts
+++ b/B.ts
@@ -1 +1 @@
-x
+y
diff --git a/A.ts b/A.ts
new file mode 100644
--- /dev/null
+++ b/A.ts
@@ -0,0 +1 @@
+fresh
`;
		const { api } = createContext();

		const result = await api.submit({
			source: { kind: "diff", diff: renameThenNew },
			notes: [{ path: "A.ts", line: 1, note: "on the new A" }],
			deliver: "none",
		});

		expect(result.annotations).toMatchObject([{ scope: "line", path: "A.ts", rawLine: "+fresh" }]);
	});

	it("rejects a supplied review patch over the file limit before sending it", async () => {
		const files = Array.from(
			{ length: 21 },
			(_, index) => `diff --git a/f${index}.ts b/f${index}.ts
--- a/f${index}.ts
+++ b/f${index}.ts
@@ -1 +1 @@
-old${index}
+new${index}
`,
		).join("");
		const { api, sendUserMessage, pasteToEditor } = createContext();

		await expect(
			api.submit({
				source: { kind: "diff", diff: files },
				notes: [{ path: "f20.ts", line: 1, note: "last file" }],
				review: true,
			}),
		).rejects.toThrow("exceeds the review limit");
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(pasteToEditor).not.toHaveBeenCalled();
	});

	it("accepts the review character boundary and rejects one character beyond before sending", async () => {
		const { api, sendUserMessage } = createContext();
		const bounded = DIFF + " ".repeat(50_000 - DIFF.length);
		const result = await api.submit({
			source: { kind: "diff", diff: bounded },
			notes: [],
			review: true,
			deliver: "none",
		});
		expect(result.text).toContain(DIFF.trim());
		await expect(
			api.submit({ source: { kind: "diff", diff: bounded + " " }, notes: [], review: true }),
		).rejects.toThrow("exceeds the review limit");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("rejects explicit paste in a non-editor host even when its notification UI is available", async () => {
		const { api, pasteToEditor } = createContext({ mode: "rpc", hasUI: true, supportsEditor: false });
		const request = { source: { kind: "text" as const, text: "line" }, notes: [{ note: "feedback" }] };

		await expect(api.submit({ ...request, deliver: "paste" })).rejects.toThrow("Cannot paste annotation feedback");
		expect(pasteToEditor).not.toHaveBeenCalled();
	});

	it("sends automatically in RPC mode but pastes into its remote editor on request", async () => {
		const { api, pasteToEditor, sendUserMessage } = createContext({ mode: "rpc", hasUI: true, supportsEditor: true });
		const request = { source: { kind: "text" as const, text: "line" }, notes: [{ note: "remote feedback" }] };

		const automatic = await api.submit(request);
		const explicit = await api.submit({ ...request, deliver: "paste" });

		expect(automatic.delivered).toBe("send");
		expect(sendUserMessage).toHaveBeenCalledWith(automatic.text!, undefined);
		expect(explicit.delivered).toBe("paste");
		expect(pasteToEditor).toHaveBeenCalledWith(explicit.text!);
	});

	it("mounts the overlay through a handler-scoped ui, not the runner's raw ui", async () => {
		const sessionManager = SessionManager.inMemory(process.cwd());
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			process.cwd(),
			sessionManager,
			new ModelRegistry(await AuthStorage.create(":memory:")),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			createAnnotationsAPI,
		);
		const scopedCustom = vi.fn(async () => undefined);
		const scoped: ExtensionContext = Object.create(runner.createContext());
		Object.defineProperty(scoped, "mode", { value: "tui" });
		Object.defineProperty(scoped, "ui", { value: { custom: scopedCustom, notify: vi.fn() } });

		const result = await scoped.annotations.open({ source: { kind: "text", text: "line" } });

		expect(scopedCustom).toHaveBeenCalledTimes(1);
		expect(result).toBeUndefined();
	});
});
