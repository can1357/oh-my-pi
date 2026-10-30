import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("model and UI language boundary", () => {
	it("keeps model results identical across languages without sharing locale state between processes", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "model-language-boundary-"));
		// Separate processes also catch translated static constants initialized on first import.
		const script = `
import {initializeI18n} from "@oh-my-pi/pi-utils/i18n";
import {formatAge} from "@oh-my-pi/pi-utils";
await initializeI18n();
const {Settings} = await import("@oh-my-pi/pi-coding-agent/config/settings");
await Settings.init({inMemory:true});
const {WriteTool} = await import("@oh-my-pi/pi-coding-agent/tools/write");
const {parseTailCount} = await import("@oh-my-pi/pi-coding-agent/tools/path-utils");
const {enforcePlanModeWrite} = await import("@oh-my-pi/pi-coding-agent/tools/plan-mode-guard");
const {ToolAbortError} = await import("@oh-my-pi/pi-coding-agent/tools/tool-errors");
const {denyError} = await import("@oh-my-pi/pi-coding-agent/tools/approval");
const {formatSessionSnapshot} = await import("@oh-my-pi/pi-tui/tools/debug");
const {CfgProtocolHandler} = await import("@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol");
const {parseInternalUrl} = await import("@oh-my-pi/pi-coding-agent/internal-urls/parse");
const fs = await import("node:fs/promises");
const path = await import("node:path");
const cwd = ${JSON.stringify(cwd)};
async function message(action) {
	try { await action(); } catch(error) { return error.message; }
	throw new Error("Expected tool rejection");
}
const session = {
	cwd,hasUI:false,getSessionFile:()=>path.join(cwd,"session.jsonl"),getSessionSpawns:()=>"*",
	getArtifactsDir:()=>path.join(cwd,"artifacts"),
	allocateOutputArtifact:async()=>({id:"artifact-1",path:path.join(cwd,"artifact-1.log")}),
	settings:Settings.isolated(),enableLsp:false
};
const file = path.join(cwd,"build.bat");
await fs.writeFile(file,"@echo off\\r\\necho old\\r\\n");
const tool = new WriteTool(session);
const result = await tool.execute("boundary",{path:file,content:"@echo off\\necho new\\n"});
const cfg = await new CfgProtocolHandler().resolve(parseInternalUrl("cfg://tools/artifactSpillThreshold"),{session});
console.log(JSON.stringify({
	model:{
		text:result.content.filter(block=>block.type==="text").map(block=>block.text).join("\\n"),
		file:await fs.readFile(file,"utf8"),cfg:cfg.content,
		ages:[1,60,3600,86400,604800,2592000].map(seconds=>formatAge(seconds,"en")),
		tail:await message(()=>parseTailCount("-0")),
		plan:await message(()=>enforcePlanModeWrite({...session,getPlanModeState:()=>({enabled:true,planFilePath:"local://boundary-plan.md"})},"build.bat",{op:"update"})),
		abort:new ToolAbortError().message,
		denied:denyError({tier:"write",policy:"deny",source:"tool",override:false,reason:"blocked"},"write").message,
		debug:formatSessionSnapshot({id:"debug-1",adapter:"node",status:"stopped",cwd,program:"app.js",needsConfigurationDone:false})
	}
}));`;
		try {
			const outputs = [];
			for (const language of ["ko", "en"]) {
				const child = Bun.spawnSync([process.execPath, "-e", script], {
					env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: undefined, PI_COMPILED: undefined },
					timeout: 30_000,
				});
				expect(child.exitCode, child.stderr.toString()).toBe(0);
				outputs.push(JSON.parse(child.stdout.toString()));
			}
			expect(outputs[0].model).toEqual(outputs[1].model);
			expect(outputs[0].model.file).toBe("@echo off\r\necho new\r\n");
			expect(outputs[0].model.cfg).not.toMatch(/[가-힣]/u);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
