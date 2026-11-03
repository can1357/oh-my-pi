import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	enumeratePythonRuntimes,
	filterEnv,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import * as piUtils from "@oh-my-pi/pi-utils";

describe("Python gateway environment filtering", () => {
	it("preserves caller identity and CLI configuration while removing API keys", () => {
		const env: Record<string, string | undefined> = {
			PATH: "/bin",
			HOME: "/home/test",
			OPENAI_API_KEY: "secret",
			ANTHROPIC_API_KEY: "also-secret",
			AGENT_ID: "test-agent",
			GH_CONFIG_DIR: "/tmp/test-config/gh",
			GIT_CONFIG_GLOBAL: "/tmp/test-config/gitconfig",
			AGENT_CUSTOM: "caller-config",
			EMPTY: "",
			UNDEFINED: undefined,
			PI_CUSTOM: "1",
			LC_ALL: "en_US.UTF-8",
			LD_LIBRARY_PATH: "/opt/conda/lib",
		};

		const filtered = filterEnv(env);

		expect(filtered.PATH).toBe("/bin");
		expect(filtered.HOME).toBe("/home/test");
		expect(filtered.PI_CUSTOM).toBe("1");
		expect(filtered.LC_ALL).toBe("en_US.UTF-8");
		expect(filtered.LD_LIBRARY_PATH).toBe("/opt/conda/lib");
		expect(filtered.OPENAI_API_KEY).toBeUndefined();
		expect(filtered.ANTHROPIC_API_KEY).toBeUndefined();
		expect(filtered.AGENT_ID).toBe("test-agent");
		expect(filtered.GH_CONFIG_DIR).toBe("/tmp/test-config/gh");
		expect(filtered.GIT_CONFIG_GLOBAL).toBe("/tmp/test-config/gitconfig");
		expect(filtered.AGENT_CUSTOM).toBe("caller-config");
		expect(filtered.EMPTY).toBe("");
		expect(Object.hasOwn(filtered, "UNDEFINED")).toBe(false);
		expect(env.OPENAI_API_KEY).toBe("secret");
	});

	it("preserves variables outside the fixed credential denylist, including custom secrets and loader configuration", () => {
		const env = {
			UNSAFE_TOKEN: "caller-value",
			PYTHONHOME: "/custom/python",
			LD_PRELOAD: "/custom/library.so",
			DYLD_INSERT_LIBRARIES: "/custom/library.dylib",
			AWS_REGION: "example-region",
		};
		expect(filterEnv(env)).toEqual(env);
	});

	it("removes every denied credential and password-manager session prefix", () => {
		const env = Object.fromEntries(
			[
				"OPENAI_API_KEY",
				"ANTHROPIC_API_KEY",
				"GOOGLE_API_KEY",
				"GEMINI_API_KEY",
				"OPENROUTER_API_KEY",
				"PERPLEXITY_API_KEY",
				"PERPLEXITY_COOKIES",
				"EXA_API_KEY",
				"AZURE_OPENAI_API_KEY",
				"MISTRAL_API_KEY",
				"GROQ_API_KEY",
				"XAI_API_KEY",
				"DEEPSEEK_API_KEY",
				"GH_TOKEN",
				"GITHUB_TOKEN",
				"GH_ENTERPRISE_TOKEN",
				"GITHUB_ENTERPRISE_TOKEN",
				"AWS_SECRET_ACCESS_KEY",
				"AWS_SESSION_TOKEN",
				"OP_SERVICE_ACCOUNT_TOKEN",
				"OP_CONNECT_TOKEN",
				"OP_SESSION_example",
				"OP_SESSION_other",
			].map(key => [key, "secret"]),
		);

		expect(filterEnv(env)).toEqual({});
	});

	it("normalizes Windows PATH and credential names without renaming caller variables", () => {
		if (process.platform !== "win32") return;

		expect(
			filterEnv({
				Path: "C:\\Windows",
				openai_api_key: "secret",
				gh_token: "secret",
				op_session_example: "secret",
				Agent_Custom: "kept",
			}),
		).toEqual({
			PATH: "C:\\Windows",
			Agent_Custom: "kept",
		});
	});

	it("preserves XDG and LC prefixed variables", () => {
		const env: Record<string, string | undefined> = {
			XDG_CONFIG_HOME: "/home/test/.config",
			XDG_RUNTIME_DIR: "/run/user/1000",
			LC_CTYPE: "UTF-8",
			LC_MESSAGES: "en_US.UTF-8",
		};

		const filtered = filterEnv(env);

		expect(filtered.XDG_CONFIG_HOME).toBe("/home/test/.config");
		expect(filtered.XDG_RUNTIME_DIR).toBe("/run/user/1000");
		expect(filtered.LC_CTYPE).toBe("UTF-8");
		expect(filtered.LC_MESSAGES).toBe("en_US.UTF-8");
	});
});

describe("enumeratePythonRuntimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const managedDir = path.join(path.sep, "fake", ".omp", "python-env");
	const managedBin = path.join(managedDir, process.platform === "win32" ? "Scripts" : "bin");
	const managedPy = path.join(managedBin, process.platform === "win32" ? "python.exe" : "python");
	const systemPy = path.join(path.sep, "usr", "bin", "python3");

	it("enumerates the managed env AND the system interpreter so a broken managed env can fall through", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$whichAll").mockImplementation(bin => (bin === "python" ? [systemPy] : []));
		// Only the managed interpreter physically exists; no project/active venv.
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === managedPy);

		const runtimes = enumeratePythonRuntimes(path.join(path.sep, "work"), {
			PATH: path.join(path.sep, "usr", "bin"),
			PYTHONHOME: path.join(path.sep, "stale", "python"),
		});

		expect(runtimes.map(r => r.pythonPath)).toEqual([managedPy, systemPy]);

		const [managed, system] = runtimes;
		expect(managed.venvPath).toBe(managedDir);
		expect(managed.env.VIRTUAL_ENV).toBe(managedDir);
		expect(managed.env.PATH).toBe(`${managedBin}${path.delimiter}${path.join(path.sep, "usr", "bin")}`);
		expect(Object.hasOwn(managed.env, "PYTHONHOME")).toBe(false);

		// The system candidate must not inherit the managed env's VIRTUAL_ENV/PATH mutation.
		expect(system.venvPath).toBeUndefined();
		expect(system.env.VIRTUAL_ENV).toBeUndefined();
		expect(system.env.PATH).toBe(path.join(path.sep, "usr", "bin"));
		expect(system.env.PYTHONHOME).toBe(path.join(path.sep, "stale", "python"));
	});

	it("falls back to the system interpreter when no managed env or venv exists", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$whichAll").mockImplementation(bin => (bin === "python" ? [systemPy] : []));
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const runtimes = enumeratePythonRuntimes(path.join(path.sep, "work"), {
			PATH: path.join(path.sep, "usr", "bin"),
		});

		expect(runtimes.map(r => r.pythonPath)).toEqual([systemPy]);
		expect(resolvePythonRuntime(path.join(path.sep, "work"), {}).pythonPath).toBe(systemPy);
	});

	it("enumerates every python and python3 on PATH so a broken first shim cannot hide a working interpreter", () => {
		const shimDir = path.join(path.sep, "home", "u", ".local", "share", "mise", "shims");
		const shimPy = path.join(shimDir, "python");
		const shimPy3 = path.join(shimDir, "python3");
		const brewPy3 = path.join(path.sep, "opt", "homebrew", "bin", "python3");
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$whichAll").mockImplementation(bin =>
			bin === "python" ? [shimPy] : bin === "python3" ? [shimPy3, brewPy3, systemPy] : [],
		);
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const runtimes = enumeratePythonRuntimes(path.join(path.sep, "work"), {});

		expect(runtimes.map(r => r.pythonPath)).toEqual([shimPy, shimPy3, brewPy3, systemPy]);
	});

	it("resolves an explicit interpreter without falling through to discovery", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$whichAll").mockImplementation(bin => (bin === "python" ? [systemPy] : []));
		vi.spyOn(fs, "existsSync").mockReturnValue(false);
		const explicitPy = path.join(path.sep, "custom", "python3.13");

		const runtime = resolveExplicitPythonRuntime(explicitPy, path.join(path.sep, "work"), {
			PATH: path.join(path.sep, "usr", "bin"),
		});

		expect(runtime.pythonPath).toBe(explicitPy);
		expect(runtime.venvPath).toBeUndefined();
		expect(runtime.env.PATH).toBe(path.join(path.sep, "usr", "bin"));
	});

	it("sets venv env vars for an explicit interpreter inside a virtualenv", () => {
		const venvDir = path.join(path.sep, "work", ".venv");
		const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
		const explicitPy = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === path.join(venvDir, "pyvenv.cfg"));

		const runtime = resolveExplicitPythonRuntime(explicitPy, path.join(path.sep, "work"), {
			PATH: path.join(path.sep, "usr", "bin"),
			PYTHONHOME: path.join(path.sep, "stale", "python"),
		});

		expect(runtime.venvPath).toBe(venvDir);
		expect(runtime.env.VIRTUAL_ENV).toBe(venvDir);
		expect(runtime.env.PATH).toBe(`${binDir}${path.delimiter}${path.join(path.sep, "usr", "bin")}`);
		expect(Object.hasOwn(runtime.env, "PYTHONHOME")).toBe(false);
	});

	it("clears mixed-case PYTHONHOME when activating a venv on Windows", () => {
		if (process.platform !== "win32") return;
		const venvDir = path.join(path.sep, "work", ".venv");
		const explicitPy = path.join(venvDir, "Scripts", "python.exe");
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === path.join(venvDir, "pyvenv.cfg"));
		const env = { PATH: "C:\\Windows", PythonHome: "C:\\stale\\python", pYtHoNhOmE: "C:\\other\\python" };

		const runtime = resolveExplicitPythonRuntime(explicitPy, path.join(path.sep, "work"), env);

		expect(Object.hasOwn(runtime.env, "PythonHome")).toBe(false);
		expect(Object.hasOwn(runtime.env, "pYtHoNhOmE")).toBe(false);
		expect(env.PythonHome).toBe("C:\\stale\\python");
	});

	it("expands a home-relative explicit interpreter instead of resolving against cwd", () => {
		const home = path.join(path.sep, "home", "tester");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const runtime = resolveExplicitPythonRuntime("~/venvs/py/bin/python", path.join(path.sep, "work"), {});

		expect(runtime.pythonPath).toBe(path.join(home, "venvs", "py", "bin", "python"));
	});

	it("resolves a relative explicit interpreter against cwd", () => {
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const runtime = resolveExplicitPythonRuntime(
			path.join(".venv", "bin", "python"),
			path.join(path.sep, "work"),
			{},
		);

		expect(runtime.pythonPath).toBe(path.join(path.sep, "work", ".venv", "bin", "python"));
	});

	it("throws from resolvePythonRuntime when no interpreter can be found", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$whichAll").mockReturnValue([]);
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		expect(enumeratePythonRuntimes(path.join(path.sep, "work"), {})).toEqual([]);
		expect(() => resolvePythonRuntime(path.join(path.sep, "work"), {})).toThrow("Python executable not found");
	});
});
