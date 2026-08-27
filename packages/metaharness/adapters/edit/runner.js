/**
 * Edit benchmark runner.
 *
 * Orchestrates benchmark runs by launching RPC clients, sending prompts,
 * and verifying results. Supports parallel runs for reliability measurement.
 */
/// <reference types="./bun-imports.d.ts" />
import * as fs from "node:fs";
import * as path from "node:path";
import { formatHashlineHeader, InMemorySnapshotStore, Tokenizer as HashlineTokenizer, } from "@oh-my-pi/hashline";
import { formatSessionDumpText, RpcClient } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import { diffLines } from "diff";
import { formatDirectory } from "@oh-my-pi/typescript-edit-benchmark/formatter";
import { discoverSharedInfra, InProcessClient, } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";
import benchmarkRetryPrompt from "./prompts/benchmark-retry.md" with { type: "text" };
import benchmarkSystemPrompt from "./prompts/benchmark-system.md" with { type: "text" };
import benchmarkTaskPrompt from "./prompts/benchmark-task.md" with { type: "text" };
import { verifyExpectedFileSubset, verifyExpectedFiles, } from "@oh-my-pi/typescript-edit-benchmark/verify";
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "runs");
const TMP = path.join(RUNS_DIR, `rb-${Math.random().toString(36).slice(2, 10)}`);
const CLI_PATH = Bun.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/cli"));
function formatLogPath(logFile) {
    const relativePath = path.relative(REPO_ROOT, logFile);
    return relativePath === "" ? "." : relativePath;
}
fs.mkdirSync(TMP, { recursive: true });
let n = 0;
function subtmp(pre) {
    const dir = path.join(TMP, `${pre}-${n++}`);
    fs.mkdirSync(dir);
    return dir;
}
function sanitizeDumpPathSegment(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function getConversationDumpPath(dumpDir, taskId, runIndex) {
    return path.join(dumpDir, sanitizeDumpPathSegment(taskId), `run-${runIndex + 1}.md`);
}
/** Artifacts directory for a session dump file (.md or legacy .jsonl). */
function dumpArtifactsDir(dumpFilePath) {
    if (dumpFilePath.endsWith(".md")) {
        return dumpFilePath.slice(0, -3);
    }
    if (dumpFilePath.endsWith(".jsonl")) {
        return dumpFilePath.slice(0, -6);
    }
    const ext = path.extname(dumpFilePath);
    return path.join(path.dirname(dumpFilePath), path.basename(dumpFilePath, ext));
}
async function copyConversationArtifacts(sourceSessionFile, targetDumpFile) {
    const sourceArtifactsDir = dumpArtifactsDir(sourceSessionFile);
    const targetArtifactsDir = dumpArtifactsDir(targetDumpFile);
    try {
        const stat = await fs.promises.stat(sourceArtifactsDir);
        if (!stat.isDirectory())
            return;
        await fs.promises.cp(sourceArtifactsDir, targetArtifactsDir, { recursive: true });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
}
export async function writeConversationDump(params) {
    const dumpPath = getConversationDumpPath(params.dumpDir, params.taskId, params.runIndex);
    await fs.promises.mkdir(path.dirname(dumpPath), { recursive: true });
    const body = formatSessionDumpText({
        messages: params.snapshot.messages,
        systemPrompt: params.snapshot.systemPrompt,
        model: params.snapshot.model,
        thinkingLevel: params.snapshot.thinkingLevel,
        tools: params.snapshot.dumpTools,
    });
    await Bun.write(dumpPath, `${body}\n`);
    if (params.snapshot.sourceSessionFile) {
        await copyConversationArtifacts(params.snapshot.sourceSessionFile, dumpPath);
    }
    return dumpPath;
}
async function snapshotConversationDump(client) {
    const [messages, state] = await Promise.all([client.getMessages(), client.getState()]);
    return {
        messages,
        sourceSessionFile: state.sessionFile,
        systemPrompt: state.systemPrompt,
        model: state.model,
        thinkingLevel: state.thinkingLevel,
        dumpTools: state.dumpTools,
    };
}
function splitLines(value) {
    return value.split("\n").filter((line, idx, arr) => idx < arr.length - 1 || line);
}
function getEditPathFromArgs(args) {
    if (!args || typeof args !== "object")
        return null;
    if ("path" in args && typeof args.path === "string" && args.path.length > 0)
        return args.path;
    // Sloppy payloads name the file in a leading `[path]` header instead of an argument.
    if ("input" in args && typeof args.input === "string") {
        const header = /^\[([^\]\n]+)\]/.exec(args.input);
        if (header?.[1])
            return header[1];
    }
    return null;
}
function getEditPayloadFromArgs(args) {
    if (!args || typeof args !== "object")
        return "";
    const input = args.input;
    if (typeof input === "string")
        return input;
    const diff = args.diff;
    if (typeof diff === "string")
        return diff;
    try {
        return JSON.stringify(args);
    }
    catch {
        return "";
    }
}
export const EDIT_FAILURE_CATEGORIES = [
    "range-continuation",
    "unified-diff",
    "no-change",
    "hash-mismatch",
    "other",
];
function categorizeEditFailure(error, args) {
    const payload = getEditPayloadFromArgs(args);
    const hasRangeReplacePayload = /^[1-9]\d*[a-z]{2}\.\.[1-9]\d*[a-z]{2}[ \t]*=/m.test(payload);
    if (/\\TEXT.* (?:continuation|has been removed)|range[- ]replacement continuation|LidA\.\.LidB=FIRST_LINE/i.test(error)) {
        return "range-continuation";
    }
    if (/unified-diff syntax|\+Lid[=|]|\+[1-9]\d*[a-z]{2}[=|]/i.test(error)) {
        return "unified-diff";
    }
    if (/No changes made|no changes being made|replacement is identical/i.test(error)) {
        return "no-change";
    }
    if (/hash mismatch|expected hash|stale/i.test(error)) {
        return "hash-mismatch";
    }
    if (hasRangeReplacePayload && /unrecognized op|cannot parse|Lines must start/i.test(error)) {
        return "range-continuation";
    }
    return "other";
}
function emptyEditFailureCategoryCounts() {
    return Object.fromEntries(EDIT_FAILURE_CATEGORIES.map(category => [category, 0]));
}
function countEditFailureCategories(runs) {
    const counts = emptyEditFailureCategoryCounts();
    for (const run of runs) {
        for (const failure of run.editFailures) {
            counts[failure.category ?? "other"] += 1;
        }
    }
    return counts;
}
const BENCHMARK_TOOL_NAMES = ["read", "edit", "write", "apply_patch"];
const EDIT_TOOL_NAMES = ["edit", "apply_patch"];
function isEditTool(toolName) {
    return toolName === "edit" || toolName === "vim" || toolName === "apply_patch";
}
function isMutationTool(toolName) {
    return isEditTool(toolName) || toolName === "write";
}
// Pure classification — single shared tokenizer is safe.
const HASHLINE_OP_TOKENIZER = new HashlineTokenizer();
function hashlinePutSuffix(register, hadColon, allowsAnonymousPaste) {
    if (register !== undefined)
        return hadColon ? " @reg: (invalid)" : " @reg";
    if (hadColon)
        return ":";
    return allowsAnonymousPaste ? "" : " (invalid)";
}
function hashlineCutSuffix(register, hadColon) {
    if (register !== undefined)
        return hadColon ? " @reg: (invalid)" : " @reg";
    return hadColon ? ": (invalid)" : "";
}
/** Display the canonical S3 header shape for a parsed hashline target. */
function hashlineOpLabel(target, hadColon) {
    switch (target.kind) {
        case "replace": {
            const locator = target.range.start.line === target.range.end.line ? "N.=N" : "N.=M";
            return `PUT ${locator}${hashlinePutSuffix(target.register, hadColon, false)}`;
        }
        case "block":
            return `PUT N*${hashlinePutSuffix(target.register, hadColon, false)}`;
        case "insert_before":
            return `PUT <N${hashlinePutSuffix(target.register, hadColon, true)}`;
        case "insert_after":
            return `PUT >N${hashlinePutSuffix(target.register, hadColon, true)}`;
        case "bof":
            return `PUT <1${hashlinePutSuffix(target.register, hadColon, true)}`;
        case "eof":
            return `PUT >$${hashlinePutSuffix(target.register, hadColon, true)}`;
        case "insert_after_block":
            return `PUT >N*${hashlinePutSuffix(target.register, hadColon, true)}`;
        case "cut": {
            const locator = target.range.start.line === target.range.end.line ? "N.=N" : "N.=M";
            return `CUT ${locator}${hashlineCutSuffix(target.register, hadColon)}`;
        }
        case "cut_block":
            return `CUT N*${hashlineCutSuffix(target.register, hadColon)}`;
        case "rem":
            return "REM";
        case "move":
            return "MV";
    }
}
/**
 * Count canonical hashline op header shapes (`PUT N.=M:`, `CUT N*`,
 * `PUT >N @reg`, …) in an edit call's patch input. Returns `null` when
 * the args carry no hashline patch; non-hashline variants contribute nothing.
 */
function countHashlineOps(args) {
    if (!args || typeof args !== "object" || !("input" in args))
        return null;
    const input = args.input;
    if (typeof input !== "string" || input.length === 0)
        return null;
    const counts = {};
    for (const token of HASHLINE_OP_TOKENIZER.tokenizeAll(input)) {
        if (token.kind !== "op-block")
            continue;
        const label = hashlineOpLabel(token.target, token.hadColon);
        counts[label] = (counts[label] ?? 0) + 1;
    }
    return Object.keys(counts).length > 0 ? counts : null;
}
async function collectOriginalFileContents(cwd, files) {
    const originals = new Map();
    for (const file of files) {
        const fullPath = path.join(cwd, file);
        try {
            originals.set(fullPath, await Bun.file(fullPath).text());
        }
        catch {
            // Ignore missing files; not all tasks include all paths in every run.
        }
    }
    return originals;
}
function buildMutationPreviewAgainstOriginal(original, current) {
    if (original === current)
        return null;
    const changes = diffLines(original, current);
    const preview = [];
    let origLineNum = 1;
    let newLineNum = 1;
    // Hashline diff-preview format: `-LINE:TEXT` for removed (pre-edit line
    // number), `+LINE:TEXT` for added (post-edit line number). No per-line hash.
    for (const change of changes) {
        const lines = splitLines(change.value);
        if (!change.added && !change.removed) {
            origLineNum += lines.length;
            newLineNum += lines.length;
            continue;
        }
        if (change.removed) {
            for (const line of lines) {
                preview.push(`-${origLineNum}:${line}`);
                origLineNum += 1;
            }
            continue;
        }
        for (const line of lines) {
            preview.push(`+${newLineNum}:${line}`);
            newLineNum += 1;
        }
    }
    return preview.length > 0 ? preview.join("\n") : null;
}
async function appendNoChangeMutationHint(error, args, cwd, originalFiles) {
    if (!error.includes("No changes made"))
        return error;
    const editPath = getEditPathFromArgs(args);
    if (!editPath)
        return error;
    const fullPath = editPath.startsWith("/") ? editPath : path.join(cwd, editPath);
    const original = originalFiles.get(fullPath);
    if (original === undefined)
        return error;
    let current;
    try {
        current = await Bun.file(fullPath).text();
    }
    catch {
        return error;
    }
    const preview = buildMutationPreviewAgainstOriginal(original, current);
    if (!preview)
        return error;
    return `${error}\nThe file differs from the original fixture at these lines:\n${preview}`;
}
class PromptTimeoutError extends Error {
    telemetry;
    constructor(telemetry) {
        super("Timeout waiting for agent_end");
        this.name = "PromptTimeoutError";
        this.telemetry = telemetry;
    }
}
class PromptTurnLimitError extends Error {
    telemetry;
    constructor(telemetry) {
        super(`Max turn limit exceeded: observed ${telemetry.observedTurns} turn_start events (limit ${telemetry.maxTurns}).`);
        this.name = "PromptTurnLimitError";
        this.telemetry = telemetry;
    }
}
function buildTimeoutRetryContext(telemetry, retryNumber, retryLimit) {
    return [
        `Previous attempt timed out waiting for agent_end after ${telemetry.elapsedMs}ms.`,
        `Observed events=${telemetry.eventCount}, tool_starts=${telemetry.toolExecutionStarts}, tool_ends=${telemetry.toolExecutionEnds}, message_ends=${telemetry.messageEnds}.`,
        telemetry.lastEventType
            ? `Last event type: ${telemetry.lastEventType}.`
            : "No events were observed before timeout.",
        `Timeout retry ${retryNumber}/${retryLimit}: emit one minimal, concrete edit attempt quickly and stop.`,
    ].join("\n");
}
const AUTH_FAILURE_RE = /\b(401|unauthorized|forbidden|invalid api key|invalid key|user not found|authentication|not authenticated|permission denied|access denied)\b/i;
function detectProviderFailure(events) {
    for (const event of events) {
        if (event.type !== "message_end")
            continue;
        const message = event.message;
        if (!message || typeof message !== "object")
            continue;
        const role = message.role;
        if (role !== "assistant")
            continue;
        const errorMessage = message.errorMessage;
        if (typeof errorMessage !== "string")
            continue;
        const normalized = errorMessage.trim();
        if (normalized.length === 0)
            continue;
        return {
            kind: AUTH_FAILURE_RE.test(normalized) ? "auth" : "provider",
            message: normalized,
        };
    }
    return null;
}
function getProviderFailureRetryDelayMs(retryNumber) {
    const safeRetryNumber = Math.max(1, retryNumber);
    return Math.min(10000, 1000 * 2 ** (safeRetryNumber - 1));
}
function buildProviderFailureRetryContext(failure, retryNumber, retryLimit, delayMs) {
    const category = failure.kind === "auth" ? "provider/auth" : "provider";
    return [
        `Previous attempt failed due to a ${category} error.`,
        `Provider error: ${failure.message}`,
        `Retry ${retryNumber}/${retryLimit} after ${delayMs}ms backoff. Resume the requested edit flow once the provider responds successfully.`,
    ].join("\n");
}
async function evaluateMutationIntent(task, cwd, expectedDir) {
    const metadata = task.metadata;
    const file = metadata?.fileName ?? task.files[0];
    const lineNumber = metadata?.lineNumber;
    if (!file || typeof lineNumber !== "number" || lineNumber < 1) {
        return null;
    }
    const currentPath = file.startsWith("/") ? file : path.join(cwd, file);
    const expectedPath = file.startsWith("/") ? file : path.join(expectedDir, file);
    let currentText;
    let expectedText;
    try {
        currentText = await Bun.file(currentPath).text();
        expectedText = await Bun.file(expectedPath).text();
    }
    catch {
        return {
            matched: false,
            reason: "Unable to read current/expected target file for mutation-intent check.",
            mutationType: metadata?.mutationType,
            file,
            lineNumber,
        };
    }
    const currentLine = currentText.split("\n")[lineNumber - 1] ?? "";
    const expectedLine = expectedText.split("\n")[lineNumber - 1] ?? "";
    const originalSnippet = metadata?.originalSnippet;
    const mutatedSnippet = metadata?.mutatedSnippet;
    if (currentLine === expectedLine && expectedLine.length > 0) {
        return {
            matched: true,
            reason: "Target line exactly matches expected fixture.",
            mutationType: metadata?.mutationType,
            file,
            lineNumber,
        };
    }
    if (typeof originalSnippet === "string" && originalSnippet.length > 0) {
        const hasOriginal = currentLine.includes(originalSnippet);
        const stillHasMutated = typeof mutatedSnippet === "string" && mutatedSnippet.length > 0 ? currentLine.includes(mutatedSnippet) : false;
        if (hasOriginal && !stillHasMutated) {
            return {
                matched: true,
                reason: "Target line contains original snippet and no longer contains mutated snippet.",
                mutationType: metadata?.mutationType,
                file,
                lineNumber,
            };
        }
    }
    return {
        matched: false,
        reason: `Target line mismatch at ${file}:${lineNumber}.`,
        mutationType: metadata?.mutationType,
        file,
        lineNumber,
    };
}
/**
 * Build a textual hashline patch (with `¶path#tag` section header) that
 * transforms `actual` into `expected`. Returns null when no changes are
 * needed or the diff isn't expressible as straight insert/replace/delete ops.
 */
function buildGuidedHashlinePatch(file, actual, expected) {
    const changes = diffLines(actual, expected);
    const actualLines = actual.split("\n");
    // File-trailing newline produces a phantom empty last entry that is not a
    // real line; the hashline grammar's line numbers count real lines only.
    const fileLineCount = actualLines.length > 0 && actualLines[actualLines.length - 1] === ""
        ? actualLines.length - 1
        : actualLines.length;
    const ops = [];
    let line = 1;
    let pendingStart = 1;
    let pendingRemoved = 0;
    let pendingAdded = [];
    const formatPayload = (body) => (body.length === 0 ? "" : `\n${body.join("\n")}`);
    const flush = () => {
        if (pendingRemoved === 0 && pendingAdded.length === 0)
            return;
        if (pendingRemoved === 0) {
            // Pure insertion at `pendingStart` (line numbers are 1-indexed and
            // refer to the pre-edit file).
            if (pendingAdded.length === 0)
                return;
            if (pendingStart <= 1) {
                ops.push(`BOF↓${formatPayload(pendingAdded)}`);
            }
            else if (pendingStart > fileLineCount) {
                ops.push(`EOF↓${formatPayload(pendingAdded)}`);
            }
            else {
                // Insert above `pendingStart` so the new content lands at that line.
                ops.push(`${pendingStart}↑${formatPayload(pendingAdded)}`);
            }
        }
        else {
            const startLine = pendingStart;
            const endLine = pendingStart + pendingRemoved - 1;
            const anchor = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
            if (pendingAdded.length === 0) {
                ops.push(`${anchor}!`);
            }
            else {
                ops.push(`${anchor}:${formatPayload(pendingAdded)}`);
            }
        }
        pendingRemoved = 0;
        pendingAdded = [];
    };
    for (const change of changes) {
        const lines = splitLines(change.value);
        if (!change.added && !change.removed) {
            flush();
            line += lines.length;
            pendingStart = line;
            continue;
        }
        if (pendingRemoved === 0 && pendingAdded.length === 0) {
            pendingStart = line;
        }
        if (change.removed) {
            pendingRemoved += lines.length;
            line += lines.length;
        }
        if (change.added) {
            pendingAdded.push(...lines);
        }
    }
    flush();
    if (ops.length === 0)
        return null;
    const normalizedActual = actual.replace(/\r\n?/g, "\n");
    const snapshots = new InMemorySnapshotStore();
    const tag = snapshots.record(file, normalizedActual);
    const header = formatHashlineHeader(file, tag);
    return `${header}\n${ops.join("\n")}`;
}
async function buildGuidedContext(task, cwd, expectedDir, config) {
    if (!config.guided)
        return null;
    if (config.editVariant !== "hashline")
        return null;
    const file = task.metadata?.fileName ?? task.files[0];
    if (!file)
        return null;
    const actualPath = path.join(cwd, file);
    const expectedPath = path.join(expectedDir, file);
    const actual = await Bun.file(actualPath)
        .text()
        .catch(() => null);
    const expected = await Bun.file(expectedPath)
        .text()
        .catch(() => null);
    if (actual === null || expected === null)
        return null;
    const patch = buildGuidedHashlinePatch(file, actual, expected);
    if (patch === null)
        return null;
    // Rough complexity guard: too many ops or too long → skip guidance.
    const opCount = patch.split("\n").filter(l => /[↑↓→]/.test(l)).length;
    if (opCount === 0 || opCount > 25)
        return null;
    const args = { path: file, input: patch };
    const argsText = JSON.stringify(args, null, 2);
    if (argsText.length > 20000)
        return null;
    const metaParts = [];
    if (typeof task.metadata?.lineNumber === "number")
        metaParts.push(`Line: ${task.metadata.lineNumber}`);
    if (typeof task.metadata?.mutationType === "string")
        metaParts.push(`Mutation: ${task.metadata.mutationType}`);
    return [
        `Target file: \`${file}\`${metaParts.length > 0 ? ` (${metaParts.join(", ")})` : ""}.`,
        "Apply this edit tool call (single call; copy/paste args exactly):",
        `\`\`\`diff\n${argsText}\n\`\`\``,
    ].join("\n\n");
}
function buildInstructions(config) {
    return config.noEditRequired
        ? "Read the relevant files first, then apply the fix."
        : "Read the relevant files first, then use the edit or vim tool to apply the fix.";
}
function buildBenchmarkSystemPrompt(params) {
    return prompt.render(benchmarkSystemPrompt, {
        multiFile: params.multiFile,
        instructions: buildInstructions(params.config),
    });
}
function buildInitialBenchmarkPrompt(params) {
    return prompt.render(benchmarkTaskPrompt, {
        task_prompt: params.taskPrompt,
        guided_context: params.guidedContext ?? undefined,
    });
}
function buildRetryBenchmarkPrompt(params) {
    return prompt.render(benchmarkRetryPrompt, {
        retry_context: params.retryContext,
        guided_context: params.guidedContext ?? undefined,
    });
}
function buildBenchmarkPromptDelivery(params) {
    if (params.retryContext) {
        return {
            kind: "followUp",
            message: buildRetryBenchmarkPrompt({
                retryContext: params.retryContext,
                guidedContext: params.guidedContext,
            }),
        };
    }
    return {
        kind: "prompt",
        message: buildInitialBenchmarkPrompt({
            taskPrompt: params.taskPrompt,
            guidedContext: params.guidedContext,
        }),
    };
}
const BENCHMARK_PROVIDER_SESSION_VERSION = 1;
function buildBenchmarkProviderSessionId(params) {
    const keyMaterial = [
        `version:${BENCHMARK_PROVIDER_SESSION_VERSION}`,
        `provider:${params.config.provider}`,
        `model:${params.config.model}`,
        `task:${params.task.id}`,
        `system:${buildBenchmarkSystemPrompt({ multiFile: params.multiFile, config: params.config })}`,
        `initial:${buildInitialBenchmarkPrompt({ taskPrompt: params.task.prompt, guidedContext: params.initialGuidedContext })}`,
    ].join("\n");
    return `reb_${Bun.hash(keyMaterial).toString(36)}`;
}
async function prepareBenchmarkSessionSetup(params) {
    const initialGuidedContext = await buildGuidedContext(params.task, params.cwd, params.expectedDir, params.config);
    const providerSessionId = buildBenchmarkProviderSessionId({
        config: params.config,
        task: params.task,
        multiFile: params.multiFile,
        initialGuidedContext,
    });
    return {
        initialGuidedContext,
        providerSessionId,
        rpcArgs: buildBenchmarkRpcArgs(params.config, params.multiFile, providerSessionId),
    };
}
function buildBenchmarkRpcArgs(config, multiFile, providerSessionId) {
    return [
        "--provider-session-id",
        providerSessionId,
        "--append-system-prompt",
        buildBenchmarkSystemPrompt({ multiFile, config }),
        "--tools",
        BENCHMARK_TOOL_NAMES.join(","),
        "--no-skills",
        "--no-title",
        "--no-rules",
        "--no-lsp",
    ];
}
async function copyFixtures(task, destDir) {
    if (!task.inputDir) {
        throw new Error(`Task ${task.id} has no inputDir`);
    }
    const entries = await fs.promises.readdir(task.inputDir, { withFileTypes: true });
    await Promise.all(entries.map(entry => fs.promises.cp(path.join(task.inputDir, entry.name), path.join(destDir, entry.name), { recursive: true })));
}
function buildEarlyStop(params) {
    if (params.config.earlyStopOnMatch === false)
        return undefined;
    if (params.files.length === 0)
        return undefined;
    return {
        check: async () => {
            const verification = await verifyExpectedFileSubset(params.expectedDir, params.cwd, params.files);
            return verification.success;
        },
        onMatch: async () => {
            params.onMatched();
            await params.logEvent({ type: "early_stop", attempt: params.attempt, reason: "formatted_match" });
        },
    };
}
async function runSingleTask(task, runIndex, config, cwd, expectedDir, shared) {
    const startTime = Date.now();
    let error;
    let patchApplied = false;
    let verificationPassed = false;
    let indentScore;
    let formattedEquivalent;
    let diffStats;
    let tokens = { input: 0, output: 0, reasoning: 0, total: 0 };
    let agentResponse;
    let diff;
    const editFailures = [];
    const editWarnings = [];
    let editAutocorrectCount = 0;
    let timeoutTelemetry;
    let mutationIntentValidation = null;
    let earlyStoppedByMatch = false;
    let conversationSnapshot;
    const toolStats = {
        read: 0,
        edit: 0,
        write: 0,
        editSuccesses: 0,
        editFailures: 0,
        editWarnings: 0,
        editAutocorrects: 0,
        totalInputChars: 0,
    };
    const hashlineSubtypes = {};
    const logFile = path.join(TMP, `run-${task.id}-${runIndex}.jsonl`);
    const logEvent = async (event) => {
        await fs.promises.appendFile(logFile, `${JSON.stringify(event)}\n`);
    };
    const originalFiles = await collectOriginalFileContents(cwd, task.files);
    let timeoutRetriesUsed = 0;
    let zeroToolRetries = 0;
    let providerFailureRetries = 0;
    const previousEnv = {
        PI_EDIT_VARIANT: process.env.PI_EDIT_VARIANT,
        PI_EDIT_FUZZY: process.env.PI_EDIT_FUZZY,
        PI_EDIT_FUZZY_THRESHOLD: process.env.PI_EDIT_FUZZY_THRESHOLD,
        PI_STRICT_EDIT_MODE: process.env.PI_STRICT_EDIT_MODE,
        PI_NO_TITLE: process.env.PI_NO_TITLE,
    };
    try {
        const sessionSetup = await prepareBenchmarkSessionSetup({
            config,
            task,
            cwd,
            expectedDir,
            multiFile: false,
        });
        await fs.promises.appendFile(logFile, `{"type":"meta","task":"${task.id}","run":${runIndex},"workDir":"${cwd}","providerSessionId":${JSON.stringify(sessionSetup.providerSessionId)}}\n`);
        if (config.editVariant !== undefined)
            process.env.PI_EDIT_VARIANT = config.editVariant;
        if (config.editFuzzy !== undefined)
            process.env.PI_EDIT_FUZZY = config.editFuzzy === "auto" ? "auto" : config.editFuzzy ? "1" : "0";
        if (config.editFuzzyThreshold !== undefined)
            process.env.PI_EDIT_FUZZY_THRESHOLD =
                config.editFuzzyThreshold === "auto" ? "auto" : String(config.editFuzzyThreshold);
        process.env.PI_STRICT_EDIT_MODE = "1";
        process.env.PI_NO_TITLE = "1";
        const useInProcess = config.inProcess !== false;
        const client = useInProcess
            ? new InProcessClient({
                cwd,
                model: config.model,
                appendSystemPrompt: buildBenchmarkSystemPrompt({ multiFile: false, config }),
                tools: [...BENCHMARK_TOOL_NAMES],
                editVariant: config.editVariant,
                editFuzzy: config.editFuzzy,
                editFuzzyThreshold: config.editFuzzyThreshold,
                shared,
            })
            : (() => {
                const rpc = new RpcClient({
                    cliPath: CLI_PATH,
                    cwd,
                    provider: config.provider,
                    model: config.model,
                    args: sessionSetup.rpcArgs,
                    env: { ...process.env },
                });
                return Object.assign(rpc, {
                    dispose: async () => rpc[Symbol.dispose](),
                });
            })();
        try {
            await client.start();
            if (config.thinkingLevel) {
                await client.setThinkingLevel(config.thinkingLevel);
            }
            const initialState = await client.getState();
            const systemPromptTokens = estimateTokens(initialState.systemPrompt?.join("\n\n") ?? "");
            const maxAttempts = Math.max(1, Math.floor(config.maxAttempts ?? 1));
            const maxTimeoutRetries = config.maxTimeoutRetries ?? 3;
            const noOpRetryLimit = config.noOpRetryLimit ?? 2;
            const maxProviderFailureRetries = config.maxProviderFailureRetries ?? 3;
            let retryContext = null;
            let allEvents = [];
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const guidedContext = attempt === 0
                    ? sessionSetup.initialGuidedContext
                    : await buildGuidedContext(task, cwd, expectedDir, config);
                const delivery = buildBenchmarkPromptDelivery({
                    taskPrompt: task.prompt,
                    guidedContext,
                    retryContext,
                });
                await fs.promises.appendFile(logFile, `{"type":"prompt","attempt":${attempt + 1},"delivery":${JSON.stringify(delivery.kind)},"message":${JSON.stringify(delivery.message)}}\n`);
                const statsBefore = await client.getSessionStats();
                let events;
                try {
                    events = await collectPromptEvents(client, delivery, config, logEvent, buildEarlyStop({
                        config,
                        cwd,
                        expectedDir,
                        files: task.files,
                        logEvent,
                        attempt: attempt + 1,
                        onMatched: () => {
                            earlyStoppedByMatch = true;
                        },
                    }));
                }
                catch (err) {
                    if (err instanceof PromptTurnLimitError) {
                        error = err.message;
                        await logEvent({ type: "turn_limit_exceeded", attempt: attempt + 1, telemetry: err.telemetry });
                        break;
                    }
                    if (err instanceof PromptTimeoutError) {
                        timeoutTelemetry = err.telemetry;
                        await logEvent({ type: "timeout", attempt: attempt + 1, telemetry: err.telemetry });
                        timeoutRetriesUsed += 1;
                        retryContext = buildTimeoutRetryContext(err.telemetry, timeoutRetriesUsed, maxTimeoutRetries);
                        if (timeoutRetriesUsed >= maxTimeoutRetries) {
                            error = `Timeout exhausted after ${maxTimeoutRetries} retries (last: ${err.telemetry.elapsedMs}ms, events=${err.telemetry.eventCount}, last_event=${err.telemetry.lastEventType ?? "none"})`;
                            await logEvent({
                                type: "timeout_exhausted",
                                retriesUsed: timeoutRetriesUsed,
                                telemetry: err.telemetry,
                            });
                            break;
                        }
                        attempt--; // Don't consume a regular attempt slot for timeout retries
                        continue;
                    }
                    throw err;
                }
                const statsAfter = await client.getSessionStats();
                const attemptTokens = diffTokenStats(statsBefore, statsAfter, systemPromptTokens);
                tokens = {
                    input: tokens.input + attemptTokens.input,
                    output: tokens.output + attemptTokens.output,
                    reasoning: tokens.reasoning + attemptTokens.reasoning,
                    total: tokens.total + attemptTokens.total,
                };
                await logEvent({ type: "stats", before: statsBefore, after: statsAfter, attempt: attempt + 1 });
                allEvents = allEvents.concat(events);
                agentResponse = (await client.getLastAssistantText()) ?? undefined;
                await logEvent({ type: "response", text: agentResponse, attempt: attempt + 1 });
                const providerFailure = detectProviderFailure(events);
                const hasMutationToolCall = events.some(event => event.type === "tool_execution_start" && isMutationTool(event.toolName));
                if (providerFailure && !hasMutationToolCall) {
                    await logEvent({
                        type: "provider_failure",
                        attempt: attempt + 1,
                        kind: providerFailure.kind,
                        error: providerFailure.message,
                    });
                    if (providerFailureRetries < maxProviderFailureRetries) {
                        providerFailureRetries += 1;
                        const delayMs = getProviderFailureRetryDelayMs(providerFailureRetries);
                        await logEvent({
                            type: "provider_failure_retry",
                            attempt: attempt + 1,
                            retryNumber: providerFailureRetries,
                            retryLimit: maxProviderFailureRetries,
                            delayMs,
                            kind: providerFailure.kind,
                        });
                        retryContext = buildProviderFailureRetryContext(providerFailure, providerFailureRetries, maxProviderFailureRetries, delayMs);
                        await Bun.sleep(delayMs);
                        attempt--; // Don't consume a regular attempt slot for provider/auth retries
                        continue;
                    }
                    error = `Provider ${providerFailure.kind} failure: ${providerFailure.message}`;
                    await logEvent({
                        type: "provider_failure_exhausted",
                        attempt: attempt + 1,
                        retriesUsed: providerFailureRetries,
                        kind: providerFailure.kind,
                        error: providerFailure.message,
                    });
                    break;
                }
                const pendingEdits = new Map();
                const rawToolBlocks = new Map();
                for (const event of events) {
                    if (event.type === "message_end") {
                        for (const raw of extractAssistantToolRawBlocks(event)) {
                            rawToolBlocks.set(raw.id, raw.rawBlock);
                            const pending = pendingEdits.get(raw.id);
                            if (pending)
                                pending.rawBlock = raw.rawBlock;
                        }
                    }
                    if (event.type === "tool_execution_start") {
                        const e = event;
                        const toolName = e.toolName;
                        if (toolName === "read") {
                            toolStats.read++;
                        }
                        else if (isEditTool(toolName)) {
                            toolStats.edit++;
                            if (e.toolCallId)
                                pendingEdits.set(e.toolCallId, { args: e.args, rawBlock: rawToolBlocks.get(e.toolCallId) });
                        }
                        else if (toolName === "write") {
                            toolStats.write++;
                        }
                        // Count input chars from args
                        if (e.args) {
                            toolStats.totalInputChars += JSON.stringify(e.args).length;
                        }
                    }
                    else if (event.type === "tool_execution_end") {
                        const e = event;
                        if (isEditTool(e.toolName) && e.toolCallId && pendingEdits.has(e.toolCallId)) {
                            const pendingEdit = pendingEdits.get(e.toolCallId) ?? { args: null };
                            const args = pendingEdit.args;
                            pendingEdits.delete(e.toolCallId);
                            const hashlineOpCounts = countHashlineOps(args);
                            if (hashlineOpCounts) {
                                for (const key in hashlineOpCounts) {
                                    hashlineSubtypes[key] = (hashlineSubtypes[key] ?? 0) + hashlineOpCounts[key];
                                }
                            }
                            if (e.isError) {
                                toolStats.editFailures++;
                                const error = await appendNoChangeMutationHint(extractToolErrorMessage(e.result), args, cwd, originalFiles);
                                editFailures.push({
                                    toolCallId: e.toolCallId,
                                    args,
                                    error,
                                    rawBlock: pendingEdit.rawBlock,
                                    category: categorizeEditFailure(error, args),
                                });
                            }
                            else {
                                toolStats.editSuccesses++;
                                if (e.toolName === "edit") {
                                    const warningMessages = extractHashlineWarnings(e.result);
                                    if (warningMessages.length > 0) {
                                        editWarnings.push(...warningMessages);
                                        toolStats.editWarnings += warningMessages.length;
                                        if (hasHashlineAutocorrectWarning(warningMessages)) {
                                            editAutocorrectCount++;
                                            toolStats.editAutocorrects++;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Retry if the model didn't attempt any edit/write (read-only or no tool calls)
                const madeEditAttempt = toolStats.edit > 0 || toolStats.write > 0;
                if (!madeEditAttempt && zeroToolRetries < noOpRetryLimit) {
                    zeroToolRetries++;
                    await logEvent({ type: "zero_tool_retry", attempt: attempt + 1, retryNumber: zeroToolRetries });
                    retryContext = `Previous attempt read files but made no edit attempt — you must use the edit or vim tool to apply the fix. Retry ${zeroToolRetries}/${noOpRetryLimit}.`;
                    attempt--; // Don't consume a regular attempt slot
                    continue;
                }
                patchApplied = toolStats.edit > 0;
                const verification = await verifyExpectedFiles(expectedDir, cwd);
                if (config.autoFormat) {
                    await formatDirectory(cwd);
                }
                verificationPassed = verification.success;
                indentScore = verification.indentScore;
                formattedEquivalent = verification.formattedEquivalent;
                diffStats = verification.diffStats;
                diff = verification.diff;
                mutationIntentValidation = await evaluateMutationIntent(task, cwd, expectedDir);
                if (!verification.success && verification.error) {
                    error = verification.error;
                }
                if (verification.success) {
                    break;
                }
                const mutationIntentSuffix = mutationIntentValidation
                    ? `\n\nMutation intent: ${mutationIntentValidation.matched ? "matched" : "not matched"} (${mutationIntentValidation.reason})`
                    : "";
                retryContext = error
                    ? `Verification failed: ${error}${diff ? `\n\nDiff (expected vs actual):\n\n\`\`\`diff\n${diff}\n\`\`\`` : ""}${mutationIntentSuffix}`
                    : `Previous attempt failed.${mutationIntentSuffix}`;
            }
            if (config.conversationDumpDir) {
                conversationSnapshot = await snapshotConversationDump(client);
            }
        }
        finally {
            await client.dispose();
        }
    }
    catch (err) {
        error = err instanceof Error ? err.message : String(err);
        await logEvent({ type: "error", error });
    }
    finally {
        const restoreEnvKey = (key) => {
            const value = previousEnv[key];
            if (value === undefined) {
                delete process.env[key];
            }
            else {
                process.env[key] = value;
            }
        };
        restoreEnvKey("PI_EDIT_VARIANT");
        restoreEnvKey("PI_EDIT_FUZZY");
        restoreEnvKey("PI_EDIT_FUZZY_THRESHOLD");
        restoreEnvKey("PI_STRICT_EDIT_MODE");
        restoreEnvKey("PI_NO_TITLE");
    }
    const duration = Date.now() - startTime;
    const mustUseEditTool = Boolean(config.requireEditToolCall) && !config.noEditRequired;
    const mustUseReadTool = Boolean(config.requireReadToolCall) && !config.noEditRequired;
    const editSucceeded = toolStats.editSuccesses > 0;
    const success = verificationPassed && (!mustUseEditTool || editSucceeded) && (!mustUseReadTool || toolStats.read > 0);
    const metadata = task.metadata;
    await logEvent({
        type: "result",
        success,
        patchApplied,
        verificationPassed,
        error,
        duration,
        timeoutTelemetry,
        mutationIntentValidation,
    });
    console.log(`  Log: ${formatLogPath(logFile)}`);
    if (config.conversationDumpDir && conversationSnapshot) {
        await writeConversationDump({
            dumpDir: config.conversationDumpDir,
            taskId: task.id,
            runIndex,
            snapshot: conversationSnapshot,
        });
    }
    return {
        runIndex,
        success,
        patchApplied,
        verificationPassed,
        seed: metadata?.seed,
        mutationType: metadata?.mutationType,
        mutationCategory: metadata?.mutationCategory,
        difficultyScore: metadata?.difficultyScore,
        error,
        tokens,
        duration,
        indentScore,
        formattedEquivalent,
        diffStats,
        agentResponse,
        diff,
        toolCalls: toolStats,
        editFailures,
        editWarnings,
        editAutocorrectCount,
        hashlineEditSubtypes: Object.keys(hashlineSubtypes).length > 0 ? hashlineSubtypes : undefined,
        mutationIntentMatched: mutationIntentValidation?.matched,
        mutationIntentReason: mutationIntentValidation?.reason,
        timeoutTelemetry,
        earlyStopped: earlyStoppedByMatch || undefined,
        retryStats: {
            timeoutRetries: timeoutRetriesUsed,
            zeroToolRetries,
            providerFailureRetries,
        },
    };
}
function extractToolText(result) {
    if (typeof result === "string")
        return result;
    if (!result || typeof result !== "object")
        return null;
    const content = result.content;
    if (!Array.isArray(content))
        return null;
    for (const entry of content) {
        if (!entry || typeof entry !== "object")
            continue;
        if (!("text" in entry))
            continue;
        const text = entry.text;
        if (typeof text === "string")
            return text;
    }
    return null;
}
function extractHashlineWarnings(result) {
    const text = extractToolText(result);
    if (!text)
        return [];
    const marker = "Warnings:\n";
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1)
        return [];
    return text
        .slice(markerIndex + marker.length)
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);
}
function hasHashlineAutocorrectWarning(warnings) {
    return warnings.some(warning => warning.startsWith("Auto-corrected "));
}
function extractToolErrorMessage(result) {
    const text = extractToolText(result);
    if (text)
        return text;
    try {
        return JSON.stringify(result);
    }
    catch {
        return "Unknown error";
    }
}
function extractAssistantToolRawBlocks(event) {
    const message = event.message;
    if (message === null || typeof message !== "object")
        return [];
    const role = message.role;
    if (role !== "assistant")
        return [];
    const content = message.content;
    if (!Array.isArray(content))
        return [];
    const rawBlocks = [];
    for (const block of content) {
        if (block === null || typeof block !== "object")
            continue;
        const typedBlock = block;
        if (typedBlock.type !== "toolCall")
            continue;
        if (typeof typedBlock.id !== "string" || typeof typedBlock.rawBlock !== "string")
            continue;
        rawBlocks.push({ id: typedBlock.id, rawBlock: typedBlock.rawBlock });
    }
    return rawBlocks;
}
function shuffle(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}
async function collectPromptEvents(client, delivery, config, logEvent, earlyStop) {
    const events = [];
    let unsubscribe;
    const startedAt = Date.now();
    let pendingRetry = false;
    let toolExecutionStarts = 0;
    let toolExecutionEnds = 0;
    let messageEnds = 0;
    let lastEventType;
    const recentEventTypes = [];
    let observedTurns = 0;
    let timer;
    let settled = false;
    let receivedFirstEvent = false;
    let earlyStopTriggered = false;
    let earlyStopChain = Promise.resolve();
    const connectionTimeout = config.connectionTimeout ?? 30000;
    const eventsPromise = new Promise((resolve, reject) => {
        const resolveWait = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            unsubscribe?.();
            resolve();
        };
        const rejectWait = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            unsubscribe?.();
            reject(err);
        };
        const fireTimeout = () => {
            client.abort?.();
            rejectWait(new PromptTimeoutError({
                elapsedMs: Date.now() - startedAt,
                eventCount: events.length,
                toolExecutionStarts,
                toolExecutionEnds,
                messageEnds,
                lastEventType,
                recentEventTypes: [...recentEventTypes],
                pendingRetry,
            }));
        };
        const triggerEarlyStop = () => {
            if (!earlyStop || earlyStopTriggered || settled)
                return;
            earlyStopChain = earlyStopChain
                .then(async () => {
                if (earlyStopTriggered || settled)
                    return;
                let matched = false;
                try {
                    matched = await earlyStop.check();
                }
                catch {
                    return;
                }
                if (!matched || earlyStopTriggered || settled)
                    return;
                earlyStopTriggered = true;
                try {
                    await earlyStop.onMatch();
                }
                catch {
                    // Swallow callback errors; we still want to short-circuit.
                }
                client.abort?.();
                resolveWait();
            })
                .catch(() => { });
        };
        // Start with the shorter connection timeout; upgrade to full timeout on first event
        timer = setTimeout(fireTimeout, connectionTimeout);
        unsubscribe = client.onEvent(event => {
            if (!event || settled) {
                return;
            }
            const typedEvent = event;
            // First event arrived: switch to the full activity timeout
            if (!receivedFirstEvent) {
                receivedFirstEvent = true;
                if (timer) {
                    clearTimeout(timer);
                }
                timer = setTimeout(fireTimeout, config.timeout);
            }
            events.push(typedEvent);
            lastEventType = typedEvent.type;
            recentEventTypes.push(typedEvent.type);
            if (recentEventTypes.length > 8) {
                recentEventTypes.shift();
            }
            if (typedEvent.type === "tool_execution_start") {
                toolExecutionStarts += 1;
            }
            if (typedEvent.type === "tool_execution_end") {
                toolExecutionEnds += 1;
            }
            if (typedEvent.type === "tool_execution_end" &&
                !typedEvent.isError &&
                isMutationTool(typedEvent.toolName)) {
                triggerEarlyStop();
            }
            if (typedEvent.type === "message_end") {
                messageEnds += 1;
            }
            if (typedEvent.type === "tool_execution_start" ||
                typedEvent.type === "tool_execution_end" ||
                typedEvent.type === "message_end") {
                logEvent(typedEvent).catch(() => { });
            }
            if (typedEvent.type === "turn_start") {
                observedTurns += 1;
                if (typeof config.maxTurns === "number" && observedTurns > config.maxTurns) {
                    client.abort?.();
                    rejectWait(new PromptTurnLimitError({
                        elapsedMs: Date.now() - startedAt,
                        observedTurns,
                        maxTurns: config.maxTurns,
                        pendingRetry,
                        lastEventType,
                        recentEventTypes: [...recentEventTypes],
                    }));
                    return;
                }
                if (pendingRetry) {
                    pendingRetry = false;
                }
            }
            else if (typedEvent.type === "auto_retry_start") {
                pendingRetry = true;
            }
            if (typedEvent.type === "agent_end") {
                if (pendingRetry) {
                    return;
                }
                resolveWait();
            }
        });
    });
    // Prevent unhandled rejection if events reject eventsPromise during prompt()
    // (happens in-process where events fire synchronously within prompt/followUp)
    eventsPromise.catch(() => { });
    try {
        if (delivery.kind === "followUp") {
            await client.followUp(delivery.message);
        }
        else {
            await client.prompt(delivery.message);
        }
    }
    catch (err) {
        if (earlyStopTriggered) {
            // Abort raised inside prompt(); the run already short-circuited successfully.
            if (timer) {
                clearTimeout(timer);
            }
            unsubscribe?.();
            return events;
        }
        if (timer) {
            clearTimeout(timer);
        }
        unsubscribe?.();
        throw err;
    }
    await eventsPromise;
    return events;
}
/** Rough token estimate (4 chars per token). Used to subtract system prompt overhead. */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function diffTokenStats(before, after, systemPromptTokens) {
    // `input` here is the total prompt tokens delivered to the model on the wire,
    // summed across all four buckets the providers expose: non-cached input,
    // cacheRead, cacheWrite. Summing makes the metric comparable across providers
    // with different caching behavior — Anthropic with a hot cache reports its
    // prompt entirely under cacheRead/cacheWrite while non-caching providers put
    // the same content under `input`.
    //
    // The system prompt and tool definitions are constant per-call overhead. We
    // subtract `calls * systemPromptTokens` once per assistant turn so the
    // reported figure reflects task-driven prompt cost rather than fixed boilerplate.
    const calls = Math.max(0, after.assistantMessages - before.assistantMessages);
    const overhead = calls * systemPromptTokens;
    const beforePrompt = before.tokens.input + before.tokens.cacheRead + before.tokens.cacheWrite;
    const afterPrompt = after.tokens.input + after.tokens.cacheRead + after.tokens.cacheWrite;
    const input = Math.max(0, afterPrompt - beforePrompt - overhead);
    const output = Math.max(0, after.tokens.output - before.tokens.output);
    const reasoning = Math.max(0, after.tokens.reasoning - before.tokens.reasoning);
    const total = input + output;
    return { input, output, reasoning, total };
}
function isTransportFailure(r) {
    if (r.success)
        return false;
    const err = r.error ?? "";
    // Provider/transport stalls retried until the cap was hit. These don't reflect
    // edit-tool quality, so we exclude them from the score denominator.
    return err.includes("Timeout exhausted");
}
function isGhostRun(r) {
    if (r.success)
        return false;
    const noProgress = r.tokens.total === 0 && r.toolCalls.read === 0 && r.toolCalls.edit === 0 && r.toolCalls.write === 0;
    return noProgress || isTransportFailure(r);
}
const EMPTY_TOOL_CALL_STATS = {
    read: 0,
    edit: 0,
    write: 0,
    editSuccesses: 0,
    editFailures: 0,
    editWarnings: 0,
    editAutocorrects: 0,
    totalInputChars: 0,
};
/**
 * Strict ordering used to pick the "best" run for a task:
 *   1. Successful runs win over failed runs.
 *   2. Then prefer non-ghost runs (real work over 0/0/0 stalls).
 *   3. Then prefer the run with lower total token usage.
 *   4. Then prefer the earlier runIndex for stability.
 */
function isBetterRun(a, b) {
    if (a.success !== b.success)
        return a.success;
    const aGhost = isGhostRun(a);
    const bGhost = isGhostRun(b);
    if (aGhost !== bGhost)
        return !aGhost;
    if (a.tokens.total !== b.tokens.total)
        return a.tokens.total < b.tokens.total;
    return a.runIndex < b.runIndex;
}
function pickBestRunIndex(orderedRuns) {
    if (orderedRuns.length === 0)
        return -1;
    let bestIdx = 0;
    for (let i = 1; i < orderedRuns.length; i++) {
        if (isBetterRun(orderedRuns[i], orderedRuns[bestIdx]))
            bestIdx = i;
    }
    return bestIdx;
}
function summarizeTaskRuns(task, runs) {
    const orderedRuns = runs.slice().sort((a, b) => a.runIndex - b.runIndex);
    const nonGhostRuns = orderedRuns.filter(r => !isGhostRun(r));
    const successfulNonGhost = nonGhostRuns.filter(r => r.success).length;
    const flakeSuccessRate = nonGhostRuns.length > 0 ? successfulNonGhost / nonGhostRuns.length : 0;
    const bestIdx = pickBestRunIndex(orderedRuns);
    const best = bestIdx === -1 ? undefined : orderedRuns[bestIdx];
    const tokens = best ? { ...best.tokens } : { input: 0, output: 0, reasoning: 0, total: 0 };
    const duration = best?.duration ?? 0;
    const indentScore = typeof best?.indentScore === "number" ? best.indentScore : 0;
    const toolCalls = best ? { ...best.toolCalls } : { ...EMPTY_TOOL_CALL_STATS };
    const editSuccessRate = toolCalls.edit > 0 ? toolCalls.editSuccesses / toolCalls.edit : 1;
    const autocorrectFreeSuccess = Boolean(best?.success) && (best?.editAutocorrectCount ?? 0) === 0;
    return {
        id: task.id,
        name: task.name,
        files: task.files,
        runs: orderedRuns,
        bestRunIndex: best?.runIndex ?? -1,
        success: Boolean(best?.success),
        tokens,
        duration,
        indentScore,
        toolCalls,
        editSuccessRate,
        autocorrectFreeSuccess,
        flakeSuccessRate,
    };
}
function buildFailureResult(item, error) {
    return {
        runIndex: item.runIndex,
        success: false,
        patchApplied: false,
        verificationPassed: false,
        error,
        tokens: { input: 0, output: 0, reasoning: 0, total: 0 },
        duration: 0,
        toolCalls: {
            read: 0,
            edit: 0,
            write: 0,
            editSuccesses: 0,
            editFailures: 0,
            editWarnings: 0,
            editAutocorrects: 0,
            totalInputChars: 0,
        },
        editFailures: [],
        editWarnings: [],
        editAutocorrectCount: 0,
    };
}
async function runConcurrentBenchmarkRun(item, config, onProgress, shared) {
    const workDir = subtmp(item.task.id);
    try {
        await copyFixtures(item.task, workDir);
        onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "started" });
        const result = await runSingleTask(item.task, item.runIndex, config, workDir, item.task.expectedDir, shared);
        onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
        return { task: item.task, result };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = buildFailureResult(item, message);
        onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
        return { task: item.task, result };
    }
}
/**
 * Linear-interpolated percentile (NumPy "linear" / type-7) over an ascending-sorted
 * sample. `p` is a percentage in [0, 100]. Returns 0 for an empty sample.
 */
export function percentile(sortedAscending, p) {
    const n = sortedAscending.length;
    if (n === 0)
        return 0;
    if (n === 1)
        return sortedAscending[0];
    const rank = (p / 100) * (n - 1);
    const lo = Math.floor(rank);
    const loVal = sortedAscending[lo];
    const hi = Math.ceil(rank);
    if (lo === hi)
        return loVal;
    return loVal + (sortedAscending[hi] - loVal) * (rank - lo);
}
/** Compute the per-run token distribution (median, p1, p99) across the given runs. */
export function summarizeTokenDistribution(runs) {
    const input = runs.map(r => r.tokens.input).sort((a, b) => a - b);
    const output = runs.map(r => r.tokens.output).sort((a, b) => a - b);
    const reasoning = runs.map(r => r.tokens.reasoning).sort((a, b) => a - b);
    const total = runs.map(r => r.tokens.total).sort((a, b) => a - b);
    const at = (p) => ({
        input: Math.round(percentile(input, p)),
        output: Math.round(percentile(output, p)),
        reasoning: Math.round(percentile(reasoning, p)),
        total: Math.round(percentile(total, p)),
    });
    return { median: at(50), p1: at(1), p99: at(99) };
}
export function buildBenchmarkResult(params) {
    const taskResults = params.tasks.map(task => summarizeTaskRuns(task, params.resultsByTask.get(task.id) ?? []));
    const endTime = params.endTime ?? new Date().toISOString();
    // Diagnostic aggregates run over *every* executed run (across all N) so the
    // report still surfaces ghost/timeout/retry signals.
    const allRuns = taskResults.flatMap(t => t.runs);
    const ghostRuns = allRuns.filter(r => isGhostRun(r)).length;
    const transportFailureRuns = allRuns.filter(r => isTransportFailure(r)).length;
    const nonGhostRuns = allRuns.filter(r => !isGhostRun(r));
    const totalRuns = nonGhostRuns.length;
    const successfulRuns = allRuns.filter(r => r.success).length;
    const timeoutRuns = nonGhostRuns.filter(r => r.error?.includes("Timeout") || r.error?.includes("Timeout exhausted")).length;
    const totalTimeoutRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.timeoutRetries ?? 0), 0);
    const totalZeroToolRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.zeroToolRetries ?? 0), 0);
    const totalProviderFailureRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.providerFailureRetries ?? 0), 0);
    const editFailureCategories = countEditFailureCategories(nonGhostRuns);
    // Op counts aggregate every attempted edit call across ALL runs (retries and
    // failed calls included) — deliberately: the mix shows what the model reaches
    // for, not just what landed. Best-run-only would hide exactly the flailing
    // (failed operations before a successful retry) this table exists to expose.
    const hashlineEditSubtypeTotals = {};
    for (const run of allRuns) {
        const runOps = run.hashlineEditSubtypes;
        if (!runOps)
            continue;
        for (const key in runOps) {
            hashlineEditSubtypeTotals[key] = (hashlineEditSubtypeTotals[key] ?? 0) + runOps[key];
        }
    }
    const hashlineEditSubtypes = Object.keys(hashlineEditSubtypeTotals).length > 0 ? hashlineEditSubtypeTotals : undefined;
    // Primary aggregates run over the *best* run of each completed task.
    const bestRuns = [];
    for (const task of taskResults) {
        if (task.bestRunIndex < 0)
            continue;
        const best = task.runs.find(r => r.runIndex === task.bestRunIndex);
        if (best)
            bestRuns.push(best);
    }
    const tasksWithBestRun = bestRuns.length;
    const totalTasks = params.tasks.length;
    const denom = totalTasks || 1;
    const successfulTasks = taskResults.filter(t => t.success).length;
    const consistentlyPassingTasks = taskResults.filter(t => t.success && t.runs.filter(r => !isGhostRun(r)).every(r => r.success)).length;
    const flakyTasks = taskResults.filter(t => t.success && t.runs.filter(r => !isGhostRun(r)).some(r => !r.success)).length;
    const totalTokens = {
        input: bestRuns.reduce((sum, r) => sum + r.tokens.input, 0),
        output: bestRuns.reduce((sum, r) => sum + r.tokens.output, 0),
        reasoning: bestRuns.reduce((sum, r) => sum + r.tokens.reasoning, 0),
        total: bestRuns.reduce((sum, r) => sum + r.tokens.total, 0),
    };
    const tokenDistribution = summarizeTokenDistribution(bestRuns);
    const totalDuration = bestRuns.reduce((sum, r) => sum + r.duration, 0);
    const totalToolCalls = {
        read: bestRuns.reduce((sum, r) => sum + r.toolCalls.read, 0),
        edit: bestRuns.reduce((sum, r) => sum + r.toolCalls.edit, 0),
        write: bestRuns.reduce((sum, r) => sum + r.toolCalls.write, 0),
        editSuccesses: bestRuns.reduce((sum, r) => sum + r.toolCalls.editSuccesses, 0),
        editFailures: bestRuns.reduce((sum, r) => sum + r.toolCalls.editFailures, 0),
        editWarnings: bestRuns.reduce((sum, r) => sum + r.toolCalls.editWarnings, 0),
        editAutocorrects: bestRuns.reduce((sum, r) => sum + r.toolCalls.editAutocorrects, 0),
        totalInputChars: bestRuns.reduce((sum, r) => sum + r.toolCalls.totalInputChars, 0),
    };
    const bestIndentScores = bestRuns
        .map(r => r.indentScore)
        .filter((score) => typeof score === "number");
    const avgIndentScore = bestIndentScores.length > 0 ? bestIndentScores.reduce((sum, s) => sum + s, 0) / bestIndentScores.length : 0;
    const editSuccessRate = totalToolCalls.edit > 0 ? totalToolCalls.editSuccesses / totalToolCalls.edit : 1;
    const autocorrectFreeSuccessfulTasks = bestRuns.filter(r => r.success && r.editAutocorrectCount === 0).length;
    const autocorrectedBestRuns = bestRuns.filter(r => r.editAutocorrectCount > 0).length;
    const editAutocorrectRate = totalToolCalls.editSuccesses > 0 ? totalToolCalls.editAutocorrects / totalToolCalls.editSuccesses : 0;
    const bestWithMutationIntent = bestRuns.filter(r => typeof r.mutationIntentMatched === "boolean");
    const mutationIntentMatchRate = bestWithMutationIntent.length > 0
        ? bestWithMutationIntent.filter(r => r.mutationIntentMatched).length / bestWithMutationIntent.length
        : undefined;
    const oneShotSuccessRuns = taskResults
        .map(t => t.runs.find(r => r.runIndex === 0))
        .filter((r) => Boolean(r?.success));
    const successfulOneShotTasks = oneShotSuccessRuns.length;
    const oneShotDenom = successfulOneShotTasks || 1;
    const totalOneShotSuccessTokens = {
        input: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.input, 0),
        output: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.output, 0),
        reasoning: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.reasoning, 0),
        total: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.total, 0),
    };
    const oneShotTokenDistribution = summarizeTokenDistribution(oneShotSuccessRuns);
    const taskDenom = tasksWithBestRun || 1;
    const summary = {
        successfulOneShotTasks,
        totalOneShotSuccessTokens,
        avgOneShotSuccessTokensPerTask: {
            input: Math.round(totalOneShotSuccessTokens.input / oneShotDenom),
            output: Math.round(totalOneShotSuccessTokens.output / oneShotDenom),
            reasoning: Math.round(totalOneShotSuccessTokens.reasoning / oneShotDenom),
            total: Math.round(totalOneShotSuccessTokens.total / oneShotDenom),
        },
        medianOneShotSuccessTokensPerTask: oneShotTokenDistribution.median,
        p1OneShotSuccessTokensPerTask: oneShotTokenDistribution.p1,
        p99OneShotSuccessTokensPerTask: oneShotTokenDistribution.p99,
        totalTasks,
        totalRuns,
        successfulRuns,
        successfulTasks,
        taskSuccessRate: successfulTasks / denom,
        flakyTasks,
        consistentlyPassingTasks,
        totalTokens,
        avgTokensPerTask: {
            input: Math.round(totalTokens.input / taskDenom),
            output: Math.round(totalTokens.output / taskDenom),
            reasoning: Math.round(totalTokens.reasoning / taskDenom),
            total: Math.round(totalTokens.total / taskDenom),
        },
        medianTokensPerTask: tokenDistribution.median,
        p1TokensPerTask: tokenDistribution.p1,
        p99TokensPerTask: tokenDistribution.p99,
        totalDuration,
        avgDurationPerTask: Math.round(totalDuration / taskDenom),
        avgIndentScore,
        totalToolCalls,
        avgToolCallsPerTask: {
            read: totalToolCalls.read / taskDenom,
            edit: totalToolCalls.edit / taskDenom,
            write: totalToolCalls.write / taskDenom,
            editSuccesses: totalToolCalls.editSuccesses / taskDenom,
            editFailures: totalToolCalls.editFailures / taskDenom,
            editWarnings: totalToolCalls.editWarnings / taskDenom,
            editAutocorrects: totalToolCalls.editAutocorrects / taskDenom,
            totalInputChars: totalToolCalls.totalInputChars / taskDenom,
        },
        editSuccessRate,
        autocorrectFreeSuccessfulTasks,
        autocorrectFreeSuccessRate: autocorrectFreeSuccessfulTasks / denom,
        autocorrectedBestRuns,
        editAutocorrectRate,
        timeoutRuns,
        totalTimeoutRetries,
        totalZeroToolRetries,
        totalProviderFailureRetries,
        ghostRuns,
        transportFailureRuns,
        mutationIntentMatchRate,
        editFailureCategories,
        hashlineEditSubtypes,
    };
    return {
        config: params.config,
        tasks: taskResults,
        summary,
        startTime: params.startTime,
        endTime,
    };
}
export async function runBenchmark(tasks, config, onProgress, onResultSnapshot) {
    const startTime = new Date().toISOString();
    // Discover shared infrastructure once for in-process mode
    const useInProcess = config.inProcess !== false;
    const shared = useInProcess
        ? await discoverSharedInfra({
            editVariant: config.editVariant,
            editFuzzy: config.editFuzzy,
            editFuzzyThreshold: config.editFuzzyThreshold,
        })
        : undefined;
    try {
        const runsPerTask = Math.max(1, Math.floor(config.runsPerTask));
        const taskQueue = shuffle(tasks.slice());
        const resultsByTask = new Map();
        const concurrency = Math.max(1, Math.floor(config.taskConcurrency));
        const recordResult = (task, result) => {
            const list = resultsByTask.get(task.id) ?? [];
            list.push(result);
            resultsByTask.set(task.id, list);
            onResultSnapshot?.(buildBenchmarkResult({ tasks, config, resultsByTask, startTime }));
        };
        // Each worker takes one task at a time and launches all N runs for that
        // task concurrently. The best run is chosen later via summarizeTaskRuns;
        // taskConcurrency caps the number of in-flight tasks (not runs).
        const runTaskAllRuns = async (task) => {
            const items = Array.from({ length: runsPerTask }, (_, runIndex) => ({ task, runIndex }));
            await Promise.all(items.map(async (item) => {
                const { result } = await runConcurrentBenchmarkRun(item, config, onProgress, shared);
                recordResult(task, result);
            }));
        };
        const worker = async () => {
            while (true) {
                const task = taskQueue.shift();
                if (!task)
                    return;
                await runTaskAllRuns(task);
            }
        };
        const slots = Math.min(concurrency, taskQueue.length);
        const running = [];
        for (let i = 0; i < slots; i++) {
            running.push(worker());
        }
        await Promise.all(running);
        return buildBenchmarkResult({ tasks, config, resultsByTask, startTime });
    }
    finally {
        shared?.authStorage.close();
    }
}
