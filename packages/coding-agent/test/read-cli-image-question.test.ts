/**
 * `omp read <image>?q=<question>` delegates to a vision model, which requires a
 * model registry to resolve modelRoles.vision / @default and fetch credentials.
 * The read CLI built a lightweight session with no registry, so the read tool
 * aborted with "Model registry is unavailable for image questions." before any
 * resolution (issue #11338). This drives the real `omp read` command in an
 * isolated agent dir carrying a custom vision provider and asserts it reaches
 * the completion attempt instead of the registry guard.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// 1x1 PNG so the read tool's image loader accepts the file.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Custom vision provider with a real (dummy) inline key so it counts as
// available; its baseUrl points at a dead local port, so the completion attempt
// fails fast with a connection error — never the registry guard, and never a
// real network call.
const MODELS_YML = `providers:
  testvision:
    api: openai-completions
    baseUrl: http://127.0.0.1:1/v1
    apiKey: "test-key"
    models:
      - id: vmodel
        name: Vision Test
        input:
          - text
          - image
        contextWindow: 128000
        maxTokens: 4096
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`;

const RUNNER = `import { runReadCommand } from "../src/cli/read-cli";
await runReadCommand({ path: process.argv[2] });
`;

describe("omp read <image>?q=", () => {
	it("resolves a vision model instead of failing with the registry guard", async () => {
		const tempDir = TempDir.createSync("@pi-read-cli-imgq-");
		try {
			const agentDir = tempDir.join("agent");
			const home = tempDir.join("home");
			const project = tempDir.join("project");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(home, { recursive: true });
			fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
			// Bound the completion attempt so a dead endpoint aborts quickly instead
			// of running the provider SDK's full connection backoff.
			fs.writeFileSync(path.join(project, ".omp", "config.yml"), "images:\n  questionTimeoutMs: 3000\n");
			fs.writeFileSync(path.join(agentDir, "models.yml"), MODELS_YML);
			const pngPath = path.join(project, "test.png");
			fs.writeFileSync(pngPath, Buffer.from(PNG_1X1, "base64"));

			// The runner lives inside the package so its imports resolve against the
			// repo node_modules; cwd is the isolated project so getProjectDir() never
			// picks up repo settings.
			const runnerPath = path.join(import.meta.dir, `.read-cli-runner-${process.pid}.ts`);
			fs.writeFileSync(runnerPath, RUNNER);
			try {
				const child = Bun.spawn(["bun", runnerPath, `${pngPath}?q=describe this image`], {
					cwd: project,
					env: {
						...process.env,
						HOME: home,
						PI_CODING_AGENT_DIR: agentDir,
						PI_TEST_RUNTIME: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				const output = `${stdout}\n${stderr}`;
				// The command fails (dead endpoint) but must get past the registry
				// guard AND model resolution to an actual completion attempt.
				expect(exitCode).not.toBe(0);
				expect(output).not.toContain("Model registry is unavailable for image questions.");
				expect(output).not.toContain("No models available for image questions.");
			} finally {
				fs.rmSync(runnerPath, { force: true });
			}
		} finally {
			tempDir.removeSync();
		}
	}, 60_000);
});
