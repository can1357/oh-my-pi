import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withLooseKey<T>(run: (keyPath: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-key-"));
	const keyPath = path.join(dir, "id_ed25519");
	await Bun.write(keyPath, "dummy-key");
	await fs.chmod(keyPath, 0o666);
	try {
		return await run(keyPath);
	} finally {
		await removeWithRetries(dir);
	}
}

describe("buildRemoteCommand", () => {
	it("includes -n and OpenSSH ControlMaster options on Unix-like platforms", async () => {
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
			{ platform: "linux" },
		);

		expect(args[0]).toBe("-n");
		expect(args).toContain("ControlMaster=auto");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("omits OpenSSH ControlMaster options on Windows", async () => {
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
			{ platform: "win32" },
		);

		expect(args[0]).toBe("-n");
		expect(args).not.toContain("ControlMaster=auto");
		expect(args.some(arg => arg.startsWith("ControlPath="))).toBe(false);
		expect(args).not.toContain("ControlPersist=3600");
		expect(args).toContain("BatchMode=yes");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("skips Unix mode-bit key validation for Windows args", async () => {
		await withLooseKey(async keyPath => {
			const args = await connectionManager.buildRemoteCommand(
				{
					name: "host",
					host: "192.168.3.146",
					keyPath,
				},
				"ls -la",
				{ platform: "win32" },
			);

			expect(args).toContain("-i");
			expect(args).toContain(keyPath);
			expect(args.at(-2)).toBe("192.168.3.146");
			expect(args.at(-1)).toBe("ls -la");
		});
	});

	it("still rejects missing identity files on Windows args", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-key-"));
		const keyPath = path.join(dir, "missing_id_ed25519");
		try {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
					{ platform: "win32" },
				),
			).rejects.toThrow("SSH key not found");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("still rejects directory identity paths on Windows args", async () => {
		const keyPath = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-key-"));
		try {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
					{ platform: "win32" },
				),
			).rejects.toThrow("SSH key is not a file");
		} finally {
			await removeWithRetries(keyPath);
		}
	});

	it("rejects group/world-readable identity files on Unix-like platforms", async () => {
		await withLooseKey(async keyPath => {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
					{ platform: "linux" },
				),
			).rejects.toThrow("SSH key permissions must be 600 or stricter");
		});
	});
});

describe("supportsSshControlMaster", () => {
	it("disables OpenSSH connection multiplexing on native Windows", () => {
		expect(connectionManager.supportsSshControlMaster("win32")).toBe(false);
	});

	it("keeps OpenSSH connection multiplexing on Unix-like platforms", () => {
		expect(connectionManager.supportsSshControlMaster("linux")).toBe(true);
		expect(connectionManager.supportsSshControlMaster("darwin")).toBe(true);
	});
});
