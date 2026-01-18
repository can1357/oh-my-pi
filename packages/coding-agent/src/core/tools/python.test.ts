import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as pythonExecutor from "../python-executor";
import { createTools, type ToolSession } from "./index";
import { createPythonTool } from "./python";

let previousSkipCheck: string | undefined;

beforeAll(() => {
	previousSkipCheck = process.env.OMP_PYTHON_SKIP_CHECK;
	process.env.OMP_PYTHON_SKIP_CHECK = "1";
});

afterAll(() => {
	if (previousSkipCheck === undefined) {
		delete process.env.OMP_PYTHON_SKIP_CHECK;
		return;
	}
	process.env.OMP_PYTHON_SKIP_CHECK = previousSkipCheck;
});

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...overrides,
	};
}

function createSettings(toolMode: "ipy-only" | "bash-only" | "both") {
	return {
		getImageAutoResize: () => true,
		getLspFormatOnWrite: () => true,
		getLspDiagnosticsOnWrite: () => true,
		getLspDiagnosticsOnEdit: () => false,
		getEditFuzzyMatch: () => true,
		getGitToolEnabled: () => true,
		getBashInterceptorEnabled: () => true,
		getBashInterceptorSimpleLsEnabled: () => true,
		getBashInterceptorRules: () => [],
		getPythonToolMode: () => toolMode,
		getPythonKernelMode: () => "session" as const,
	};
}

describe("python tool schema", () => {
	it("exposes expected parameters", () => {
		const tool = createPythonTool(createSession());
		const schema = tool.parameters as {
			type: string;
			properties: Record<string, { type: string; description?: string }>;
			required?: string[];
		};

		expect(schema.type).toBe("object");
		expect(schema.properties.code.type).toBe("string");
		expect(schema.properties.timeout.type).toBe("number");
		expect(schema.properties.workdir.type).toBe("string");
		expect(schema.properties.reset.type).toBe("boolean");
		expect(schema.required).toEqual(["code"]);
	});
});

describe("python tool docs template", () => {
	it("renders dynamic helper docs", () => {
		const docs = [
			{
				name: "read",
				signature: "(path)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const spy = vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue(docs);

		const tool = createPythonTool(createSession());

		expect(tool.description).toContain("### File I/O");
		expect(tool.description).toContain("- `read(path)` — Read file contents.");

		spy.mockRestore();
	});

	it("renders fallback when docs are unavailable", () => {
		const spy = vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue([]);

		const tool = createPythonTool(createSession());

		expect(tool.description).toContain("Documentation unavailable — Python kernel failed to start");

		spy.mockRestore();
	});
});

describe("python tool exposure", () => {
	it("includes python only in ipy-only mode", async () => {
		const session = createSession({ settings: createSettings("ipy-only") });
		const tools = await createTools(session);
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("python");
		expect(names).not.toContain("bash");
	});

	it("includes bash only in bash-only mode", async () => {
		const session = createSession({ settings: createSettings("bash-only") });
		const tools = await createTools(session);
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("bash");
		expect(names).not.toContain("python");
	});

	it("includes bash and python in both mode", async () => {
		const session = createSession({ settings: createSettings("both") });
		const tools = await createTools(session);
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("bash");
		expect(names).toContain("python");
	});
});
