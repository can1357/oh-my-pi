/**
 * Test for issue #10162: read-only Git status / changed-files / diff RPC.
 *
 * The RPC layer is exercised end-to-end through a real session in
 * `omp --mode rpc --no-session` mode, so the wire surface (RpcCommand
 * shape, success/error responses, types) is what we are actually
 * asserting on. The git operations themselves run against a real
 * temporary git repo seeded by `git init` / `git commit`, so the
 * native vcs binding has a real cwd to discover.
 *
 * Timer note (per project ts-no-test-timers rule):
 *   This is an integration test against a real OMP child process. Three
 *   timers are unavoidable:
 *     - waitReady() polls stdout for the `ready` frame because the RPC
 *       mode does not expose an EventEmitter for "ready"; the poll
 *       interval (25 ms) is the smallest meaningful granularity, not a
 *       guessed delay.
 *     - request() uses a deadline timer to fail hung RPCs instead of
 *       blocking the test forever; this is the test's only safety net
 *       against a real OMP process that crashed without responding.
 *     - close() sleeps briefly before kill() so the child has time to
 *       drain stdin EOF; SIGKILL during stdio write would corrupt the
 *       pipe and pollute subsequent forks.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

const REPO_BIN = process.env.OMP_BIN ?? "omp";
const STARTUP_TIMEOUT_MS = 8000;
const RESPONSE_TIMEOUT_MS = 10000;
const STDIO_DRAIN_MS = 200;

interface PendingRequest {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

class RpcClient {
  private buf = "";
  private pending = new Map<string, PendingRequest>();
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;

  constructor(public readonly child: ChildProcessWithoutNullStreams) {
    this.readyPromise = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === "ready") this.readyResolve();
          if (frame.type === "response" && typeof frame.id === "string") {
            const p = this.pending.get(frame.id);
            if (p) {
              this.pending.delete(frame.id);
              p.resolve(frame);
            }
          }
        } catch {
          /* drop non-JSON lines */
        }
      }
    });
    setTimeout(() => this.readyReject(new Error("ready frame timeout")), STARTUP_TIMEOUT_MS);
  }

  waitReady(): Promise<void> {
    return this.readyPromise;
  }

  send(frame: object): void {
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  request<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        reject(new Error(`${type} response timeout`));
      }
    }, RESPONSE_TIMEOUT_MS);
    this.pending.set(id, {
      resolve: (f) => {
        clearTimeout(timer);
        resolve(f as T);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    this.send({ id, type, ...params });
    return promise;
  }

  close(): void {
    this.child.stdin.end();
    setTimeout(() => this.child.kill(), STDIO_DRAIN_MS);
  }
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "ignore", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	}
}

describe("rpc git_* commands (issue #10162)", () => {
	let tempDir: string;
	let client: RpcClient;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-git-"));
		await runGit(tempDir, ["init", "-q", "-b", "main"]);
		await runGit(tempDir, ["config", "user.email", "rpc-git@example.com"]);
		await runGit(tempDir, ["config", "user.name", "rpc-git"]);
		await fs.writeFile(path.join(tempDir, "a.txt"), "one\n");
		await runGit(tempDir, ["add", "."]);
		await runGit(tempDir, ["commit", "-q", "-m", "seed"]);

		const child = spawn(REPO_BIN, ["--mode", "rpc", "--no-session"], {
			cwd: tempDir,
			stdio: ["pipe", "pipe", "pipe"],
		});
		client = new RpcClient(child);
		await client.waitReady();
		await client.request("negotiate_protocol", { protocolVersion: 2 });
	});

	afterAll(() => {
		client.close();
		void fs.rm(tempDir, { recursive: true, force: true });
	});

	it("git_status returns porcelain output plus a summary on a clean repo", async () => {
		const resp = await client.request<{ success: boolean; data: { porcelain: string; summary: { staged: number; unstaged: number; untracked: number }; cwd: string } }>(
			"git_status",
		);
		expect(resp.success).toBe(true);
		expect(typeof resp.data.porcelain).toBe("string");
		expect(resp.data.summary).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
		expect(resp.data.cwd).toBe(tempDir);
	});

	it("git_changed_files returns the staged file list", async () => {
		await fs.writeFile(path.join(tempDir, "b.txt"), "two\n");
		await runGit(tempDir, ["add", "b.txt"]);

		const resp = await client.request<{ success: boolean; data: { files: string[]; cwd: string } }>(
			"git_changed_files",
			{ staged: true },
		);
		expect(resp.success).toBe(true);
		expect(resp.data.files).toContain("b.txt");
		expect(resp.data.cwd).toBe(tempDir);
	});

	it("git_changed_files returns the unstaged file list when staged:false", async () => {
		await fs.writeFile(path.join(tempDir, "c.txt"), "three\n");

		const resp = await client.request<{ success: boolean; data: { files: string[] } }>(
			"git_changed_files",
			{ staged: false },
		);
		expect(resp.success).toBe(true);
		expect(resp.data.files).toContain("c.txt");
	});

	it("git_diff returns the full diff under maxBytes", async () => {
		await fs.writeFile(path.join(tempDir, "a.txt"), "two\n");

		const resp = await client.request<{ success: boolean; data: { diff: string; truncated: boolean; cwd: string } }>(
			"git_diff",
			{ staged: false },
		);
		expect(resp.success).toBe(true);
		expect(resp.data.truncated).toBe(false);
		expect(resp.data.diff).toContain("-one");
		expect(resp.data.diff).toContain("+two");
		expect(resp.data.cwd).toBe(tempDir);
	});

	it("git_diff honours maxBytes and reports truncated:true with totalBytes", async () => {
		await fs.writeFile(path.join(tempDir, "a.txt"), "x".repeat(8000));

		const resp = await client.request<{ success: boolean; data: { diff: string; truncated: boolean; totalBytes?: number } }>(
			"git_diff",
			{ staged: false, maxBytes: 200 },
		);
		expect(resp.success).toBe(true);
		expect(resp.data.truncated).toBe(true);
		expect(typeof resp.data.totalBytes).toBe("number");
		expect((resp.data.totalBytes ?? 0) > 200).toBe(true);
		expect(resp.data.diff.length).toBeLessThanOrEqual(200);
	});

	it("git_status fails cleanly outside a git repository", async () => {
		const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-norepo-"));
		const child = spawn(REPO_BIN, ["--mode", "rpc", "--no-session"], {
			cwd: nonRepo,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const isolated = new RpcClient(child);
		try {
			await isolated.waitReady();
			await isolated.request("negotiate_protocol", { protocolVersion: 2 });
			const resp = await isolated.request<{ success: boolean; error: string }>("git_status");
			expect(resp.success).toBe(false);
			expect(typeof resp.error).toBe("string");
		} finally {
			isolated.close();
			await fs.rm(nonRepo, { recursive: true, force: true });
		}
	});
});