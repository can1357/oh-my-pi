import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { resolveCodingAgentLocale } from "../src/i18n";
import { launchHelp } from "../src/commands/launch-help";

describe("coding-agent language selection", () => {
	it("parses explicit locale preferences", () => {
		expect(parseArgs(["--language", "zh-CN"]).language).toBe("zh-CN");
		expect(parseArgs(["--language=auto"]).language).toBe("auto");
	});

	it("rejects unsupported explicit locales", () => {
		expect(() => parseArgs(["--language", "fr-FR"])).toThrow();
	});

	it("resolves explicit settings before environment preferences", () => {
		expect(resolveCodingAgentLocale({ language: "en", configured: "zh-CN", environment: ["zh-CN"] })).toBe("en");
		expect(resolveCodingAgentLocale({ language: "auto", configured: "auto", environment: ["zh-CN"] })).toBe("zh-CN");
		expect(resolveCodingAgentLocale({ language: "auto", configured: "auto", environment: ["fr-FR"] })).toBe("en");
	});

	it("exposes translation keys for the launch help shell", () => {
		expect(launchHelp.descriptionKey).toBe("codingAgent.ui.appDescription");
		expect(launchHelp.flags?.language?.descriptionKey).toBe("codingAgent.help.language");
	});
});
