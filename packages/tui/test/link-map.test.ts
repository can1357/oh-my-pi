import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	applyLinkMapSetting,
	matchLinkEntry,
	mappedLinkUri,
	parseLinkMap,
	parseLinkTarget,
} from "@oh-my-pi/pi-tui/render/link-map";

let homedir: Mock<typeof os.homedir>;
let userInfo: Mock<typeof os.userInfo>;

beforeEach(() => {
	homedir = spyOn(os, "homedir").mockReturnValue("/home/alice");
	userInfo = spyOn(os, "userInfo").mockReturnValue({ username: "alice" } as os.UserInfo<string>);
});

afterEach(() => {
	applyLinkMapSetting({});
	vi.restoreAllMocks();
});

describe("parseLinkTarget", () => {
	it("reads Windows-style file values as a drive URI ending in /", () => {
		for (const value of [
			"file:\\\\Z:\\data",
			"file://Z:/data",
			"file:\\\\Z:\\data\\",
			"file:///z:/data",
			" file:///Z:/data ",
		]) {
			expect(parseLinkTarget(value)).toBe("file:///Z:/data/");
		}
		expect(parseLinkTarget("file://Q:")).toBe("file:///Q:/");
		expect(parseLinkTarget("file://nas/share")).toBe("file://nas/share/");
	});

	it("accepts any scheme of two or more characters", () => {
		expect(parseLinkTarget("ompfile://devbox/work")).toBe("ompfile://devbox/work/");
		expect(parseLinkTarget("vscode://vscode-remote/ssh-remote+devbox/home/alice/src")).toBe(
			"vscode://vscode-remote/ssh-remote+devbox/home/alice/src/",
		);
		expect(parseLinkTarget("https://git.contoso.example/handbook/blob/main")).toBe(
			"https://git.contoso.example/handbook/blob/main/",
		);
	});

	it("rejects a drive read as a scheme, a bad scheme, a query and a fragment", () => {
		for (const value of ["Z:", "C:/x", "1x://h/", "no scheme", "file:///Z:/?q", "https://h/#x", "https://h/?", 3]) {
			expect(parseLinkTarget(value)).toBeUndefined();
		}
	});
});

describe("parseLinkMap", () => {
	it("projects canonical entries without mutating legacy values", () => {
		userInfo.mockImplementation(() => {
			throw new Error("No passwd entry");
		});
		const raw = {
			"/a/b": " file:///z:/data ",
			"/a//b": "file:///Duplicate:/",
			"/inactive": "",
			"/home/{user}": "https://host/work",
			relative: "file:///Invalid:/",
			"invalid-empty": "",
			"/number": 42,
			"/null": null,
			"/array": [],
			"/object": {},
			"/blank": "   ",
			"/query": "https://host/?q=1",
		};
		const before = structuredClone(raw);
		expect(parseLinkMap(raw, "read")).toEqual({
			"/a/b": "file:///Z:/data/",
			"/inactive": "",
			"/home/{user}": "https://host/work/",
		});
		expect(raw).toEqual(before);
		expect(parseLinkMap({ "/inactive": "" }, "write")).toEqual({ "/inactive": "" });
		expect(parseLinkMap({ "/home/{user}": "file://z:/" }, "write")).toEqual({ "/home/{user}": "file:///Z:/" });
	});

	it("reads malformed maps as empty but rejects them on write", () => {
		for (const raw of [undefined, null, 42, false, "file:///Z:/", []]) {
			expect(parseLinkMap(raw, "read")).toEqual({});
			expect(() => parseLinkMap(raw, "write")).toThrow("tui.linkMap must be an object");
		}
	});

	it("rejects bad keys, targets and normalized duplicates on write", () => {
		for (const raw of [{ relative: "file:///Z:/" }, { relative: "" }])
			expect(() => parseLinkMap(raw, "write")).toThrow("Start with / or ~");
		for (const target of [42, null, [], {}, "   ", "https://host/?q=1", "https://host/#x"])
			expect(() => parseLinkMap({ "/bad": target }, "write")).toThrow("Use a URI with a scheme");
		expect(() => parseLinkMap({ "/a/b": "file:///A:/", "/a//b": "file:///B:/" }, "write")).toThrow(
			"/a/b is already the entry for that prefix.",
		);
	});
});

describe.skipIf(process.platform === "win32")("matching", () => {
	it("appends the rest of the path one encoded segment at a time", () => {
		applyLinkMapSetting({ "/srv/handbook": "https://git.contoso.example/handbook/blob/main" });
		expect(mappedLinkUri("/srv/handbook/A B/#x?.md")).toBe(
			"https://git.contoso.example/handbook/blob/main/A%20B/%23x%3F.md",
		);
		expect(mappedLinkUri("/srv/handbook")).toBe("https://git.contoso.example/handbook/blob/main/");
	});

	it("lets the longest prefix win, whole segments only, case-sensitively", () => {
		applyLinkMapSetting({ "/mnt": "file:///M:/", "/mnt/projects": "file:///Z:/" });
		expect(mappedLinkUri("/mnt/projects/q3/report.csv")).toBe("file:///Z:/q3/report.csv");
		expect(mappedLinkUri("/mnt/projects-old/a")).toBe("file:///M:/projects-old/a");
		expect(mappedLinkUri("/MNT/projects/a")).toBeUndefined();
		expect(mappedLinkUri("/etc/hosts")).toBeUndefined();
	});

	it("covers every absolute path with a / entry, below any longer entry", () => {
		applyLinkMapSetting({ "/": "vscode://vscode-remote/ssh-remote+devbox/", "/mnt/projects": "file:///Z:/" });
		expect(mappedLinkUri("/etc/hosts")).toBe("vscode://vscode-remote/ssh-remote+devbox/etc/hosts");
		expect(mappedLinkUri("/mnt/projects/a")).toBe("file:///Z:/a");
	});

	it("normalises a key once: .. resolves and a trailing slash is dropped", () => {
		applyLinkMapSetting({ "/mnt/projects/../shared/": "file:///S:/" });
		expect(mappedLinkUri("/mnt/shared")).toBe("file:///S:/");
		expect(mappedLinkUri("/mnt/shared/a.md")).toBe("file:///S:/a.md");
		expect(mappedLinkUri("/mnt/projects/a")).toBeUndefined();
	});

	it("ignores a later key for the same prefix with one warning", () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		applyLinkMapSetting({ "/dir": "file:///D:/", "/dir/": "file:///U:/" });
		expect(mappedLinkUri("/dir")).toBe("file:///D:/");
		expect(mappedLinkUri("/dir/a.md")).toBe("file:///D:/a.md");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("Ignoring duplicate tui.linkMap entry", { key: "/dir/", sameAs: "/dir" });
	});

	it("a setting change clears the match cache", () => {
		applyLinkMapSetting({ "/mnt": "file:///M:/" });
		expect(mappedLinkUri("/mnt/a")).toBe("file:///M:/a");
		applyLinkMapSetting({ "/mnt": "file:///N:/" });
		expect(mappedLinkUri("/mnt/a")).toBe("file:///N:/a");
	});

	it("resolves a relative path against the working directory", () => {
		applyLinkMapSetting({ [process.cwd()]: "file:///W:/" });
		expect(mappedLinkUri("src/a.ts")).toBe("file:///W:/src/a.ts");
	});

	it("expands ~ and {user}, and leaves {user} keys unmatched without a passwd entry", () => {
		applyLinkMapSetting({
			"~/notes": "file:///N:/",
			"/nfs/home/{user}": "file:///Y:/",
			"~/work/{user}": "file:///W:/",
		});
		expect(matchLinkEntry("/home/alice/notes/todo.md")).toEqual({ key: "~/notes", uri: "file:///N:/todo.md" });
		expect(mappedLinkUri("/nfs/home/alice/a")).toBe("file:///Y:/a");
		expect(mappedLinkUri("/nfs/home/bob/a")).toBeUndefined();
		expect(mappedLinkUri("/home/alice/work/alice/a")).toBe("file:///W:/a");

		// Two keys for one prefix: links use the first.
		applyLinkMapSetting({ "~/src": "file:///S:/", "/home/alice/src": "file:///T:/" });
		expect(mappedLinkUri("/home/alice/src/a")).toBe("file:///S:/a");
		applyLinkMapSetting({ "/home/alice/src": "file:///T:/", "~/src": "file:///S:/" });
		expect(mappedLinkUri("/home/alice/src/a")).toBe("file:///T:/a");

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		userInfo.mockImplementation(() => {
			throw new Error("no passwd entry");
		});
		applyLinkMapSetting({ "/nfs/home/{user}": "file:///Y:/" });
		expect(mappedLinkUri("/nfs/home/alice/a")).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
		userInfo.mockReturnValue({ username: "" } as os.UserInfo<string>);
		applyLinkMapSetting({ "/nfs/home/{user}": "file:///Y:/", "/nfs/home/alice": "file:///A:/" });
		expect(mappedLinkUri("/nfs/home/alice/a")).toBe("file:///A:/a");
		expect(warn).not.toHaveBeenCalled();
	});

	it("matches ~ through a home directory reached by a symlink", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-map-home-"));
		try {
			const real = path.join(root, "real");
			const link = path.join(root, "link");
			fs.mkdirSync(real);
			fs.symlinkSync(real, link);
			homedir.mockReturnValue(link);
			applyLinkMapSetting({ "~": "file:///Z:/" });
			const realHome = fs.realpathSync(link);
			expect(mappedLinkUri(path.join(link, "a.md"))).toBe("file:///Z:/a.md");
			expect(mappedLinkUri(path.join(realHome, "a.md"))).toBe("file:///Z:/a.md");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a whole home alias without reserving its nonoverlapping physical prefix", () => {
		const real = spyOn(fs, "realpathSync").mockReturnValue("/physical/alice");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		applyLinkMapSetting({
			"/home/alice": "file:///First:/",
			"~": "file:///Ignored:/",
			"/physical/alice": "file:///Physical:/",
		});
		expect(matchLinkEntry("/home/alice/readme.md")).toEqual({
			key: "/home/alice",
			uri: "file:///First:/readme.md",
		});
		expect(matchLinkEntry("/physical/alice/readme.md")).toEqual({
			key: "/physical/alice",
			uri: "file:///Physical:/readme.md",
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("Ignoring duplicate tui.linkMap entry", {
			key: "~",
			sameAs: "/home/alice",
		});
		real.mockRestore();
	});

	it("ignores invalid entries and keeps the valid ones", () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		applyLinkMapSetting({
			"/mnt/projects": "file:///Z:/",
			"/a": "1x://host/x/",
			"/b": "https://host/x/?q=1",
			"/c": "Z:",
			"/d": 3,
			relative: "file:///Q:/",
			"/e": "",
			"/a/": "file:///Valid:/",
			"/f": "   ",
			"also-relative": "",
		});
		for (const p of ["/b/x", "/c/x", "/d/x", "/e/x", "/f/x", path.resolve("relative/x")]) {
			expect(mappedLinkUri(p)).toBeUndefined();
		}
		expect(mappedLinkUri("/mnt/projects/a")).toBe("file:///Z:/a");
		expect(mappedLinkUri("/a/x")).toBe("file:///Valid:/x");
		expect(warn).toHaveBeenCalledTimes(6);
		for (const bad of [undefined, null, "file:///Z:/", ["file:///Z:/"]]) {
			applyLinkMapSetting(bad);
			expect(mappedLinkUri("/mnt/projects/a")).toBeUndefined();
		}
	});
});
