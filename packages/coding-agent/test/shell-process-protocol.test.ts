/**
 * What a shell process and the session that started it exchange: the worker's
 * command line and the frames carrying its URL filesystem requests.
 */
import { describe, expect, it } from "bun:test";
import { ShellFsFileType, ShellFsOp } from "@oh-my-pi/pi-natives";
import {
	decodeShellUrlFrame,
	encodeShellUrlFrame,
	parseShellProcessArgs,
	shellProcessArgs,
} from "../src/exec/shell-process-protocol";

describe("shell process arguments", () => {
	it("round-trip a spec whose command looks like the worker's own flags", () => {
		const spec = {
			command: "--urls a b; echo '--' --source x",
			urls: { endpoint: "/run/shell/urls-1.sock", token: "t0ken" },
			source: "/tmp/seed with space.sh",
			cwd: "local://work dir",
		};

		expect(parseShellProcessArgs(shellProcessArgs(spec))).toEqual(spec);
		expect(parseShellProcessArgs(shellProcessArgs({ command: "" }))).toEqual({ command: "" });
		expect(shellProcessArgs(spec).at(-1)).toBe(spec.command);
	});

	it("reject a command line that is not a spec", () => {
		expect(parseShellProcessArgs([])).toBeUndefined();
		expect(parseShellProcessArgs(["echo", "hi"])).toBeUndefined();
		expect(parseShellProcessArgs(["--urls", "endpoint", "--", "echo hi"])).toBeUndefined();
		expect(parseShellProcessArgs(["--", "echo", "hi"])).toBeUndefined();
	});
});

describe("shell URL frames", () => {
	it("carry byte arrays and 64-bit offsets through one line of text", () => {
		const bytes = Buffer.from([0, 255, 10, 13, 34, 92]);
		const request = { id: 7, request: { op: ShellFsOp.Write, handle: 3, offset: 2n ** 40n + 1n, data: bytes } };
		const response = {
			id: 7,
			response: {
				data: new Uint8Array(bytes),
				metadata: { fileType: ShellFsFileType.File, size: 6, mode: 0o444, mtimeNs: 1_700_000_000_123_456_789n },
			},
		};

		const [requestLine, responseLine] = [encodeShellUrlFrame(request), encodeShellUrlFrame(response)];

		expect(requestLine).not.toContain("\n");
		expect(decodeShellUrlFrame(requestLine)).toEqual({
			id: 7,
			request: { ...request.request, data: new Uint8Array(bytes) },
		});
		expect(decodeShellUrlFrame(responseLine)).toEqual(response);
	});
});
