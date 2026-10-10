import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, createConnection } from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Subprocess } from "bun";
import { ReadonlySandbox } from "../src/task/readonly-sandbox";

let scope: string;
let outside: string;
let active: boolean;
let sandbox: ReadonlySandbox;
let authorizeObserved: () => void;
beforeEach(() => {
	scope = mkdtempSync(path.join(tmpdir(), "readonly-scope-"));
	outside = mkdtempSync(path.join(tmpdir(), "readonly-outside-"));
	writeFileSync(path.join(scope, "rows"), "one\ntwo\nthree\n");
	mkdirSync(path.join(scope, ".git"));
	writeFileSync(path.join(scope, ".git", "lease-fixture"), "fixture-authority-material");
	writeFileSync(path.join(outside, "private"), "outside fixture");
	symlinkSync(path.join(outside, "private"), path.join(scope, "escape"));
	active = true;
	authorizeObserved = () => {};
	sandbox = new ReadonlySandbox(
		{
			parentSessionId: "parent-fixture",
			scopeRoot: scope,
			authorize: async binding => {
				authorizeObserved();
				return (
					active &&
					binding.parentSessionId === "parent-fixture" &&
					binding.childSessionId === "actual-child-fixture" &&
					binding.scopeRoot === scope
				);
			},
		},
		"actual-child-fixture",
		scope,
	);
});
afterEach(async () => {
	await sandbox.dispose();
	rmSync(scope, { recursive: true });
	rmSync(outside, { recursive: true });
});

test("shell computes from scope, but cannot write or follow an outside symlink", async () => {
	expect((await sandbox.bash("wc -l rows")).text).toContain("3 rows");
	expect((await sandbox.bash("printf changed > rows")).error).toBe(true);
	expect(readFileSync(path.join(scope, "rows"), "utf8")).toBe("one\ntwo\nthree\n");
	expect((await sandbox.bash("cat escape")).error).toBe(true);
	expect((await sandbox.bash("cat /etc/hostname")).error).toBe(true);
	expect((await sandbox.bash("cat .git/lease-fixture")).error).toBe(true);
});

test("Python supports computation and top-level await within a fresh guest", async () => {
	expect(
		(await sandbox.eval("py", "import asyncio\ntotal = 41\nawait asyncio.sleep(0)\nprint(total + 1)")).text,
	).toContain("42");
	expect((await sandbox.eval("py", "from pathlib import Path\nPath('rows').write_text('changed')")).error).toBe(true);
	expect(readFileSync(path.join(scope, "rows"), "utf8")).toBe("one\ntwo\nthree\n");
});

test("JavaScript supports top-level await and denies the host tool bridge", async () => {
	expect((await sandbox.eval("js", "var total = 41; await Promise.resolve(); display(total + 1)")).text).toContain(
		"42",
	);
	expect((await sandbox.eval("js", "await Bun.write('rows', 'changed')")).error).toBe(true);
	expect((await sandbox.eval("js", "await tool.bash({command: 'touch rows'})")).error).toBe(true);
	expect(readFileSync(path.join(scope, "rows"), "utf8")).toBe("one\ntwo\nthree\n");
}, 30_000);

test("no parent authority means no process admission", async () => {
	active = false;
	await expect(sandbox.bash("wc -l rows")).rejects.toThrow("READONLY_PARENT_AUTHORITY_LOST");
	await expect(sandbox.eval("py", "print('unauthorized')")).rejects.toThrow("READONLY_PARENT_AUTHORITY_LOST");
});

test("revocation kills the actual running namespace and its observed descendants", async () => {
	const spawned = spyOn(Bun, "spawn");
	const alive = (pid: number): boolean => {
		try {
			return readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1]?.[0] !== "Z";
		} catch {
			return false;
		}
	};
	const descendants = (pid: number): number[] => {
		try {
			const children = readFileSync("/proc/" + pid + "/task/" + pid + "/children", "utf8")
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map(Number);
			return children.flatMap(child => [child, ...descendants(child)]);
		} catch {
			return [];
		}
	};
	try {
		const running = sandbox.bash("sleep 20; printf changed > rows", 30);
		const outcome = running.then(
			() => null,
			error => error as Error,
		);
		const until = Date.now() + 2000;
		let observed: number[] = [];
		while (Date.now() < until) {
			const proc = spawned.mock.results[0]?.value as Subprocess | undefined;
			if (proc) observed = descendants(proc.pid);
			if (observed.length >= 2) break;
			await Bun.sleep(10);
		}
		expect(observed.length).toBeGreaterThanOrEqual(2);
		expect(observed.every(alive)).toBe(true);
		active = false;
		// Let the real periodic authority monitor revoke the running namespace.
		expect((await outcome)?.message).toBe("READONLY_PARENT_AUTHORITY_LOST");
		expect(observed.some(alive)).toBe(false);
		expect(readFileSync(path.join(scope, "rows"), "utf8")).toBe("one\ntwo\nthree\n");
	} finally {
		spawned.mockRestore();
	}
}, 5_000);

test("ambient host variables and a reachable host TCP listener are unavailable", async () => {
	process.env.OMP_READONLY_TEST_SENTINEL = "fixture-value";
	let received = 0;
	const server = createServer(socket => {
		socket.on("data", () => received++);
		socket.on("end", () => socket.end());
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	try {
		const control = createConnection({ port, host: "127.0.0.1" });
		await once(control, "connect");
		control.end("fixture");
		await once(control, "close");
		expect(received).toBe(1);
		expect((await sandbox.bash('test -z "$OMP_READONLY_TEST_SENTINEL"')).error).toBe(false);
		expect(
			(
				await sandbox.eval(
					"py",
					"import socket\ns = socket.create_connection(('127.0.0.1', " +
						port +
						"), timeout=0.2)\ns.sendall(b'fixture')\ns.close()",
				)
			).error,
		).toBe(true);
		expect(received).toBe(1);
	} finally {
		delete process.env.OMP_READONLY_TEST_SENTINEL;
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test("unterminated guest protocol output is bounded before a newline arrives", async () => {
	await expect(
		sandbox.eval("py", "import sys\nsys.__stdout__.write('x' * (2 * 1024 * 1024))\nsys.__stdout__.flush()", 3),
	).rejects.toThrow("READONLY_OUTPUT_LIMIT");
}, 5_000);

test("already canceled tools cannot execute or create a guest kernel", async () => {
	const abort = new AbortController();
	abort.abort();
	await expect(sandbox.bash("wc -l rows", 60, abort.signal)).rejects.toThrow("READONLY_CELL_ABORTED");
	await expect(sandbox.eval("py", "print('ran')", 60, abort.signal)).rejects.toThrow("READONLY_CELL_ABORTED");
});

test("a pathname Unix socket in readonly scope cannot act as a host side-effect bridge", async () => {
	const socketPath = path.join(scope, "fixture.sock");
	let received = 0;
	const server = createServer(socket => {
		socket.on("data", () => {
			received++;
		});
		socket.on("end", () => socket.end());
	});
	server.listen(socketPath);
	await once(server, "listening");
	try {
		const control = createConnection(socketPath);
		await once(control, "connect");
		control.end("fixture-side-effect");
		await once(control, "close");
		expect(received).toBe(1);
		const result = await sandbox.eval(
			"py",
			"import socket\ns = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\ns.connect('fixture.sock')\ns.sendall(b'fixture-side-effect')\ns.close()",
		);
		expect(result.error).toBe(true);
		expect(received).toBe(1);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

for (const mode of ["deadline", "abort"] as const) {
	test(`forged completion cannot remove a kernel's trusted ${mode} guard`, async () => {
		const spawned = spyOn(Bun, "spawn");
		const abort = new AbortController();
		try {
			const running = sandbox.eval(
				"py",
				"import os, json, time\nrid = __omp_current_run_id__()\nfd = display.__globals__['_FRAME_FD']\nos.write(fd, (json.dumps({'type': 'done', 'id': rid, 'status': 'ok'}) + '\\n').encode())\nwhile True: time.sleep(0.05)",
				mode === "deadline" ? 0.3 : 5,
				abort.signal,
			);
			const outcome = running.then(
				() => null,
				error => error as Error,
			);
			while (!spawned.mock.results[0]) await Bun.sleep(1);
			const proc = spawned.mock.results[0].value as Subprocess;
			if (mode === "abort") abort.abort();
			expect((await outcome)?.message).toBe("READONLY_CELL_ABORTED");
			await proc.exited;
			expect(proc.signalCode).toBe("SIGKILL");
		} finally {
			spawned.mockRestore();
		}
	}, 2_000);
}

for (const previousGuard of ["deadline", "abort"] as const) {
	test(
		"a completed cell's " + previousGuard + " cannot kill the next cell",
		async () => {
			const previous = new AbortController();
			expect((await sandbox.eval("py", "print('first')", 0.3, previous.signal)).text).toContain("first");
			const next = sandbox.eval("py", "import time\ntime.sleep(0.4)\nprint('next')", 3);
			if (previousGuard === "abort") previous.abort();
			const result = await next;
			expect(result.error).toBe(false);
			expect(result.text).toContain("next");
		},
		3_000,
	);
}

test("multibyte guest output is bounded by bytes, not character count", async () => {
	await expect(sandbox.eval("py", "print('界' * 400000)", 3)).rejects.toThrow("READONLY_OUTPUT_LIMIT");
});
