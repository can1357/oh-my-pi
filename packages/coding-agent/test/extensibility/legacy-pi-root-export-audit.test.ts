import { describe, expect, it } from "bun:test";
import * as legacy from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

// Runtime root exports from @earendil-works/pi-coding-agent@0.84.4 (the
// current upstream; pi-blackhole@0.4.10 pins 0.84.0). Bun validates these names
// before loading an extension, so the module surface itself is the contract.
const EARENDIL_0_84_ROOT_EXPORTS = `
AgentSession
AgentSessionRuntime
ArminComponent
AssistantMessageComponent
BashExecutionComponent
BorderedLoader
BranchSummaryMessageComponent
CONFIG_DIR_NAME
CURRENT_SESSION_VERSION
CompactionSummaryMessageComponent
CredentialSynchronizationError
CustomEditor
CustomMessageComponent
DEFAULT_COMPACTION_SETTINGS
DEFAULT_MAX_BYTES
DEFAULT_MAX_LINES
DefaultPackageManager
DefaultResourceLoader
DynamicBorder
ExtensionEditorComponent
ExtensionInputComponent
ExtensionRunner
ExtensionSelectorComponent
FooterComponent
InteractiveMode
LoginDialogComponent
ModelRegistry
ModelRuntime
ModelSelectorComponent
OAuthSelectorComponent
ProjectTrustStore
RpcClient
SessionManager
SessionSelectorComponent
SettingsManager
SettingsSelectorComponent
ShowImagesSelectorComponent
SkillInvocationMessageComponent
Theme
ThemeSelectorComponent
ThinkingSelectorComponent
ToolExecutionComponent
TreeSelectorComponent
UserMessageComponent
UserMessageSelectorComponent
VERSION
buildContextEntries
buildSessionContext
calculateContextTokens
collectEntriesForBranchSummary
compact
convertToLlm
convertToPng
copyToClipboard
createAgentSession
createAgentSessionFromServices
createAgentSessionRuntime
createAgentSessionServices
createBashTool
createBashToolDefinition
createCodingTools
createEditTool
createEditToolDefinition
createEventBus
createExtensionRuntime
createFindTool
createFindToolDefinition
createGrepTool
createGrepToolDefinition
createLocalBashOperations
createLocalPowerShellOperations
createLsTool
createLsToolDefinition
createPowerShellTool
createPowerShellToolDefinition
createReadOnlyTools
createReadTool
createReadToolDefinition
createSyntheticSourceInfo
createWriteTool
createWriteToolDefinition
defineTool
detectSupportedImageMimeTypeFromFile
discoverAndLoadExtensions
estimateTokens
findCutPoint
findTurnStartIndex
formatDimensionNote
formatSize
formatSkillsForPrompt
generateBranchSummary
generateDiffString
generateSummary
generateSummaryWithUsage
generateUnifiedPatch
getAgentDir
getDocsPath
getExamplesPath
getLanguageFromPath
getLastAssistantUsage
getLatestCompactionEntry
getMarkdownTheme
getPackageDir
getPowerShellConfig
getReadmePath
getSelectListTheme
getSettingsListTheme
getShellConfig
hasTrustRequiringProjectResources
highlightCode
initTheme
isBashToolResult
isEditToolResult
isFindToolResult
isGrepToolResult
isLsToolResult
isPowerShellToolResult
isReadToolResult
isToolCallEventType
isWriteToolResult
keyHint
keyText
loadProjectContextFiles
loadSkills
loadSkillsFromDir
main
migrateSessionEntries
parseArgs
parseFrontmatter
parseSessionEntries
parseSkillBlock
prepareBranchEntries
rawKeyHint
readStoredCredential
renderDiff
resizeImage
resolveCliModel
resolveModelScopeWithDiagnostics
runPrintMode
runRpcMode
serializeConversation
sessionEntryToContextMessages
shouldCompact
stripFrontmatter
truncateHead
truncateLine
truncateTail
truncateToVisualLines
withFileMutationQueue
wrapRegisteredTool
wrapRegisteredTools
`
	.trim()
	.split("\n");

// Audited but deliberately not faked: omp has no behaviorally compatible
// implementation for these APIs. Exporting a no-op or a same-named function
// with a different signature would pass Bun validation and then corrupt the
// extension at runtime.
const INTENTIONALLY_UNBRIDGED = [
	"AgentSessionRuntime",
	"ArminComponent",
	"CredentialSynchronizationError",
	"ModelRuntime",
	"ModelSelectorComponent",
	"ProjectTrustStore",
	"SkillInvocationMessageComponent",
	"buildContextEntries",
	"createAgentSessionFromServices",
	"createAgentSessionRuntime",
	"createAgentSessionServices",
	"createLocalBashOperations",
	"createLocalPowerShellOperations",
	"createPowerShellTool",
	"createPowerShellToolDefinition",
	"detectSupportedImageMimeTypeFromFile",
	"formatSkillsForPrompt",
	"generateBranchSummary",
	"generateSummary",
	"generateSummaryWithUsage",
	"generateUnifiedPatch",
	"getDocsPath",
	"getExamplesPath",
	"getPowerShellConfig",
	"getReadmePath",
	"hasTrustRequiringProjectResources",
	"loadProjectContextFiles",
	"resolveCliModel",
	"resolveModelScopeWithDiagnostics",
	"runPrintMode",
	"runRpcMode",
	"sessionEntryToContextMessages",
	"withFileMutationQueue",
];

describe("legacy pi coding-agent root export audit", () => {
	it("accounts for every runtime export in the current upstream root", () => {
		const missing = EARENDIL_0_84_ROOT_EXPORTS.filter(name => !(name in legacy));
		expect(missing).toEqual(INTENTIONALLY_UNBRIDGED);
	});

	it("preserves the legacy skill block parser contract", () => {
		expect(
			legacy.parseSkillBlock('<skill name="review" location="/tmp/SKILL.md">\nBody\n</skill>\n\nFocus tests'),
		).toEqual({
			name: "review",
			location: "/tmp/SKILL.md",
			content: "Body",
			userMessage: "Focus tests",
		});
		expect(legacy.parseSkillBlock("ordinary user message")).toBeNull();
	});

	it("provides a working legacy event bus", async () => {
		const bus = legacy.createEventBus();
		const received = Promise.withResolvers<string>();
		bus.on("audit", value => received.resolve(String(value)));
		bus.emit("audit", "ok");
		expect(await received.promise).toBe("ok");
	});

	it("maps malformed image input back to the legacy null result", async () => {
		const malformed = new TextEncoder().encode("not an image");
		expect(await legacy.resizeImage(malformed, "image/png")).toBeNull();
	});
});
