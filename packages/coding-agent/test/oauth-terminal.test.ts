import { expect, test } from "bun:test";
import { formatLoginIdentity } from "@oh-my-pi/pi-coding-agent/cli/oauth-terminal";

test("a project-only OAuth login identifies the account in its success message", () => {
	expect(formatLoginIdentity({ type: "oauth", projectId: "project-1" })).toBe("project-1");
});
