import { type as arkType } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_TOOLS, ComputerTool, createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

declare global {
	var __computerSchemaConstructionCount: number;
}

const count = () => globalThis.__computerSchemaConstructionCount;
const toolSession = (settings: Settings): ToolSession =>
	({
		cwd: ".",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	}) as ToolSession;

const counts = {
	afterModuleImport: count(),
	afterDefaultOffFactory: -1,
	afterToolConstruction: -1,
	afterFirstParametersAccess: -1,
	afterRepeatedParametersAccess: -1,
	afterSecondToolParametersAccess: -1,
	afterValidation: -1,
};

const disabledTools = await createTools(toolSession(Settings.isolated()), ["computer"]);
counts.afterDefaultOffFactory = count();

const firstTool = await BUILTIN_TOOLS.computer(toolSession(Settings.isolated()));
const secondTool = await BUILTIN_TOOLS.computer(toolSession(Settings.isolated()));
if (!(firstTool instanceof ComputerTool) || !(secondTool instanceof ComputerTool)) {
	throw new Error("Expected the built-in computer factory to construct ComputerTool instances");
}
counts.afterToolConstruction = count();

const firstSchema = firstTool.parameters;
counts.afterFirstParametersAccess = count();
const repeatedSchema = firstTool.parameters;
counts.afterRepeatedParametersAccess = count();
const secondToolSchema = secondTool.parameters;
counts.afterSecondToolParametersAccess = count();

const validInput = {
	code: "const windows = await desktop.windows(); windows.length",
	read_only: true,
	timeout: 10,
};
const validOutput = firstSchema(validInput);
const invalidOutputs = [
	firstSchema({}),
	firstSchema({ code: 1 }),
	firstSchema({ code: "1", read_only: "yes" }),
	firstSchema({ code: "1", timeout: "fast" }),
	firstSchema({ code: "1", action: "screenshot" }),
	firstSchema({ code: "1", unexpected: true }),
];
counts.afterValidation = count();

await Promise.all([firstTool.close(), secondTool.close()]);

process.stdout.write(
	JSON.stringify({
		counts,
		disabledToolCount: disabledTools.length,
		schema: {
			callable: typeof firstSchema === "function",
			repeatedIdentity: firstSchema === repeatedSchema,
			crossToolIdentity: firstSchema === secondToolSchema,
			validAccepted: !(validOutput instanceof arkType.errors),
			validOutput,
			invalidRejected: invalidOutputs.map(output => output instanceof arkType.errors),
		},
	}),
);
