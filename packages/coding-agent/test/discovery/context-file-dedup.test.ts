import { describe, expect, test } from "bun:test";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";

function makeContextFile(overrides: Partial<ContextFile> & Pick<ContextFile, "path" | "level">): ContextFile {
	return {
		content: `content of ${overrides.path}`,
		depth: undefined,
		_source: { provider: "test", providerName: "Test", path: overrides.path, level: overrides.level },
		...overrides,
	};
}

describe("contextFileCapability.key", () => {
	const key = contextFileCapability.key.bind(contextFileCapability);

	test("user-level files share the same key regardless of depth", () => {
		const a = makeContextFile({ path: "/home/user/.omp/agent/AGENTS.md", level: "user" });
		const b = makeContextFile({ path: "/home/user/.claude/CLAUDE.md", level: "user" });
		expect(key(a)).toBe("user");
		expect(key(b)).toBe("user");
		expect(key(a)).toBe(key(b));
	});

	test("project-level files at the same depth share the same key", () => {
		const a = makeContextFile({ path: "/repo/AGENTS.md", level: "project", depth: 0 });
		const b = makeContextFile({ path: "/repo/.claude/CLAUDE.md", level: "project", depth: 0 });
		expect(key(a)).toBe(key(b));
	});

	test("project-level files at different depths have different keys", () => {
		const atCwd = makeContextFile({ path: "/repo/packages/app/AGENTS.md", level: "project", depth: 0 });
		const atParent = makeContextFile({ path: "/repo/packages/AGENTS.md", level: "project", depth: 1 });
		const atRoot = makeContextFile({ path: "/repo/AGENTS.md", level: "project", depth: 2 });

		expect(key(atCwd)).not.toBe(key(atParent));
		expect(key(atParent)).not.toBe(key(atRoot));
		expect(key(atCwd)).not.toBe(key(atRoot));
	});

	test("project-level file with no depth uses 0 as default", () => {
		const withDepth = makeContextFile({ path: "/repo/AGENTS.md", level: "project", depth: 0 });
		const noDepth = makeContextFile({ path: "/repo/AGENTS.md", level: "project" });
		expect(key(withDepth)).toBe(key(noDepth));
	});

	test("user key never collides with any project key", () => {
		const user = makeContextFile({ path: "/home/user/.omp/AGENTS.md", level: "user" });
		for (let depth = 0; depth < 20; depth++) {
			const project = makeContextFile({ path: `/repo/AGENTS.md`, level: "project", depth });
			expect(key(user)).not.toBe(key(project));
		}
	});
});

describe("contextFileCapability.validate", () => {
	test("accepts valid context file", () => {
		const file = makeContextFile({ path: "/repo/AGENTS.md", level: "project", depth: 0 });
		expect(contextFileCapability.validate!(file)).toBeUndefined();
	});

	test("rejects missing path", () => {
		const file = makeContextFile({ path: "", level: "project" });
		expect(contextFileCapability.validate!(file)).toBe("Missing path");
	});
});
