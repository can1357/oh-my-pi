import { afterEach, describe, expect, test } from "bun:test";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	}
	return captured;
}

describe("auth-broker login --via dry-run", () => {
	afterEach(() => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	});

	test("Z.AI paste-code OAuth SSHs without a loopback tunnel", async () => {
		const output = await captureStdout(() =>
			runAuthBrokerCommand({
				action: "login",
				flags: { provider: "zai-coding-plan", via: "user@broker", dryRun: true },
			}),
		);
		expect(output).toBe("ssh user@broker 'omp auth-broker login zai-coding-plan'\n");
		expect(output).not.toContain("-L");
		expect(output).not.toContain("ExitOnForwardFailure");
	});

	test("loopback OAuth retains SSH port forwarding", async () => {
		const output = await captureStdout(() =>
			runAuthBrokerCommand({
				action: "login",
				flags: { provider: "anthropic", via: "user@broker", dryRun: true },
			}),
		);
		expect(output).toBe(
			"ssh -L 54545:127.0.0.1:54545 -o ExitOnForwardFailure=yes user@broker 'omp auth-broker login anthropic'\n",
		);
	});

	test("device-code OAuth without a callback port is refused", async () => {
		await expect(
			runAuthBrokerCommand({
				action: "login",
				flags: { provider: "github-copilot", via: "user@broker", dryRun: true },
			}),
		).rejects.toThrow(
			"No known OAuth callback port for 'github-copilot'. Use device-code flow on the broker host directly.",
		);
	});
});
