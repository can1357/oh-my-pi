import { describe, expect, it } from "bun:test";
import {
	humanizePlanTitle,
	normalizePlanTitle,
	planFileUrlForSlug,
	resolveApprovedPlan,
	resolvePlanTitle,
} from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { normalizeLocalScheme } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

describe("planFileUrlForSlug", () => {
	it("maps a slug to its local plan URL", () => {
		expect(planFileUrlForSlug("auth-refactor")).toBe("local://auth-refactor-plan.md");
	});
});

describe("resolveApprovedPlan", () => {
	/** A `readPlan` backed by an in-memory map of `local://` URL → content. */
	function reader(files: Record<string, string>) {
		return async (url: string) => (url in files ? files[url] : null);
	}

	it("locates the plan from the supplied title's slug — no rename", async () => {
		const result = await resolveApprovedPlan({
			suppliedTitle: "auth-refactor",
			statePlanFilePath: "local://PLAN.md",
			readPlan: reader({ "local://auth-refactor-plan.md": "# Auth refactor\n\nbody" }),
		});
		expect(result.planFilePath).toBe("local://auth-refactor-plan.md");
		expect(result.planContent).toContain("body");
		expect(result.title).toBe("auth-refactor");
	});

	it("strips a trailing -plan from the supplied title before reconstructing the file", async () => {
		const result = await resolveApprovedPlan({
			suppliedTitle: "auth-plan",
			statePlanFilePath: "local://PLAN.md",
			readPlan: reader({ "local://auth-plan.md": "# Auth\n\nbody" }),
		});
		expect(result.planFilePath).toBe("local://auth-plan.md");
	});

	it("falls back to the plan-mode state path when the slug file is absent", async () => {
		const result = await resolveApprovedPlan({
			suppliedTitle: "mismatch",
			statePlanFilePath: "local://existing-plan.md",
			readPlan: reader({ "local://existing-plan.md": "# Existing\n\nbody" }),
		});
		expect(result.planFilePath).toBe("local://existing-plan.md");
	});

	it("prefers the newest listed plan over a completed state plan", async () => {
		const result = await resolveApprovedPlan({
			suppliedTitle: "Different title",
			statePlanFilePath: "local://completed-plan.md",
			readPlan: reader({
				"local://completed-plan.md": "# Completed\n\nOld plan",
				"local://new-draft-plan.md": "# New\n\nNew plan",
			}),
			listPlanFiles: async () => ["local://new-draft-plan.md", "local://completed-plan.md"],
		});
		expect(result.planFilePath).toBe("local://new-draft-plan.md");
		expect(result.planContent).toContain("New plan");
	});

	it("treats a single-slash state URL as in-scan and prefers the newer draft", async () => {
		// Mirror the real reader: canonicalize the local scheme before lookup, so a
		// `local:/…` state path resolves the same file as the scanner's `local://…`.
		const canonical = (files: Record<string, string>) => {
			const map: Record<string, string> = {};
			for (const url in files) map[normalizeLocalScheme(url)] = files[url];
			return async (url: string) => map[normalizeLocalScheme(url)] ?? null;
		};
		const result = await resolveApprovedPlan({
			suppliedTitle: undefined,
			// Resumed sessions can persist the accepted single-slash spelling.
			statePlanFilePath: "local:/completed-plan.md",
			readPlan: canonical({
				"local://completed-plan.md": "# Completed\n\nOld plan",
				"local://new-draft-plan.md": "# New\n\nNew plan",
			}),
			listPlanFiles: async () => ["local://new-draft-plan.md", "local://completed-plan.md"],
		});
		expect(result.planFilePath).toBe("local://new-draft-plan.md");
		expect(result.planContent).toContain("New plan");
	});

	it("keeps a state plan the scan can't see ahead of older scanned artifacts", async () => {
		const result = await resolveApprovedPlan({
			suppliedTitle: undefined,
			// A cwd-relative / non-`plan.md` state path never appears in listPlanFiles().
			statePlanFilePath: "docs/CURRENT.md",
			readPlan: reader({
				"docs/CURRENT.md": "# Current\n\nCurrent plan",
				"local://old-artifact-plan.md": "# Old\n\nOld plan",
			}),
			listPlanFiles: async () => ["local://old-artifact-plan.md"],
		});
		expect(result.planFilePath).toBe("docs/CURRENT.md");
		expect(result.planContent).toContain("Current plan");
	});

	it("scans listed plan files when the title was dropped and state path is empty", async () => {
		const result = await resolveApprovedPlan({
			suppliedTitle: undefined,
			statePlanFilePath: "local://PLAN.md",
			readPlan: reader({ "local://discovered-plan.md": "# Discovered\n\nbody" }),
			listPlanFiles: async () => ["local://discovered-plan.md"],
		});
		expect(result.planFilePath).toBe("local://discovered-plan.md");
	});

	it("throws an actionable error when no plan file exists", async () => {
		await expect(
			resolveApprovedPlan({
				suppliedTitle: "ghost",
				statePlanFilePath: "local://PLAN.md",
				readPlan: reader({}),
			}),
		).rejects.toThrow("Plan file not found at local://ghost-plan.md");
	});
});

describe("humanizePlanTitle", () => {
	it("replaces separators with spaces and capitalizes", () => {
		expect(humanizePlanTitle("migrate-mcp-loader")).toBe("Migrate mcp loader");
		expect(humanizePlanTitle("fix_session_naming")).toBe("Fix session naming");
		expect(humanizePlanTitle("RefactorRouter")).toBe("RefactorRouter");
	});

	it("collapses runs of separators", () => {
		expect(humanizePlanTitle("foo--bar__baz")).toBe("Foo bar baz");
	});

	it("returns empty string for blank-ish input", () => {
		expect(humanizePlanTitle("")).toBe("");
		expect(humanizePlanTitle("---")).toBe("");
	});
});

describe("normalizePlanTitle", () => {
	it("accepts a clean identifier as-is", () => {
		expect(normalizePlanTitle("my-plan")).toEqual({ title: "my-plan", fileName: "my-plan.md" });
		expect(normalizePlanTitle("feature_branch")).toEqual({ title: "feature_branch", fileName: "feature_branch.md" });
	});

	it("strips a trailing .md suffix provided by the model", () => {
		expect(normalizePlanTitle("my-plan.md")).toEqual({ title: "my-plan", fileName: "my-plan.md" });
	});

	it("converts spaces to hyphens (natural-language titles)", () => {
		expect(normalizePlanTitle("My Improvement Plan")).toEqual({
			title: "My-Improvement-Plan",
			fileName: "My-Improvement-Plan.md",
		});
	});

	it("collapses consecutive spaces / resulting hyphens", () => {
		expect(normalizePlanTitle("foo  bar")).toEqual({ title: "foo-bar", fileName: "foo-bar.md" });
	});

	it("drops characters outside the allowed set after space replacement", () => {
		expect(normalizePlanTitle("plan: v1.0 (draft)")).toEqual({
			title: "plan-v10-draft",
			fileName: "plan-v10-draft.md",
		});
	});

	it("trims leading/trailing hyphens that result from sanitization", () => {
		expect(normalizePlanTitle("!!! plan !!!")).toEqual({ title: "plan", fileName: "plan.md" });
	});

	it("throws for empty title", () => {
		expect(() => normalizePlanTitle("")).toThrow("Plan title is required");
		expect(() => normalizePlanTitle("   ")).toThrow("Plan title is required");
	});

	it("throws for path separators", () => {
		expect(() => normalizePlanTitle("../etc/passwd")).toThrow("path separators");
		expect(() => normalizePlanTitle("a/b")).toThrow("path separators");
	});

	it("throws when sanitization produces empty result", () => {
		expect(() => normalizePlanTitle("!!!")).toThrow("at least one letter");
	});
});

describe("resolvePlanTitle", () => {
	const planContent = "# Code Review: nettools — Updated Issues\n\nbody...\n";
	const planFilePath = "local://PLAN.md";

	it("uses a string `suppliedTitle` when present", () => {
		const result = resolvePlanTitle({ suppliedTitle: "my-plan", planContent, planFilePath });
		expect(result).toEqual({ title: "my-plan", fileName: "my-plan.md", source: "supplied" });
	});

	it("falls back to the plan's first H1 when the model emits a non-string title (issue #1179)", () => {
		const result = resolvePlanTitle({ suppliedTitle: {}, planContent, planFilePath });
		// "Code Review: nettools — Updated Issues" → sanitized
		expect(result.source).toBe("heading");
		expect(result.title).toBe("Code-Review-nettools-Updated-Issues");
		expect(result.fileName).toBe("Code-Review-nettools-Updated-Issues.md");
	});

	it("falls back to the H1 when `suppliedTitle` is missing entirely", () => {
		const result = resolvePlanTitle({ planContent, planFilePath });
		expect(result.source).toBe("heading");
	});

	it("falls back to the H1 when `suppliedTitle` is an empty / whitespace string", () => {
		expect(resolvePlanTitle({ suppliedTitle: "", planContent, planFilePath }).source).toBe("heading");
		expect(resolvePlanTitle({ suppliedTitle: "   ", planContent, planFilePath }).source).toBe("heading");
	});

	it("falls back to the plan filename stem when no usable H1 exists", () => {
		const result = resolvePlanTitle({ planContent: "body only, no heading\n", planFilePath });
		expect(result).toEqual({ title: "PLAN", fileName: "PLAN.md", source: "filename" });
	});

	it("falls back through to the literal `plan` when every candidate sanitizes to empty", () => {
		const result = resolvePlanTitle({
			suppliedTitle: "!!!",
			planContent: "# !!!\n",
			planFilePath: "local://!!!.md",
		});
		expect(result).toEqual({ title: "plan", fileName: "plan.md", source: "default" });
	});

	it("skips a `suppliedTitle` that contains path separators and uses the next candidate", () => {
		const result = resolvePlanTitle({
			suppliedTitle: "../etc/passwd",
			planContent,
			planFilePath,
		});
		expect(result.source).toBe("heading");
	});

	it("picks the first H1 line, not the first heading of any level", () => {
		const result = resolvePlanTitle({
			planContent: "## Subheading first\n\n# Real Title\n",
			planFilePath,
		});
		expect(result.title).toBe("Real-Title");
	});
});
