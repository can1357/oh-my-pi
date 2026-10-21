import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleGitLab } from "@oh-my-pi/pi-coding-agent/web/scrapers/gitlab";
import { asGlobalFetch } from "../../helpers/fetch-mock.js";

const MR = {
	title: "Add frobnication",
	description: "<p>This MR <strong>frobnicates</strong> the widget.</p>",
	state: "opened",
	author: { name: "Ada", username: "ada" },
	created_at: "2026-10-01T10:00:00Z",
	updated_at: "2026-10-02T10:00:00Z",
	source_branch: "feat/frob",
	target_branch: "main",
	labels: [],
	upvotes: 1,
	downvotes: 0,
	user_notes_count: 2,
	draft: false,
	merge_status: "can_be_merged",
};

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GitLab merge request reads", () => {
	it("renders the description instead of [object Promise]", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.includes("/merge_requests/1")) return json(MR);
				if (url.includes("/api/v4/projects/")) return json({ id: 42 });
				return new Response("not found", { status: 404 });
			}),
		);

		const result = await handleGitLab("https://gitlab.com/group/project/-/merge_requests/1", 20);
		expect(result?.content).toContain("This MR **frobnicates** the widget.");
		expect(result?.content).not.toContain("[object Promise]");
	});
});
