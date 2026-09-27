/**
 * Contract: the turn-card markdown a topic publishes — header (title, step
 * count, duration, cost, context), the todo checklist and the tool-step lines,
 * with older steps collapsing once a turn runs long.
 *
 * Duration/cost/context wording is English (`formatDuration` from
 * `@oh-my-pi/pi-utils`), unlike the lifeos module's Russian labels.
 */
import { describe, expect, it } from "bun:test";
import {
	activityMarkdown,
	argumentOf,
	planTasks,
	toolIcon,
	toolStep,
	type ActivityState,
	type ToolStep,
} from "@oh-my-pi/pi-coding-agent/telegram/activity";

interface StepPatch extends Partial<ToolStep> {
	name: string;
}

const step = ({ name, arg = null, status = "ok", startedAt = 0, endedAt = 340, ...rest }: StepPatch): ToolStep => ({
	kind: "tool",
	callId: null,
	name,
	arg,
	status,
	startedAt,
	endedAt,
	...rest,
});

const state = (patch: Partial<ActivityState> = {}): ActivityState => ({
	status: "running",
	startedAt: 0,
	now: 12_000,
	steps: [step({ name: "read", arg: "bin/x.mjs" })],
	plan: [],
	cost: null,
	contextPercent: null,
	error: null,
	...patch,
});

describe("toolIcon", () => {
	it("names the kind of tool a step ran, and falls back for strangers", () => {
		expect(toolIcon("read")).toBe("📖");
		expect(toolIcon("write")).toBe("✏️");
		expect(toolIcon("edit")).toBe("✏️");
		expect(toolIcon("bash")).toBe("💻");
		expect(toolIcon("grep")).toBe("🔍");
		expect(toolIcon("glob")).toBe("🔍");
		expect(toolIcon("task")).toBe("🤖");
		expect(toolIcon("web_search")).toBe("🌐");
		expect(toolIcon("eval")).toBe("🧮");
		expect(toolIcon("todo")).toBe("📋");
		expect(toolIcon("ask")).toBe("❓");
		expect(toolIcon("lsp_hover")).toBe("🧭");
		expect(toolIcon("mystery")).toBe("🔧");
	});
});

describe("activityMarkdown", () => {
	it("renders a live turn with step count, duration lines and no collapse", () => {
		const text = activityMarkdown(
			state({
				steps: [
					step({ name: "read", arg: "bin/x.mjs", status: "ok" }),
					step({ name: "bash", arg: "exit 7", status: "error", startedAt: 400, endedAt: 500 }),
					step({ name: "todo", status: "running", startedAt: 600, endedAt: null }),
				],
			}),
		);
		expect(text).toContain("**⚙️ Working** · 3 steps · 12.0s");
		expect(text).toContain("- ✅ 📖 `read` `bin/x.mjs` · 340ms");
		expect(text).toContain("- ❌ 💻 `bash` `exit 7` · 100ms");
		expect(text).toContain("- ⏳ 📋 `todo`");
		expect(text).not.toContain("<details>");
	});

	it("shows only the header for a turn without steps", () => {
		expect(activityMarkdown(state({ steps: [] }))).toBe("**⚙️ Working** · 12.0s");
	});

	it("marks a failed turn and names the reason", () => {
		const text = activityMarkdown(
			state({ status: "failed", error: "process died", steps: [step({ name: "bash", status: "error" })] }),
		);
		expect(text).toContain("**⚠️ Failed: process died**");
		expect(text).toContain("❌ 💻");
		expect(text).not.toContain("✅");
	});

	it("renders the todo plan as a checklist", () => {
		const plan = planTasks([
			{
				name: "Work",
				tasks: [
					{ content: "Render fix", status: "completed" },
					{ content: "Tests", status: "in_progress" },
					{ content: "Docs", status: "pending" },
				],
			},
		]);
		const text = activityMarkdown(state({ plan }));
		expect(text).toContain("**📋 Plan**");
		expect(text).toContain("- [x] Render fix");
		expect(text).toContain("- [ ] Tests");
		expect(text).toContain("- [ ] Docs");
	});

	it("collapses all but the last eight steps while the turn runs", () => {
		const steps = Array.from({ length: 12 }, (_unused, index) => step({ name: "bash", arg: `step ${index}` }));
		const text = activityMarkdown(state({ steps }));
		expect(text).toContain("<details><summary>4 more steps</summary>");
		expect(text).toContain("`step 0`");
		expect(text).toContain("- ✅ 💻 `bash` `step 11` · 340ms");
	});

	it("collapses every step on a finished turn and names cost and context", () => {
		const text = activityMarkdown(
			state({
				status: "done",
				cost: 0.002646558,
				contextPercent: 0.55,
				steps: [step({ name: "bash", arg: "git status" })],
			}),
		);
		expect(text).toContain("**✅ Done** · 1 step · 12.0s · $0.0026 · context 0.6%");
		expect(text).toContain("<details><summary>Steps (1)</summary>");
		expect(text).toContain("`bash` `git status`");
	});

	it("calls a stopped turn stopped", () => {
		expect(activityMarkdown(state({ status: "stopped" }))).toContain("**⏹ Stopped**");
	});

	it("escapes untrusted arguments and plan text instead of breaking the markup", () => {
		const text = activityMarkdown(
			state({
				steps: [step({ name: "bash", arg: "echo `who` here" })],
				plan: [{ content: "line * with | mark", status: "pending" }],
			}),
		);
		expect(text).toContain("``echo `who` here``");
		expect(text).toContain("- [ ] line \\* with \\| mark");
	});

	it("renders a notice line with its icon and no duration", () => {
		const text = activityMarkdown(
			state({ steps: [{ kind: "notice", icon: "🔁", label: "Retry · attempt 2 of 5" }] }),
		);
		expect(text).toContain("- 🔁 Retry · attempt 2 of 5");
	});
});

describe("argumentOf", () => {
	it("picks the first familiar field and counts list-shaped ones", () => {
		expect(argumentOf({ command: "git status" })).toBe("git status");
		expect(argumentOf({ file_path: "/etc/hosts" })).toBe("/etc/hosts");
		expect(argumentOf({ tasks: [{}, {}] })).toBe("2 agents");
		expect(argumentOf({ tasks: [{}] })).toBe("1 agent");
		expect(argumentOf({ phases: [{}, {}, {}] })).toBe("3 phases");
		expect(argumentOf({ images: [{}] })).toBe("1 image");
		expect(argumentOf({ command: "one\ntwo" })).toBe("one");
		expect(argumentOf({}, "from the intent")).toBe("from the intent");
		expect(argumentOf({})).toBeNull();
		expect(argumentOf(null)).toBeNull();
	});
});

describe("toolStep", () => {
	it("takes its argument from args, falls back to the intent, and clips long names", () => {
		const fromArgs = toolStep({ toolName: "bash", args: { command: "git status" }, intent: "fallback" });
		expect([fromArgs.name, fromArgs.arg, fromArgs.status, fromArgs.callId]).toEqual([
			"bash",
			"git status",
			"running",
			null,
		]);
		expect(toolStep({ toolName: "todo", args: {}, intent: "Updating the plan" }).arg).toBe("Updating the plan");
		expect(toolStep({ toolName: "recon" }).arg).toBeNull();
		expect(toolStep({ toolName: "x".repeat(60) }).name).toHaveLength(40);
	});
});
