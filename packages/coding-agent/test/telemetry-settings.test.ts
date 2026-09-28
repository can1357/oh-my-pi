import { describe, expect, it } from "bun:test";
import { validateTelemetryOtlpHeaders } from "@oh-my-pi/pi-coding-agent/telemetry-settings";

describe("telemetry.otlpHeaders validation", () => {
	it("accepts a record of string values", () => {
		expect(() => validateTelemetryOtlpHeaders({ authorization: "!minter", "x-tenant": "acme" })).not.toThrow();
		expect(() => validateTelemetryOtlpHeaders({})).not.toThrow();
	});

	it("rejects a non-string value by name, so one typo cannot drop every other header at export time", () => {
		expect(() => validateTelemetryOtlpHeaders({ authorization: "Bearer live", "x-extra": 17 })).toThrow(/x-extra/);
		expect(() => validateTelemetryOtlpHeaders({ authorization: null })).toThrow(/authorization/);
	});

	it("rejects non-object shapes", () => {
		expect(() => validateTelemetryOtlpHeaders(["authorization"])).toThrow();
		expect(() => validateTelemetryOtlpHeaders("authorization: x")).toThrow();
	});
});
