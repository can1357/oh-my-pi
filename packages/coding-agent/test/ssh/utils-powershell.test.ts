import { describe, expect, it } from "bun:test";
import { buildPowerShellCommand, quotePowerShellLiteral } from "../../src/ssh/utils";

describe("buildPowerShellCommand", () => {
	it("renders PS 5.1-safe invocation flags and round-trips the script via UTF-16LE base64", () => {
		const cmd = buildPowerShellCommand("powershell", "Write-Output 'hi'");
		expect(cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand ")).toBe(true);
		const b64 = cmd.split(" ").at(-1) ?? "";
		expect(Buffer.from(b64, "base64").toString("utf16le")).toBe("Write-Output 'hi'");
	});

	it("preserves non-ASCII and metacharacters byte-exact through the encoding", () => {
		const script = "Write-Output '中文 $x `n'";
		const b64 = buildPowerShellCommand("pwsh", script).split(" ").at(-1) ?? "";
		expect(Buffer.from(b64, "base64").toString("utf16le")).toBe(script);
	});
});

describe("quotePowerShellLiteral", () => {
	it("wraps in single quotes and doubles embedded single quotes", () => {
		expect(quotePowerShellLiteral("a'b")).toBe("'a''b'");
		expect(quotePowerShellLiteral("no quotes")).toBe("'no quotes'");
		expect(quotePowerShellLiteral("")).toBe("''");
	});
});
