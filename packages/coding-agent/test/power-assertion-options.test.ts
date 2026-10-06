import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import {
	powerAssertionOptions,
	resetPowerBackendUnavailableLogForTests,
	startPowerAssertion,
} from "../src/session/agent-session";

describe("powerAssertionOptions", () => {
	it("asks for no assertion when sleep prevention is off", () => {
		expect(powerAssertionOptions("off")).toBeUndefined();
	});

	it("selects cumulative flags per mode", () => {
		expect(powerAssertionOptions("idle")).toMatchObject({ idle: true, display: false, system: false, user: false });
		expect(powerAssertionOptions("display")).toMatchObject({ idle: true, display: true, system: false, user: false });
		expect(powerAssertionOptions("system")).toMatchObject({ idle: true, display: true, system: true, user: true });
	});
});

describe("startPowerAssertion", () => {
	const options = powerAssertionOptions("idle")!;
	const unavailable = () => {
		throw new Error(
			"Unable to connect to the system bus: Failed to connect to address unix:path=/var/run/dbus/system_bus_socket: No such file or directory",
		);
	};

	afterEach(() => {
		vi.restoreAllMocks();
		resetPowerBackendUnavailableLogForTests();
	});

	it("does not warn when the system bus is unavailable, and logs debug at most once", () => {
		resetPowerBackendUnavailableLogForTests();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		expect(startPowerAssertion(options, unavailable)).toBeUndefined();
		expect(startPowerAssertion(options, unavailable)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(0);
		expect(debug).toHaveBeenCalledTimes(1);
	});

	it("still warns on other failures", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const failing = () => {
			throw new Error("login1 Inhibit failed: access denied");
		};
		expect(startPowerAssertion(options, failing)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(debug).toHaveBeenCalledTimes(0);
	});
});
