import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";

const RUST_FRAMEWORKS: readonly (readonly [string, string])[] = [
	["axum", "Axum"],
	["actix-web", "Actix Web"],
	["rocket", "Rocket"],
	["warp", "Warp"],
	["tide", "Tide"],
	["poem", "Poem"],
	["tower-http", "Tower HTTP"],
	["hyper", "Hyper"],
	["tokio", "Tokio async runtime"],
	["bevy", "Bevy game engine"],
	["iced", "Iced GUI"],
	["egui", "egui GUI"],
	["tauri", "Tauri"],
	["leptos", "Leptos"],
	["yew", "Yew"],
	["dioxus", "Dioxus"],
];

const NODE_FRAMEWORKS: readonly (readonly [string, string])[] = [
	["next", "Next.js"],
	["nuxt", "Nuxt"],
	["@angular/core", "Angular"],
	["vue", "Vue"],
	["react", "React"],
	["svelte", "Svelte"],
	["solid-js", "SolidJS"],
	["express", "Express"],
	["fastify", "Fastify"],
	["hono", "Hono"],
	["nestjs", "NestJS"],
	["@nestjs/core", "NestJS"],
	["electron", "Electron"],
	["expo", "Expo"],
	["react-native", "React Native"],
];

const PYTHON_FRAMEWORKS: readonly (readonly [string, string])[] = [
	["fastapi", "FastAPI"],
	["django", "Django"],
	["flask", "Flask"],
	["starlette", "Starlette"],
	["litestar", "Litestar"],
	["sanic", "Sanic"],
	["tornado", "Tornado"],
	["aiohttp", "aiohttp"],
	["pytorch", "PyTorch"],
	["torch", "PyTorch"],
	["tensorflow", "TensorFlow"],
	["jax", "JAX"],
	["transformers", "Hugging Face"],
];

const GO_FRAMEWORKS: readonly (readonly [string, string])[] = [
	["github.com/gin-gonic/gin", "Gin"],
	["github.com/labstack/echo", "Echo"],
	["github.com/gofiber/fiber", "Fiber"],
	["github.com/go-chi/chi", "chi"],
	["github.com/gorilla/mux", "Gorilla Mux"],
	["connectrpc.com/connect", "Connect"],
	["google.golang.org/grpc", "gRPC"],
];

/** Repository language, framework, package manager, and workspace metadata. */
export interface RepositoryContext {
	language?: string;
	framework?: string;
	packageManager?: string;
	isMonorepo: boolean;
	packageCount?: number;
}

/** Detect repository metadata in Rust → Node → Python → Go priority order. */
export async function detectRepositoryContext(root: string): Promise<RepositoryContext> {
	return (
		(await detectRust(root)) ??
		(await detectNode(root)) ??
		(await detectPython(root)) ??
		(await detectGo(root)) ?? { isMonorepo: false }
	);
}

/** Format detected metadata for the conventional analysis prompt. */
export function formatRepositoryContext(context: RepositoryContext): string | null {
	if (!context.language) return null;
	let language = context.language;
	if (context.isMonorepo) {
		language =
			context.packageCount === undefined
				? `${language} (workspace)`
				: `${language} (workspace, ${context.packageCount} packages)`;
	}
	const lines = [`Language: ${language}`];
	if (context.framework) lines.push(`Framework: ${context.framework}`);
	if (context.packageManager) lines.push(`Package manager: ${context.packageManager}`);
	return lines.join("\n");
}

async function detectRust(root: string): Promise<RepositoryContext | null> {
	const manifest = path.join(root, "Cargo.toml");
	const content = await optionalText(manifest);
	if (content === null) return null;
	const data = parseToml(content);
	const workspace = isRecord(data.workspace) ? data.workspace : undefined;
	const context: RepositoryContext = {
		language: "Rust",
		packageManager: "cargo",
		isMonorepo: workspace !== undefined || content.includes("[workspace]"),
		framework: detectFramework(content, RUST_FRAMEWORKS),
	};
	if (workspace && Array.isArray(workspace.members)) context.packageCount = workspace.members.length;
	else if (context.isMonorepo) context.packageCount = countWorkspaceMembers(content);
	return context;
}

async function detectNode(root: string): Promise<RepositoryContext | null> {
	const packageJson = path.join(root, "package.json");
	const content = await optionalText(packageJson);
	if (content === null) return null;
	const data = parseJsonObject(content);
	const dependencies = nodeDependencyNames(data, content);
	const isTypeScript = dependencies.has("typescript") || (await fileExists(path.join(root, "tsconfig.json")));
	let packageManager = "npm";
	if (await fileExists(path.join(root, "pnpm-lock.yaml"))) packageManager = "pnpm";
	else if (await fileExists(path.join(root, "yarn.lock"))) packageManager = "yarn";
	else if ((await fileExists(path.join(root, "bun.lockb"))) || (await fileExists(path.join(root, "bun.lock")))) {
		packageManager = "bun";
	}
	const workspaces = data.workspaces;
	const hasPnpmWorkspace = await fileExists(path.join(root, "pnpm-workspace.yaml"));
	return {
		language: isTypeScript ? "TypeScript" : "JavaScript",
		framework: detectDependencyFramework(dependencies, NODE_FRAMEWORKS),
		packageManager,
		isMonorepo: Boolean(workspaces) || hasPnpmWorkspace,
		packageCount: countNodeWorkspaces(workspaces),
	};
}

async function detectPython(root: string): Promise<RepositoryContext | null> {
	const pyprojectPath = path.join(root, "pyproject.toml");
	const setupPath = path.join(root, "setup.py");
	const requirementsPath = path.join(root, "requirements.txt");
	const [pyproject, setup, requirements] = await Promise.all([
		optionalText(pyprojectPath),
		optionalText(setupPath),
		optionalText(requirementsPath),
	]);
	if (pyproject === null && setup === null && requirements === null) return null;
	const data = pyproject === null ? {} : parseToml(pyproject);
	const tool = isRecord(data.tool) ? data.tool : {};
	let packageManager = "pip";
	if ("poetry" in tool) packageManager = "poetry";
	else if ("uv" in tool || (await fileExists(path.join(root, "uv.lock")))) packageManager = "uv";
	else if ("pdm" in tool || (await fileExists(path.join(root, "pdm.lock")))) packageManager = "pdm";
	else if (await fileExists(path.join(root, "Pipfile"))) packageManager = "pipenv";
	const text = [pyproject, requirements, setup]
		.filter(value => value !== null)
		.join("\n")
		.toLowerCase();
	return {
		language: "Python",
		framework: detectFramework(text, PYTHON_FRAMEWORKS),
		packageManager,
		isMonorepo: pyproject !== null && hasPythonWorkspace(tool),
	};
}

async function detectGo(root: string): Promise<RepositoryContext | null> {
	const content = await optionalText(path.join(root, "go.mod"));
	if (content === null) return null;
	return {
		language: "Go",
		framework: detectFramework(content.toLowerCase(), GO_FRAMEWORKS),
		packageManager: "go mod",
		isMonorepo: false,
	};
}

async function optionalText(filePath: string): Promise<string | null> {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return null;
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	return Bun.file(filePath).exists();
}

function parseToml(content: string): Record<string, unknown> {
	try {
		const value = Bun.TOML.parse(content);
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}

function parseJsonObject(content: string): Record<string, unknown> {
	try {
		const value = JSON.parse(content);
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}

function detectFramework(content: string, frameworks: readonly (readonly [string, string])[]): string | undefined {
	const lower = content.toLowerCase();
	for (const [needle, name] of frameworks) if (lower.includes(needle.toLowerCase())) return name;
	return undefined;
}

function detectDependencyFramework(
	dependencies: ReadonlySet<string>,
	frameworks: readonly (readonly [string, string])[],
): string | undefined {
	for (const [dependency, name] of frameworks) if (dependencies.has(dependency)) return name;
	return undefined;
}

function nodeDependencyNames(data: Record<string, unknown>, fallback: string): Set<string> {
	const dependencies = new Set<string>();
	for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		const values = data[field];
		if (!isRecord(values)) continue;
		for (const key in values) dependencies.add(key);
	}
	if (dependencies.size === 0)
		for (const match of fallback.matchAll(/"([@\w./-]+)"\s*:/g)) if (match[1]) dependencies.add(match[1]);
	return dependencies;
}

function countNodeWorkspaces(workspaces: unknown): number | undefined {
	if (Array.isArray(workspaces)) return workspaces.length;
	if (isRecord(workspaces) && Array.isArray(workspaces.packages)) return workspaces.packages.length;
	return undefined;
}

function countWorkspaceMembers(content: string): number | undefined {
	const match = content.match(/members\s*=\s*\[([^\]]*)\]/s);
	return match?.[1] === undefined ? undefined : [...match[1].matchAll(/"[^"]+"/g)].length;
}

function hasPythonWorkspace(tool: Record<string, unknown>): boolean {
	return (isRecord(tool.uv) && "workspace" in tool.uv) || (isRecord(tool.pdm) && "workspace" in tool.pdm);
}
