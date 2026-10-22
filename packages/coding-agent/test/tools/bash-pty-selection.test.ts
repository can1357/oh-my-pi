import { afterEach, describe, expect, it } from "bun:test";
import { bashNeedsAuthTerminal, canUseInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-pty-selection";

const originalPlatform = process.platform;
const originalNoPty = Bun.env.PI_NO_PTY;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
		writable: true,
	});
}

function restorePlatform(): void {
	Object.defineProperty(process, "platform", {
		value: originalPlatform,
		configurable: true,
		writable: true,
	});
}

function setNoPty(value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env.PI_NO_PTY;
		return;
	}
	Bun.env.PI_NO_PTY = value;
}

function interactiveContext() {
	return { hasUI: true, ui: {} };
}

describe("bash PTY selection", () => {
	afterEach(() => {
		restorePlatform();
		setNoPty(originalNoPty);
	});

	it("allows interactive PTY on Windows when requested with UI", () => {
		setPlatform("win32");
		setNoPty(undefined);

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
	});

	it("allows interactive PTY on non-Windows when requested with UI and not disabled", () => {
		setPlatform("linux");
		setNoPty(undefined);

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
		expect(canUseInteractiveBashPty(false, interactiveContext())).toBe(false);
		expect(canUseInteractiveBashPty(true, undefined)).toBe(false);

		setNoPty("1");
		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(false);
	});
});

describe("bash terminal auth detection", () => {
	it("detects the password-reading commands at any command position", () => {
		expect(bashNeedsAuthTerminal("doas true")).toBe(true);
		expect(bashNeedsAuthTerminal("sudo systemctl restart nginx")).toBe(true);
		expect(bashNeedsAuthTerminal("/usr/bin/doas pacman -Syu")).toBe(true);
		expect(bashNeedsAuthTerminal("PATH=/usr/bin doas true")).toBe(true);
		expect(bashNeedsAuthTerminal("echo hi && doas dinitctl restart x")).toBe(true);
		expect(bashNeedsAuthTerminal("cat foo | doas tee /etc/hosts")).toBe(true);
		expect(bashNeedsAuthTerminal("doas -u root true")).toBe(true);
		expect(bashNeedsAuthTerminal("sudoedit /etc/hosts")).toBe(true);
		expect(bashNeedsAuthTerminal("/usr/bin/sudoedit /etc/hosts")).toBe(true);
	});

	it("looks through the shell prefixes that wrap a command", () => {
		expect(bashNeedsAuthTerminal("! sudo true")).toBe(true);
		expect(bashNeedsAuthTerminal("time sudo true")).toBe(true);
		expect(bashNeedsAuthTerminal("time -p sudo true")).toBe(true);
		expect(bashNeedsAuthTerminal("command sudo true")).toBe(true);
		expect(bashNeedsAuthTerminal("exec sudo true")).toBe(true);
		expect(bashNeedsAuthTerminal("nohup doas true")).toBe(true);
		expect(bashNeedsAuthTerminal("env -u FOO doas true")).toBe(true);
		// `--` ends the wrapper's own options; the marker is not the command.
		expect(bashNeedsAuthTerminal("env -- sudo true")).toBe(true);
		expect(bashNeedsAuthTerminal("time -- sudo true")).toBe(true);
		expect(bashNeedsAuthTerminal("env -i -- sudo true")).toBe(true);
		expect(bashNeedsAuthTerminal("time echo sudo")).toBe(false);
	});

	it("does not treat a `command` lookup as running the command", () => {
		expect(bashNeedsAuthTerminal("command -v sudo")).toBe(false);
		expect(bashNeedsAuthTerminal("command -V sudo")).toBe(false);
		expect(bashNeedsAuthTerminal("command -pv sudo")).toBe(false);
		expect(bashNeedsAuthTerminal("command -p sudo true")).toBe(true);
	});

	it("ignores the command name outside a command position", () => {
		expect(bashNeedsAuthTerminal("echo doas")).toBe(false);
		expect(bashNeedsAuthTerminal("rg -n 'doas|sudo' src")).toBe(false);
		expect(bashNeedsAuthTerminal("true")).toBe(false);
		expect(bashNeedsAuthTerminal("/etc/hosts/sudo.list cat")).toBe(false);
	});

	it("ignores a call that already says it will not prompt", () => {
		expect(bashNeedsAuthTerminal("sudo -n true")).toBe(false);
		expect(bashNeedsAuthTerminal("doas --non-interactive true")).toBe(false);
		expect(bashNeedsAuthTerminal("doas -n ls")).toBe(false);
		// Only the auth command's own options count: a `-n` in the wrapped
		// command's arguments says nothing about how the password is read.
		expect(bashNeedsAuthTerminal("doas printf -- -n")).toBe(true);
	});

	it("reads the auth command's option values before deciding it may prompt", () => {
		// `-u` takes `root`, so the `-n` is an option, not the command.
		expect(bashNeedsAuthTerminal("sudo -u root -n id")).toBe(false);
		expect(bashNeedsAuthTerminal("sudo --user root --non-interactive id")).toBe(false);
		expect(bashNeedsAuthTerminal("sudo --user=root --non-interactive id")).toBe(false);
		// `-p` takes the prompt text, which may itself look like shell syntax.
		expect(bashNeedsAuthTerminal("sudo -p Password: -S id")).toBe(false);
		// `doas -C` parses and checks a configuration file, then exits.
		expect(bashNeedsAuthTerminal("doas -C /etc/doas.conf true")).toBe(false);
		expect(bashNeedsAuthTerminal("doas -C /etc/doas.conf")).toBe(false);
		expect(bashNeedsAuthTerminal("doas -u root -C /etc/doas.conf true")).toBe(false);
		// `-C` is close-from for `sudo`, which takes a value and keeps going.
		expect(bashNeedsAuthTerminal("sudo -C 3 id")).toBe(true);
	});

	it("reads grouped short options as their individual flags", () => {
		expect(bashNeedsAuthTerminal("sudo -Sn id")).toBe(false);
		expect(bashNeedsAuthTerminal("sudo -nE id")).toBe(false);
		expect(bashNeedsAuthTerminal("sudo -En id")).toBe(false);
		expect(bashNeedsAuthTerminal("sudo -uroot -n id")).toBe(false);
		// A flag that takes no value keeps the scan going to the `-n` after it.
		expect(bashNeedsAuthTerminal("sudo -E -n id")).toBe(false);
		expect(bashNeedsAuthTerminal("sudo -ESh id")).toBe(false);
	});
});
