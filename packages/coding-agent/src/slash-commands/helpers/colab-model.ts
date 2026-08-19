import type { Server } from "bun";
import { kNoAuth } from "../../config/model-registry";
import type { SlashCommandRuntime } from "../types";

const DEFAULT_SESSION_NAME = "ompk-colab-model";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 8_192;
const DEFAULT_REMOTE_PORT = 8_081;
const RUNTIME_PROVIDER = "llama.cpp";
const RUNTIME_SOURCE_ID = "builtin://colab-model";
const PROGRESS_PREFIX = "__OMPK_COLAB_PROGRESS__";
const READY_PREFIX = "__OMPK_COLAB_READY__";
const HTTP_PREFIX = "__OMPK_COLAB_HTTP__";
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;

export type ColabAccelerator = "T4" | "L4" | "A100" | "H100" | "G4";

export interface ColabAcceleratorProfile {
	cmakeArchitecture: string;
	modelSizeBudget: number;
	preferredQuantizations: readonly string[];
}

const ACCELERATOR_PROFILES: Record<ColabAccelerator, ColabAcceleratorProfile> = {
	T4: {
		cmakeArchitecture: "75-real",
		modelSizeBudget: 12_000_000_000,
		preferredQuantizations: ["Q3_K_M", "Q3_K_S", "IQ4_XS", "Q4_K_S", "Q4_K_M"],
	},
	L4: {
		cmakeArchitecture: "89-real",
		modelSizeBudget: 18_000_000_000,
		preferredQuantizations: ["Q4_K_M", "Q4_K_S", "IQ4_XS", "Q3_K_M", "Q3_K_S", "Q5_K_M"],
	},
	A100: {
		cmakeArchitecture: "80-real",
		modelSizeBudget: 28_000_000_000,
		preferredQuantizations: ["Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M", "Q4_K_S", "Q8_0"],
	},
	H100: {
		cmakeArchitecture: "90-real",
		modelSizeBudget: 60_000_000_000,
		preferredQuantizations: ["Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M"],
	},
	G4: {
		cmakeArchitecture: "120-real",
		modelSizeBudget: 72_000_000_000,
		preferredQuantizations: ["Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M"],
	},
};

const AUTOMATIC_ACCELERATORS: readonly ColabAccelerator[] = ["T4", "L4", "A100"];

export function getColabAcceleratorProfile(accelerator: ColabAccelerator): ColabAcceleratorProfile {
	return ACCELERATOR_PROFILES[accelerator];
}

export interface HuggingFaceModelReference {
	repoId: string;
	revision: string;
	file?: string;
}

export interface HuggingFaceTreeEntry {
	type: "file";
	path: string;
	size: number;
}

export interface GgufArtifact {
	files: string[];
	primaryFile: string;
	quantization: string;
	totalSize: number;
}

export interface ColabModelLaunchResult {
	accelerator: ColabAccelerator;
	apiBaseUrl: string;
	contextWindow: number;
	maxTokens: number;
	modelId: string;
	modelName: string;
	quantization: string;
	repoId: string;
	sessionName: string;
}

export interface ColabModelCommandRequest {
	accelerator?: ColabAccelerator;
	modelReference: string;
}

interface CommandResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

interface RemoteReadyPayload {
	contextWindow: number;
	modelId: string;
	modelName: string;
	port: number;
}

interface HttpMetadata {
	headers?: Record<string, string>;
	status: number;
}

interface ColabModelLaunchOptions {
	accelerator?: ColabAccelerator;
	fetch?: typeof globalThis.fetch;
	sessionName?: string;
}

type StatusEmitter = (message: string) => Promise<void> | void;

let activeBridge: Server<undefined> | undefined;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function encodeRepoPath(repoId: string): string {
	return repoId
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");
}

function parseRepoId(value: string): { repoId: string; revision: string } {
	const revisionSeparator = value.lastIndexOf("@");
	const repoId = (revisionSeparator > 0 ? value.slice(0, revisionSeparator) : value).replace(/^\/+|\/+$/g, "");
	const revision = revisionSeparator > 0 ? value.slice(revisionSeparator + 1) : "main";
	const segments = repoId.split("/");
	if (segments.length !== 2 || segments.some(segment => segment.length === 0)) {
		throw new Error(`Expected a Hugging Face model id like owner/repository, received "${value}".`);
	}
	if (!revision) {
		throw new Error("The Hugging Face revision after @ cannot be empty.");
	}
	return { repoId, revision };
}

export function parseHuggingFaceModelReference(input: string): HuggingFaceModelReference {
	const value = input.trim();
	if (!value) {
		throw new Error("A Hugging Face model id or URL is required.");
	}

	if (!/^https?:\/\//i.test(value)) {
		return parseRepoId(value);
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid Hugging Face URL: ${value}`);
	}
	if (url.hostname !== "huggingface.co" && url.hostname !== "www.huggingface.co") {
		throw new Error(`Expected a huggingface.co URL, received ${url.hostname}.`);
	}
	const segments = url.pathname
		.split("/")
		.filter(Boolean)
		.map(segment => decodeURIComponent(segment));
	if (segments.length < 2) {
		throw new Error(`Hugging Face URL does not identify a model repository: ${value}`);
	}
	const repoId = `${segments[0]}/${segments[1]}`;
	if (segments.length === 2) {
		return { repoId, revision: "main" };
	}
	const view = segments[2];
	if (view === "blob" || view === "resolve") {
		if (segments.length < 5) {
			throw new Error(`Hugging Face file URL is missing a GGUF path: ${value}`);
		}
		const file = segments.slice(4).join("/");
		if (!file.toLowerCase().endsWith(".gguf")) {
			throw new Error(`Hugging Face file URL must point to a .gguf file: ${value}`);
		}
		return { repoId, revision: segments[3], file };
	}
	if (view === "tree") {
		return { repoId, revision: segments[3] || "main" };
	}
	throw new Error(`Unsupported Hugging Face model URL: ${value}`);
}

function normalizeAccelerator(value: string): ColabAccelerator {
	const normalized = value.toUpperCase();
	if (normalized in ACCELERATOR_PROFILES) return normalized as ColabAccelerator;
	throw new Error(`Unsupported Colab GPU "${value}". Choose T4, L4, A100, H100, or G4.`);
}

export function parseColabModelCommandArgs(input: string): ColabModelCommandRequest {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const modelTokens: string[] = [];
	let accelerator: ColabAccelerator | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--gpu") {
			const value = tokens[index + 1];
			if (!value) throw new Error("--gpu requires T4, L4, A100, H100, or G4.");
			accelerator = normalizeAccelerator(value);
			index += 1;
			continue;
		}
		if (token.startsWith("--gpu=")) {
			accelerator = normalizeAccelerator(token.slice("--gpu=".length));
			continue;
		}
		if (token.startsWith("--")) throw new Error(`Unknown /colab-model option "${token}".`);
		modelTokens.push(token);
	}
	if (modelTokens.length > 1) {
		throw new Error("Expected one Hugging Face model id or URL.");
	}
	return { accelerator, modelReference: modelTokens[0] ?? "" };
}

function isTreeEntry(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export async function fetchHuggingFaceGgufs(
	reference: HuggingFaceModelReference,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<HuggingFaceTreeEntry[]> {
	const treeUrl = new URL(
		`https://huggingface.co/api/models/${encodeRepoPath(reference.repoId)}/tree/${encodeURIComponent(reference.revision)}`,
	);
	treeUrl.searchParams.set("recursive", "true");
	treeUrl.searchParams.set("expand", "false");
	treeUrl.searchParams.set("limit", "1000");
	const response = await fetchImpl(treeUrl, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(
			`Hugging Face returned ${response.status} while listing ${reference.repoId}@${reference.revision}. Public GGUF repositories are supported; gated repositories are not forwarded credentials.`,
		);
	}
	const payload: unknown = await response.json();
	if (!Array.isArray(payload)) {
		throw new Error(`Hugging Face returned an invalid file listing for ${reference.repoId}.`);
	}
	const entries: HuggingFaceTreeEntry[] = [];
	for (const value of payload) {
		if (!isTreeEntry(value) || value.type !== "file" || typeof value.path !== "string") continue;
		if (!value.path.toLowerCase().endsWith(".gguf")) continue;
		entries.push({
			type: "file",
			path: value.path,
			size: typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0,
		});
	}
	if (entries.length === 0) {
		throw new Error(`${reference.repoId}@${reference.revision} does not contain any GGUF files.`);
	}
	return entries;
}

function splitGroupKey(file: string): string {
	return file.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "-SPLIT");
}

function extractQuantization(file: string): string {
	const match = file.toUpperCase().match(/(?:^|[-_.])(IQ\d(?:_[A-Z0-9]+)+|Q\d(?:_[A-Z0-9]+)+|BF16|F16)(?:[-_.]|$)/);
	return match?.[1] ?? "UNKNOWN";
}

function isPrimaryModelFile(file: string): boolean {
	const lower = file.toLowerCase();
	return (
		!lower.includes("mmproj") && !lower.includes("-mtp") && !lower.includes("draft") && !lower.includes("speculative")
	);
}

export function selectGgufArtifact(
	entries: readonly HuggingFaceTreeEntry[],
	reference: HuggingFaceModelReference,
	accelerator: ColabAccelerator,
): GgufArtifact {
	const byGroup = new Map<string, HuggingFaceTreeEntry[]>();
	for (const entry of entries) {
		const groupKey = splitGroupKey(entry.path);
		const group = byGroup.get(groupKey) ?? [];
		group.push(entry);
		byGroup.set(groupKey, group);
	}

	const toArtifact = (group: HuggingFaceTreeEntry[]): GgufArtifact => {
		const sorted = [...group].sort((left, right) => left.path.localeCompare(right.path));
		return {
			files: sorted.map(entry => entry.path),
			primaryFile: sorted[0].path,
			quantization: extractQuantization(sorted[0].path),
			totalSize: sorted.reduce((total, entry) => total + entry.size, 0),
		};
	};

	if (reference.file) {
		const exact = entries.find(entry => entry.path === reference.file);
		if (!exact) {
			throw new Error(`${reference.file} was not found in ${reference.repoId}@${reference.revision}.`);
		}
		return toArtifact(byGroup.get(splitGroupKey(exact.path)) ?? [exact]);
	}

	const artifacts = [...byGroup.values()].filter(group => isPrimaryModelFile(group[0].path)).map(toArtifact);
	const profile = getColabAcceleratorProfile(accelerator);
	const fitting = artifacts.filter(
		artifact => artifact.totalSize === 0 || artifact.totalSize <= profile.modelSizeBudget,
	);
	if (fitting.length === 0) {
		const smallest = artifacts.reduce<GgufArtifact | undefined>(
			(current, artifact) => (!current || artifact.totalSize < current.totalSize ? artifact : current),
			undefined,
		);
		throw new Error(
			`No GGUF in ${reference.repoId} fits the ${accelerator} launch budget (${Math.round(profile.modelSizeBudget / 1_000_000_000)} GB). Smallest candidate is ${smallest ? `${(smallest.totalSize / 1_000_000_000).toFixed(1)} GB` : "unknown"}. Pass a direct GGUF file URL to override automatic selection.`,
		);
	}
	const preferred = profile.preferredQuantizations;
	fitting.sort((left, right) => {
		const leftRank = preferred.indexOf(left.quantization);
		const rightRank = preferred.indexOf(right.quantization);
		const normalizedLeftRank = leftRank === -1 ? preferred.length : leftRank;
		const normalizedRightRank = rightRank === -1 ? preferred.length : rightRank;
		if (normalizedLeftRank !== normalizedRightRank) return normalizedLeftRank - normalizedRightRank;
		return right.totalSize - left.totalSize;
	});
	return fitting[0];
}

export function selectAutomaticColabAccelerators(
	entries: readonly HuggingFaceTreeEntry[],
	reference: HuggingFaceModelReference,
): ColabAccelerator[] {
	return AUTOMATIC_ACCELERATORS.filter(accelerator => {
		try {
			selectGgufArtifact(entries, reference, accelerator);
			return true;
		} catch {
			return false;
		}
	});
}

export function buildColabCommand(args: readonly string[], platform = process.platform): string[] {
	const override = Bun.env.OMPK_COLAB_CLI?.trim();
	if (override) return [override, ...args];
	return platform === "win32" ? ["wsl", "colab", ...args] : ["colab", ...args];
}

async function readCommandStream(
	stream: ReadableStream<Uint8Array>,
	onChunk?: (chunk: string) => Promise<void> | void,
): Promise<string> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let output = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		if (output.length < MAX_COMMAND_OUTPUT) {
			output += chunk.slice(0, MAX_COMMAND_OUTPUT - output.length);
		}
		await onChunk?.(chunk);
	}
	const final = decoder.decode();
	if (output.length < MAX_COMMAND_OUTPUT) output += final.slice(0, MAX_COMMAND_OUTPUT - output.length);
	if (final) await onChunk?.(final);
	return output;
}

async function runCommand(
	args: readonly string[],
	options: {
		input?: string;
		onStdout?: (chunk: string) => Promise<void> | void;
		timeoutMs: number;
	},
): Promise<CommandResult> {
	const processHandle = Bun.spawn({
		cmd: buildColabCommand(args),
		stdin: options.input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (options.input !== undefined) {
		const stdin = processHandle.stdin;
		if (!stdin) throw new Error("Colab command stdin pipe was not created.");
		stdin.write(options.input);
		stdin.end();
	}
	const timeout = setTimeout(() => processHandle.kill(), options.timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			readCommandStream(processHandle.stdout, options.onStdout),
			readCommandStream(processHandle.stderr),
			processHandle.exited,
		]);
		return { exitCode, stderr, stdout };
	} finally {
		clearTimeout(timeout);
	}
}

function parseAccelerator(output: string): ColabAccelerator | undefined {
	for (const accelerator of Object.keys(ACCELERATOR_PROFILES) as ColabAccelerator[]) {
		if (new RegExp(`\\b${accelerator}\\b`, "i").test(output)) return accelerator;
	}
	return undefined;
}

async function ensureColabSession(
	sessionName: string,
	accelerators: readonly ColabAccelerator[],
	requestedAccelerator: ColabAccelerator | undefined,
	emit: StatusEmitter,
): Promise<ColabAccelerator> {
	const status = await runCommand(["status", "--session", sessionName], { timeoutMs: 60_000 });
	const existingAccelerator =
		status.exitCode === 0 ? parseAccelerator(`${status.stdout}\n${status.stderr}`) : undefined;
	if (existingAccelerator) {
		if (requestedAccelerator && existingAccelerator !== requestedAccelerator) {
			throw new Error(
				`${sessionName} is already using ${existingAccelerator}; stop it before requesting ${requestedAccelerator}.`,
			);
		}
		await emit(`Colab: reusing ${sessionName} on ${existingAccelerator}.`);
		return existingAccelerator;
	}

	let lastFailure = "";
	for (const accelerator of accelerators) {
		await emit(`Colab: requesting ${accelerator} runtime…`);
		const launch = await runCommand(["new", "--session", sessionName, "--gpu", accelerator], {
			timeoutMs: 5 * 60_000,
		});
		if (launch.exitCode === 0) {
			return parseAccelerator(`${launch.stdout}\n${launch.stderr}`) ?? accelerator;
		}
		lastFailure = launch.stderr || launch.stdout;
		const recoveredStatus = await runCommand(["status", "--session", sessionName], { timeoutMs: 60_000 });
		const recoveredAccelerator =
			recoveredStatus.exitCode === 0
				? parseAccelerator(`${recoveredStatus.stdout}\n${recoveredStatus.stderr}`)
				: undefined;
		if (recoveredAccelerator) {
			if (requestedAccelerator && recoveredAccelerator !== requestedAccelerator) {
				throw new Error(
					`${sessionName} is already using ${recoveredAccelerator}; stop it before requesting ${requestedAccelerator}.`,
				);
			}
			return recoveredAccelerator;
		}
	}
	throw new Error(
		`Could not acquire a ${accelerators.join(", ")} Colab runtime${lastFailure ? `: ${lastFailure}` : "."}`,
	);
}

function pythonJson(value: unknown): string {
	return JSON.stringify(JSON.stringify(value));
}

function buildRemoteSetupScript(config: {
	accelerator: ColabAccelerator;
	artifact: GgufArtifact;
	contextWindow: number;
	reference: HuggingFaceModelReference;
	remotePort: number;
}): string {
	const payload = {
		accelerator: config.accelerator,
		cmakeArchitecture: getColabAcceleratorProfile(config.accelerator).cmakeArchitecture,
		contextWindow: config.contextWindow,
		files: config.artifact.files,
		primaryFile: config.artifact.primaryFile,
		quantization: config.artifact.quantization,
		remotePort: config.remotePort,
		repoId: config.reference.repoId,
		revision: config.reference.revision,
	};
	return `import json
from concurrent.futures import ThreadPoolExecutor
import os
import signal
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = json.loads(${pythonJson(payload)})
PROGRESS_PREFIX = ${JSON.stringify(PROGRESS_PREFIX)}
READY_PREFIX = ${JSON.stringify(READY_PREFIX)}
LLAMA_DIR = Path("/content/llama.cpp")
MODEL_ROOT = Path("/content/ompk-models")
PID_FILE = Path("/content/ompk-colab-model.pid")
LOG_FILE = Path("/content/ompk-colab-model.log")
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"


def progress(message):
    print(PROGRESS_PREFIX + json.dumps({"message": message}), flush=True)


def run(args, cwd=None):
    completed = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if completed.returncode != 0:
        tail = "\\n".join(completed.stdout.splitlines()[-80:])
        raise RuntimeError(f"Command failed ({completed.returncode}): {' '.join(args)}\\n{tail}")


def request_json(url, payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {} if payload is None else {"Content-Type": "application/json"}
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def announce_ready(model_id, primary_name, base_url):
    context_window = CONFIG["contextWindow"]
    try:
        props = request_json(base_url + "/props")
        context_window = int(props.get("default_generation_settings", {}).get("n_ctx", context_window))
    except (OSError, urllib.error.URLError, ValueError, TypeError, json.JSONDecodeError):
        pass
    progress("warming model with a generation request")
    warmup = request_json(base_url + "/v1/chat/completions", {
        "model": model_id,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "temperature": 0,
        "max_tokens": 16,
        "chat_template_kwargs": {"enable_thinking": False},
    }, timeout=300)
    if not warmup.get("choices"):
        raise RuntimeError("Warmup request returned no completion choices")
    print(READY_PREFIX + json.dumps({
        "contextWindow": context_window,
        "modelId": model_id,
        "modelName": Path(primary_name).stem,
        "port": CONFIG["remotePort"],
    }), flush=True)


def resolve_model_path(primary_name, required_names):
    for root in (MODEL_ROOT, Path("/content/models")):
        if not root.exists():
            continue
        for candidate in root.rglob(primary_name):
            if candidate.is_file() and all((candidate.parent / name).is_file() for name in required_names):
                progress(f"reusing downloaded {primary_name}")
                return candidate
    progress(f"downloading {CONFIG['repoId']} {CONFIG['quantization']}")
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        run([sys.executable, "-m", "pip", "install", "--quiet", "huggingface_hub"])
        from huggingface_hub import snapshot_download
    model_dir = MODEL_ROOT / CONFIG["repoId"].replace("/", "--")
    snapshot_download(
        repo_id=CONFIG["repoId"],
        revision=CONFIG["revision"],
        allow_patterns=CONFIG["files"],
        local_dir=str(model_dir),
    )
    model_path = model_dir / CONFIG["primaryFile"]
    if not model_path.is_file():
        raise FileNotFoundError(model_path)
    return model_path


progress("checking CUDA runtime")
run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"])
primary_name = Path(CONFIG["primaryFile"]).name
required_names = [Path(name).name for name in CONFIG["files"]]
base_url = f"http://127.0.0.1:{CONFIG['remotePort']}"
models_payload = None
try:
    models_payload = request_json(base_url + "/v1/models", timeout=5)
except (OSError, urllib.error.URLError, json.JSONDecodeError):
    pass
running_ids = [item.get("id", "") for item in (models_payload or {}).get("data", []) if isinstance(item, dict)]
matching_names = {primary_name, Path(primary_name).stem}
matching_id = next((model_id for model_id in running_ids if Path(model_id).name in matching_names), None)
if matching_id is not None:
    progress(f"reusing running {Path(primary_name).stem}")
    announce_ready(matching_id, primary_name, base_url)
    raise SystemExit(0)

with ThreadPoolExecutor(max_workers=1) as executor:
    model_future = executor.submit(resolve_model_path, primary_name, required_names)
    server = LLAMA_DIR / "build" / "bin" / "llama-server"
    if server.is_file():
        progress("reusing CUDA llama-server")
    else:
        if not LLAMA_DIR.exists():
            progress("cloning llama.cpp")
            run(["git", "clone", "--depth", "1", "https://github.com/ggml-org/llama.cpp.git", str(LLAMA_DIR)])
        else:
            progress("updating llama.cpp")
            run(["git", "pull", "--ff-only"], cwd=LLAMA_DIR)
        progress("building CUDA llama-server")
        build_dir = LLAMA_DIR / "build"
        configure = [
            "cmake", "-S", str(LLAMA_DIR), "-B", str(build_dir),
            "-DGGML_CUDA=ON", f"-DCMAKE_CUDA_ARCHITECTURES={CONFIG['cmakeArchitecture']}",
            "-DCMAKE_BUILD_TYPE=Release", "-DLLAMA_CURL=OFF",
        ]
        if shutil.which("ninja") and not (build_dir / "CMakeCache.txt").exists():
            configure.extend(["-G", "Ninja"])
        run(configure)
        run([
            "cmake", "--build", str(build_dir), "--config", "Release",
            "--parallel", str(max(2, os.cpu_count() or 2)), "--target", "llama-server",
        ])
    model_path = model_future.result()

if matching_id is None:
    if PID_FILE.exists():
        try:
            os.kill(int(PID_FILE.read_text().strip()), signal.SIGTERM)
            time.sleep(2)
        except (ProcessLookupError, ValueError):
            pass
    subprocess.run(["fuser", "-k", f"{CONFIG['remotePort']}/tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    alias = Path(primary_name).stem
    progress(f"loading {alias} on the GPU")
    log_handle = LOG_FILE.open("w", buffering=1)
    server_process = subprocess.Popen([
        str(server), "--model", str(model_path), "--alias", alias,
        "--host", "127.0.0.1", "--port", str(CONFIG["remotePort"]),
        "--ctx-size", str(CONFIG["contextWindow"]), "--n-gpu-layers", "99",
        "--flash-attn", "on", "--jinja", "--parallel", "1", "--metrics",
    ], stdout=log_handle, stderr=subprocess.STDOUT, start_new_session=True)
    PID_FILE.write_text(str(server_process.pid))
    for attempt in range(180):
        if server_process.poll() is not None:
            log_handle.close()
            tail = "\\n".join(LOG_FILE.read_text(errors="replace").splitlines()[-80:])
            raise RuntimeError(f"llama-server exited with {server_process.returncode}:\\n{tail}")
        try:
            health = request_json(base_url + "/health", timeout=3)
            if health.get("status") == "ok":
                break
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            pass
        time.sleep(5)
    else:
        server_process.terminate()
        raise TimeoutError("llama-server did not become healthy within 15 minutes")

models_payload = request_json(base_url + "/v1/models")
model_items = models_payload.get("data", [])
if not model_items or not isinstance(model_items[0], dict) or not model_items[0].get("id"):
    raise RuntimeError("llama-server did not advertise a model id")
model_id = model_items[0]["id"]
announce_ready(model_id, primary_name, base_url)
`;
}

function parseMarkedJson<T>(output: string, prefix: string): T | undefined {
	for (const line of output.split(/\r?\n/)) {
		if (!line.startsWith(prefix)) continue;
		try {
			return JSON.parse(line.slice(prefix.length)) as T;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function createProgressParser(emit: StatusEmitter): (chunk: string) => Promise<void> {
	let buffered = "";
	return async chunk => {
		buffered += chunk;
		const lines = buffered.split(/\r?\n/);
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			const payload = parseMarkedJson<{ message?: string }>(line, PROGRESS_PREFIX);
			if (payload?.message) await emit(`Colab: ${payload.message}…`);
		}
	};
}

function buildRemoteHttpScript(config: {
	bodyBase64: string;
	headers: Record<string, string>;
	method: string;
	path: string;
	remotePort: number;
}): string {
	return `import base64
import json
import sys
import urllib.error
import urllib.request

CONFIG = json.loads(${pythonJson(config)})
HTTP_PREFIX = ${JSON.stringify(HTTP_PREFIX)}
url = f"http://127.0.0.1:{CONFIG['remotePort']}" + CONFIG["path"]
data = base64.b64decode(CONFIG["bodyBase64"]) if CONFIG["bodyBase64"] else None
request = urllib.request.Request(url, data=data, headers=CONFIG["headers"], method=CONFIG["method"])
try:
    response = urllib.request.urlopen(request, timeout=900)
except urllib.error.HTTPError as error:
    response = error
metadata = {
    "status": response.status,
    "headers": {
        "content-type": response.headers.get("content-type", "application/json"),
        "cache-control": response.headers.get("cache-control", "no-cache"),
    },
}
print(HTTP_PREFIX + json.dumps(metadata), flush=True)
content_type = response.headers.get("content-type", "")
if "text/event-stream" in content_type:
    while True:
        line = response.readline()
        if not line:
            break
        print(line.decode("utf-8", errors="replace"), end="", flush=True)
else:
    print(response.read().decode("utf-8", errors="replace"), end="", flush=True)
`;
}

interface ByteStreamReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

async function readHttpMetadata(reader: ByteStreamReader): Promise<{ metadata: HttpMetadata; remainder: Uint8Array }> {
	const decoder = new TextDecoder();
	let buffered = "";
	while (!buffered.includes("\n")) {
		const { done, value } = await reader.read();
		if (done || !value) throw new Error("Colab bridge closed before returning HTTP metadata.");
		buffered += decoder.decode(value, { stream: true });
		if (buffered.length > 32_768) throw new Error("Colab bridge returned an oversized HTTP prelude.");
	}
	const newline = buffered.indexOf("\n");
	const metadataLine = buffered.slice(0, newline).replace(/\r$/, "");
	const metadata = parseMarkedJson<HttpMetadata>(metadataLine, HTTP_PREFIX);
	if (!metadata || !Number.isInteger(metadata.status)) {
		throw new Error(`Colab bridge returned invalid HTTP metadata: ${metadataLine}`);
	}
	return { metadata, remainder: new TextEncoder().encode(buffered.slice(newline + 1)) };
}

async function proxyToColab(request: Request, sessionName: string, remotePort: number): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204 });
	const url = new URL(request.url);
	const body =
		request.method === "GET" || request.method === "HEAD"
			? new Uint8Array()
			: new Uint8Array(await request.arrayBuffer());
	const headers: Record<string, string> = {};
	const contentType = request.headers.get("content-type");
	const accept = request.headers.get("accept");
	if (contentType) headers["Content-Type"] = contentType;
	if (accept) headers.Accept = accept;
	const script = buildRemoteHttpScript({
		bodyBase64: body.toBase64(),
		headers,
		method: request.method,
		path: `${url.pathname}${url.search}`,
		remotePort,
	});
	const processHandle = Bun.spawn({
		cmd: buildColabCommand(["exec", "--session", sessionName, "--timeout", "1200"]),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	processHandle.stdin.write(script);
	processHandle.stdin.end();
	const stderrPromise = new Response(processHandle.stderr).text();
	const reader = processHandle.stdout.getReader();
	try {
		const { metadata, remainder } = await readHttpMetadata(reader);
		const bodyStream = new ReadableStream<Uint8Array>({
			start(controller) {
				if (remainder.length > 0) controller.enqueue(remainder);
				void (async () => {
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							controller.enqueue(value);
						}
						const exitCode = await processHandle.exited;
						if (exitCode !== 0) {
							const stderr = await stderrPromise;
							controller.error(new Error(stderr || `Colab bridge exited with code ${exitCode}.`));
							return;
						}
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				})();
			},
			cancel() {
				processHandle.kill();
			},
		});
		return new Response(bodyStream, { status: metadata.status, headers: metadata.headers });
	} catch (error) {
		processHandle.kill();
		const stderr = await stderrPromise;
		return Response.json(
			{ error: { message: `${errorMessage(error)}${stderr ? `\n${stderr}` : ""}`, type: "colab_bridge_error" } },
			{ status: 502 },
		);
	}
}

function startOpenAiBridge(sessionName: string, remotePort: number): string {
	activeBridge?.stop(true);
	activeBridge = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => proxyToColab(request, sessionName, remotePort),
	});
	return `http://127.0.0.1:${activeBridge.port}/v1`;
}

export async function launchColabModel(
	modelReference: string,
	emit: StatusEmitter,
	options: ColabModelLaunchOptions = {},
): Promise<ColabModelLaunchResult> {
	const reference = parseHuggingFaceModelReference(modelReference);
	await emit(`Colab: resolving ${reference.repoId}@${reference.revision}…`);
	const entries = await fetchHuggingFaceGgufs(reference, options.fetch);
	const sessionName = options.sessionName ?? (Bun.env.OMPK_COLAB_SESSION?.trim() || DEFAULT_SESSION_NAME);
	const acquisitionCandidates = options.accelerator
		? [options.accelerator]
		: selectAutomaticColabAccelerators(entries, reference);
	if (acquisitionCandidates.length === 0) {
		throw new Error(
			`No GGUF in ${reference.repoId} fits an automatic T4, L4, or A100 launch. Pass --gpu H100 or --gpu G4, or use a smaller GGUF.`,
		);
	}
	let accelerator = await ensureColabSession(sessionName, acquisitionCandidates, options.accelerator, emit);
	let artifact = selectGgufArtifact(entries, reference, accelerator);
	let ready: RemoteReadyPayload | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await emit(
			`Colab: selected ${artifact.quantization} (${artifact.totalSize > 0 ? `${(artifact.totalSize / 1_000_000_000).toFixed(1)} GB` : "size unknown"}) for ${accelerator}.`,
		);
		const setup = await runCommand(["exec", "--session", sessionName, "--timeout", "3600"], {
			input: buildRemoteSetupScript({
				accelerator,
				artifact,
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				reference,
				remotePort: DEFAULT_REMOTE_PORT,
			}),
			onStdout: createProgressParser(emit),
			timeoutMs: 60 * 60_000,
		});
		if (setup.exitCode === 0) {
			ready = parseMarkedJson<RemoteReadyPayload>(setup.stdout, READY_PREFIX);
			if (!ready?.modelId || !ready.port) {
				throw new Error(`Colab setup completed without a readiness result: ${setup.stdout || setup.stderr}`);
			}
			break;
		}
		const failure = setup.stderr || setup.stdout;
		if (attempt === 0 && /appears to be lost|session .* not found|\b40[14]\b/i.test(failure)) {
			await emit("Colab: stale runtime expired; acquiring a replacement…");
			accelerator = await ensureColabSession(sessionName, acquisitionCandidates, options.accelerator, emit);
			artifact = selectGgufArtifact(entries, reference, accelerator);
			continue;
		}
		throw new Error(`Colab setup failed: ${failure}`);
	}
	if (!ready) throw new Error("Colab setup did not produce a ready model.");
	await emit("Colab: opening private localhost API bridge…");
	const apiBaseUrl = startOpenAiBridge(sessionName, ready.port);
	return {
		accelerator,
		apiBaseUrl,
		contextWindow: ready.contextWindow || DEFAULT_CONTEXT_WINDOW,
		maxTokens: Math.min(DEFAULT_MAX_TOKENS, ready.contextWindow || DEFAULT_CONTEXT_WINDOW),
		modelId: ready.modelId,
		modelName: ready.modelName,
		quantization: artifact.quantization,
		repoId: reference.repoId,
		sessionName,
	};
}

export async function handleColabModelSlashCommand(
	args: string,
	runtime: SlashCommandRuntime,
	launch: typeof launchColabModel = launchColabModel,
): Promise<{ consumed: true }> {
	try {
		const request = parseColabModelCommandArgs(args);
		if (!request.modelReference) {
			await runtime.output(
				"Usage: /colab-model [--gpu T4|L4|A100|H100|G4] <owner/repository | huggingface.co model or GGUF URL>\nExample: /colab-model --gpu L4 unsloth/Qwen3.8-27B-GGUF",
			);
			return { consumed: true };
		}
		const result = await launch(request.modelReference, message => runtime.output(message), {
			accelerator: request.accelerator,
		});
		runtime.session.modelRegistry.registerProvider(
			RUNTIME_PROVIDER,
			{
				baseUrl: result.apiBaseUrl,
				apiKey: kNoAuth,
				api: "openai-completions",
				compat: {
					thinkingFormat: "qwen-chat-template",
					reasoningDisableMode: "qwen-template-false",
					qwenPreserveThinking: true,
				},
				models: [
					{
						id: result.modelId,
						name: `${result.modelName} · Colab ${result.accelerator}`,
						reasoning: /qwen3(?:[._-]|$)|deepseek-r1|gpt-oss|reasoning|thinking/i.test(
							`${result.repoId}/${result.modelName}`,
						),
						input: ["text"],
						supportsTools: true,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: result.contextWindow,
						maxTokens: result.maxTokens,
					},
				],
			},
			RUNTIME_SOURCE_ID,
		);
		const model = runtime.session.modelRegistry.find(RUNTIME_PROVIDER, result.modelId);
		if (!model) {
			throw new Error(`Registered model ${RUNTIME_PROVIDER}/${result.modelId} was not found.`);
		}
		await runtime.session.setModel(model);
		await runtime.notifyTitleChanged?.();
		await runtime.notifyConfigChanged?.();
		await runtime.output(
			[
				`Colab model ready: ${RUNTIME_PROVIDER}/${result.modelId}`,
				`${result.repoId} ${result.quantization} on ${result.accelerator}`,
				`OpenAI-compatible API: ${result.apiBaseUrl}`,
				`Runtime: ${result.sessionName} (stop with: colab stop --session ${result.sessionName})`,
			].join("\n"),
		);
	} catch (error) {
		await runtime.output(`Colab model launch failed: ${errorMessage(error)}`);
	}
	return { consumed: true };
}
