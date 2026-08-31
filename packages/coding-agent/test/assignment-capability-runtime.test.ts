import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AssignmentCapabilityRuntime,
	callAssignmentGateway,
} from "@oh-my-pi/pi-coding-agent/assignment-capability/runtime";
import { ASSIGNMENT_CAPABILITY_SCHEMA } from "@oh-my-pi/pi-coding-agent/assignment-capability/types";

interface GatewayFixture {
	readonly argv: readonly string[];
	readonly attempts: string;
	readonly root: string;
}

async function gatewayFixture(first: "denial" | "malformed" | "retryable" | "timeout"): Promise<GatewayFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-assignment-gateway-"));
	const script = path.join(root, "gateway.ts");
	const attempts = path.join(root, "attempts");
	await Bun.write(
		script,
		`const attempts = Bun.argv[2];
const input = JSON.parse(await Bun.stdin.text());
let count = 0;
try { count = Number(await Bun.file(attempts).text()); } catch {}
await Bun.write(attempts, String(count + 1));
if (count === 0 && ${JSON.stringify(first)} === "timeout") {
	// This integration fixture must exercise a real child-process timeout;
	// fake timers cannot advance the spawned process's independent clock.
	await Bun.sleep(1_700);
}
if (count === 0 && ${JSON.stringify(first)} === "malformed") {
	process.stdout.write("{");
	process.exit(0);
}
if (count === 0) {
	const retryable = ${JSON.stringify(first)} === "retryable";
	process.stdout.write(JSON.stringify({ schema: ${JSON.stringify(ASSIGNMENT_CAPABILITY_SCHEMA)}, requestId: input.requestId, ok: false, operation: input.operation, error: { code: retryable ? "RECONCILE" : "EXPLICIT_DENIAL", message: "denied", retryable } }));
	process.exit(0);
}
process.stdout.write(JSON.stringify({ schema: ${JSON.stringify(ASSIGNMENT_CAPABILITY_SCHEMA)}, requestId: input.requestId, ok: true, operation: input.operation, result: { disposition: "reconciled" } }));
`,
	);
	return { argv: [process.execPath, script, attempts], attempts, root };
}

const request = {
	schema: ASSIGNMENT_CAPABILITY_SCHEMA,
	requestId: "gateway-request-1",
	operation: "attempt.execute",
};

describe("Assignment capability digest", () => {
	it("matches Go stable JSON for HTML-sensitive and Unicode-key arguments", async () => {
		const runtime = Object.create(AssignmentCapabilityRuntime.prototype) as AssignmentCapabilityRuntime;
		const value = { z: "<>&\u2028", "\uE000": 1, "😀": 2, omitted: undefined };
		const canonical = `{"z":"<>&\\u2028","":1,"😀":2}`;
		const expected = `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`;

		await expect(runtime.digest(value)).resolves.toBe(expected);
	});
});

describe("Assignment capability gateway retry", () => {
	it("does not replay an explicit gateway denial", async () => {
		const fixture = await gatewayFixture("denial");
		try {
			await expect(callAssignmentGateway(fixture.argv, request, Date.now() + 10_000)).rejects.toThrow(
				"EXPLICIT_DENIAL",
			);
			expect(await Bun.file(fixture.attempts).text()).toBe("1");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("replays the exact request once after an ambiguous response", async () => {
		const fixture = await gatewayFixture("malformed");
		try {
			await expect(callAssignmentGateway(fixture.argv, request, Date.now() + 10_000)).resolves.toEqual({
				disposition: "reconciled",
			});
			expect(await Bun.file(fixture.attempts).text()).toBe("2");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("reserves deadline budget to reconcile after a gateway timeout", async () => {
		const fixture = await gatewayFixture("timeout");
		try {
			await expect(callAssignmentGateway(fixture.argv, request, Date.now() + 2_000)).resolves.toEqual({
				disposition: "reconciled",
			});
			expect(await Bun.file(fixture.attempts).text()).toBe("2");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("retries one retryable semantic completion response under the same identity", async () => {
		const fixture = await gatewayFixture("retryable");
		const completionRequest = { ...request, operation: "assignment.complete" };
		try {
			await expect(callAssignmentGateway(fixture.argv, completionRequest, Date.now() + 10_000)).resolves.toEqual({
				disposition: "reconciled",
			});
			expect(await Bun.file(fixture.attempts).text()).toBe("2");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
});
