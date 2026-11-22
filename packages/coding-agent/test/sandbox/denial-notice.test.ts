import { describe, expect, it } from "bun:test";
import { renderSandboxDenialNotice } from "@oh-my-pi/pi-coding-agent/sandbox/denial-notice";
import type { SandboxResultMeta } from "@oh-my-pi/pi-coding-agent/sandbox/types";

const META = { backend: "seatbelt", mode: "workspace-write", network: "deny" } as const;
const withRequest = { isToolActive: (name: string) => name === "sandbox_request" };
const withoutRequest = { isToolActive: () => false };

describe("renderSandboxDenialNotice", () => {
	it("is undefined without a denial, start failure or refused host", () => {
		expect(renderSandboxDenialNotice(undefined, withRequest, true)).toBeUndefined();
		expect(renderSandboxDenialNotice(META, withRequest, true)).toBeUndefined();
	});

	it("names hosts refused by time only for a failed call", () => {
		const meta = { ...META, blockedHosts: ["a.test"] };
		expect(renderSandboxDenialNotice(meta, withRequest, false)).toBeUndefined();
		expect(renderSandboxDenialNotice(meta, withRequest, true)).toContain("a.test");
		// A denial still renders for a call that did not fail, without the host.
		expect(renderSandboxDenialNotice({ ...meta, denied: true }, withRequest, false)).not.toContain("a.test");
	});

	it("names hosts refused to the call's own requests whether or not it failed, each once", () => {
		const meta = { ...META, blockedHosts: ["own.test", "time.test"], ownBlockedHosts: ["own.test"] };
		const succeeded = renderSandboxDenialNotice(meta, withRequest, false);
		expect(succeeded).toContain("own.test");
		expect(succeeded).not.toContain("time.test");
		// A host both owned and in the time window is named as often as a host named once.
		const failed = renderSandboxDenialNotice(meta, withRequest, true) ?? "";
		const once =
			renderSandboxDenialNotice({ ...META, blockedHosts: ["own.test", "time.test"] }, withRequest, true) ?? "";
		expect(failed.split("own.test").length).toBe(once.split("own.test").length);
		expect(failed).toContain("time.test");
	});

	it("mentions `sandbox_request` exactly when that tool is active", () => {
		const denied = { ...META, denied: true, blockedHosts: ["a.test"] };
		expect(renderSandboxDenialNotice(denied, withRequest, true)).toContain("sandbox_request");
		expect(renderSandboxDenialNotice(denied, withoutRequest, true)).not.toContain("sandbox_request");
		expect(renderSandboxDenialNotice(denied, {}, true)).not.toContain("sandbox_request");
	});

	it("renders for a start failure alone", () => {
		expect(renderSandboxDenialNotice({ ...META, startFailed: true }, withRequest, true)).toBeDefined();
	});

	it("renders a network-off failure without suggesting a request", () => {
		const notice = renderSandboxDenialNotice({ ...META, networkOff: true }, withRequest, true);
		expect(notice).toContain("sandbox.network.mode");
		expect(notice).not.toContain("sandbox_request");
	});

	it("offers `sandbox_request` only for refused hosts a request can allow, never for IP literals or local names", () => {
		const mixed: SandboxResultMeta = {
			...META,
			network: "allowlist",
			blockedHosts: ["a.test", "127.0.0.1", "dev.localhost", "::1"],
		};
		const notice = renderSandboxDenialNotice(mixed, withRequest, true) ?? "";
		expect(notice).toContain("a.test");
		for (const host of ["127.0.0.1", "dev.localhost", "::1"]) expect(notice).toContain(host);
		expect(notice.split("sandbox_request").length).toBe(2);
		// Only host-local hosts: no request is suggested at all, even with the tool active.
		const local = renderSandboxDenialNotice(
			{ ...mixed, blockedHosts: ["[::1]", "169.254.169.254"] },
			withRequest,
			true,
		);
		expect(local).not.toContain("sandbox_request");
		for (const host of ["[::1]", "169.254.169.254"]) expect(local).toContain(host);
		const untooled = renderSandboxDenialNotice(mixed, withoutRequest, true) ?? "";
		expect(untooled).toContain("a.test");
		expect(untooled).not.toContain("sandbox_request");
		// The local-host sentence (the only one naming the config key) lists the local hosts, never a.test.
		expect(notice).toContain("sandbox.network.allowedHosts");
		const localPart = notice.slice(notice.indexOf("For "), notice.indexOf("sandbox.network.allowedHosts"));
		for (const host of ["127.0.0.1", "dev.localhost", "::1"]) expect(localPart).toContain(host);
		expect(localPart).not.toContain("a.test");
		expect(local).toContain("sandbox.network.allowedHosts");
		const requestable = renderSandboxDenialNotice({ ...mixed, blockedHosts: ["a.test"] }, withRequest, true);
		expect(requestable).toContain("a.test");
		expect(requestable).not.toContain("sandbox.network.allowedHosts");
	});

	it("in read-only mode offers `sandbox_request` only for reads, never for writes", () => {
		const notice = renderSandboxDenialNotice({ ...META, mode: "read-only", denied: true }, withRequest, true);
		expect(notice).toContain("read-only");
		expect(notice).toContain("`sandbox_request` (kind read)");
		// Every mention of the tool is the read one.
		expect(notice?.split("sandbox_request").length).toBe(2);
		expect(notice).toContain("`denyRead` paths cannot be requested");
	});

	it("in workspace-write mode names readable roots, denyRead and protected workspace paths", () => {
		const notice = renderSandboxDenialNotice({ ...META, denied: true }, withRequest, true);
		expect(notice).toContain("outside the readable or writable roots");
		expect(notice).toContain("`denyRead` paths cannot be requested");
		expect(notice).toContain(".git/config");
		expect(notice?.split("sandbox_request").length).toBe(2);
	});
});
