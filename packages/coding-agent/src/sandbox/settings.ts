// oxlint-disable no-template-curly-in-string -- literal `${…}` sandbox path tokens
/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 *
 * `sandbox.*` values from a project's config may only tighten containment; see
 * `readSandboxConfig` in `./policy`.
 */
import { parseFlag } from "@oh-my-pi/pi-utils";
import { register } from "../config/registry";
import type { SandboxScope } from "./types";

export const SANDBOX_SCOPES = ["bash", "eval", "exec"] as const satisfies readonly SandboxScope[];

/** Path token for omp's own credential store (`agent.db` under the agent dir, XDG-aware); see `expandSandboxPath`. */
export const SANDBOX_AUTH_DB_TOKEN = "${authDb}";
/** Path token for omp's agent directory, which holds `.env`, `models.yml` and `mcp.json`; see `expandSandboxPath`. */
export const SANDBOX_AGENT_DIR_TOKEN = "${agentDir}";
/** Every `${name}` token `expandSandboxPath` expands. */
const PATH_TOKEN_NAMES: readonly string[] = ["home", "workspace", "tmp", "authDb", "agentDir"];

const DEFAULT_SCOPE: SandboxScope[] = [...SANDBOX_SCOPES];
const EMPTY_STRING_ARRAY: string[] = [];

/**
 * Secret stores no contained process may read. The SQLite sidecars hold not-yet-checkpointed
 * credential rows; the agent dir's `.env`, `models.yml`, `mcp.json` and `.mcp.json` can hold API keys and tokens.
 */
const DEFAULT_DENY_READ: string[] = [
	"~/.ssh",
	"~/.gnupg",
	"~/.aws",
	"~/.azure",
	"~/.config/gcloud",
	"~/.kube",
	"~/.docker",
	"~/.netrc",
	"~/.npmrc",
	"~/.pypirc",
	"~/.git-credentials",
	"~/.config/gh",
	SANDBOX_AUTH_DB_TOKEN,
	`${SANDBOX_AUTH_DB_TOKEN}-wal`,
	`${SANDBOX_AUTH_DB_TOKEN}-shm`,
	`${SANDBOX_AGENT_DIR_TOKEN}/.env`,
	`${SANDBOX_AGENT_DIR_TOKEN}/models.yml`,
	`${SANDBOX_AGENT_DIR_TOKEN}/mcp.json`,
	`${SANDBOX_AGENT_DIR_TOKEN}/.mcp.json`,
];

const DEFAULT_ALLOWED_HOSTS: string[] = [
	"github.com",
	"*.github.com",
	"*.githubusercontent.com",
	"gitlab.com",
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"*.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
];

const PATH_TOKENS_HELP =
	"Entries accept ~, ${home}, ${workspace}, ${tmp}, ${authDb}, ${agentDir}; relative entries resolve against the workspace.";

/**
 * Validator for a JSON list of non-empty strings. With `tokens`, an entry naming any other `${name}`
 * token is rejected, so a typo such as `${HOME}` fails instead of matching nothing.
 */
function stringList(id: string, noun: string, tokens?: readonly string[]): (raw: unknown) => void {
	return raw => {
		if (raw === undefined) return;
		if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string" || entry.trim().length === 0)) {
			throw new Error(`${id} must be a list of ${noun}`);
		}
		if (!tokens) return;
		for (const entry of raw as string[]) {
			for (const [token, name] of entry.matchAll(/\$\{([^}]*)\}/g)) {
				if (!tokens.includes(name)) {
					throw new Error(`${id}: unknown path token ${token} in "${entry}"; known tokens: ${tokens.join(", ")}`);
				}
			}
		}
	};
}

export const cfgSandboxEnabled = register({
	id: "sandbox.enabled",
	type: "boolean",
	default: false,
	// A repository `.env` reaches the environment, so the variable can only turn the sandbox on.
	env: { name: "PI_SANDBOX", parse: raw => (parseFlag(raw) ? true : undefined) },
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "OS Sandbox",
		description:
			"Run agent commands (bash, eval, extension exec) inside an OS sandbox that limits file writes to the workspace, hides secret stores, and filters network access. A project config can turn it on but never off; a truthy $PI_SANDBOX turns it on, any other value is ignored",
	},
});

export const cfgSandboxMode = register({
	id: "sandbox.mode",
	type: "enum",
	values: ["workspace-write", "read-only"] as const,
	default: "workspace-write",
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "Sandbox Mode",
		description: "What contained commands may write",
		options: [
			{
				value: "workspace-write",
				label: "Workspace write",
				description: "Write inside the workspace, a private temp directory, and the extra writable paths.",
			},
			{ value: "read-only", label: "Read-only", description: "Write only to a private temp directory." },
		],
	},
});

export const cfgSandboxScope = register({
	id: "sandbox.scope",
	type: "array",
	default: DEFAULT_SCOPE,
	items: { values: SANDBOX_SCOPES, label: "sandbox scope" },
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "Sandbox Applies To",
		condition: "sandboxScopeNotProject",
		description: "Which agent executors run contained. MCP servers opt in per server with `sandbox: true`",
		options: [
			{ value: "bash", label: "Bash", description: "The bash tool, its builtins, and interactive PTYs" },
			{ value: "eval", label: "Eval", description: "Python and JavaScript eval kernels" },
			{ value: "exec", label: "Exec", description: "Extension, hook, and custom-tool commands" },
		],
	},
});

export const cfgSandboxFallback = register({
	id: "sandbox.fallback",
	type: "enum",
	values: ["warn", "block"] as const,
	default: "warn",
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "If Sandbox Unavailable",
		description: "What happens when the sandbox is enabled but this OS has no usable sandbox backend",
		options: [
			{ value: "warn", label: "Warn", description: "Warn once and run commands unsandboxed." },
			{ value: "block", label: "Block", description: "Fail every command that should run contained." },
		],
	},
});

export const cfgSandboxReadScope = register({
	id: "sandbox.filesystem.readScope",
	type: "enum",
	values: ["all", "workspace"] as const,
	default: "all",
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "Sandbox Read Scope",
		description: "What contained commands may read; denied paths stay unreadable either way",
		options: [
			{
				value: "all",
				label: "Broad",
				description:
					"Top-level system directories except device and virtual trees (Windows: the user profile and tool directories), plus the workspace and extra readable paths.",
			},
			{
				value: "workspace",
				label: "Workspace",
				description: "The workspace, system tools, omp itself, and the extra readable paths.",
			},
		],
	},
});

export const cfgSandboxAllowWrite = register({
	id: "sandbox.filesystem.allowWrite",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	validate: stringList("sandbox.filesystem.allowWrite", "paths", PATH_TOKEN_NAMES),
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "Sandbox Extra Writable Paths",
		condition: "sandboxAllowWriteNotProject",
		editor: "json",
		description: `Extra paths contained commands may write in workspace-write mode. A JSON list of paths, e.g. ["~/.cache"]. ${PATH_TOKENS_HELP}`,
	},
});

export const cfgSandboxAllowRead = register({
	id: "sandbox.filesystem.allowRead",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	validate: stringList("sandbox.filesystem.allowRead", "paths", PATH_TOKEN_NAMES),
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "Sandbox Extra Readable Paths",
		condition: "sandboxAllowReadNotProject",
		editor: "json",
		description: `Extra paths contained commands may read, in either read scope. A JSON list of paths. ${PATH_TOKENS_HELP}`,
	},
});

export const cfgSandboxDenyRead = register({
	id: "sandbox.filesystem.denyRead",
	type: "array",
	default: DEFAULT_DENY_READ,
	validate: stringList("sandbox.filesystem.denyRead", "paths", PATH_TOKEN_NAMES),
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "Sandbox Denied Paths",
		condition: "sandboxDenyReadNotProject",
		editor: "json",
		description: `Paths contained commands can neither read nor write; outranks every other list. Defaults to common secret stores, omp's credential database (\${authDb}) and the key-bearing files in omp's agent directory (\${agentDir}). A JSON list of paths. ${PATH_TOKENS_HELP}`,
	},
});

export const cfgSandboxNetworkMode = register({
	id: "sandbox.network.mode",
	type: "enum",
	values: ["allowlist", "deny", "allow"] as const,
	default: "allowlist",
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "Sandbox Network",
		description: "Network access of contained commands",
		options: [
			{
				value: "allowlist",
				label: "Allowlist",
				description: "Only the allowed hosts, through omp's egress proxy; tools must honour HTTP(S)_PROXY.",
			},
			{ value: "deny", label: "Deny", description: "No network access." },
			{ value: "allow", label: "Allow", description: "Unrestricted network access." },
		],
	},
});

export const cfgSandboxAllowedHosts = register({
	id: "sandbox.network.allowedHosts",
	type: "array",
	default: DEFAULT_ALLOWED_HOSTS,
	validate: stringList("sandbox.network.allowedHosts", "host names"),
	ui: {
		tab: "tools",
		group: "Sandbox",
		label: "Sandbox Allowed Hosts",
		condition: "sandboxAllowedHostsNotProject",
		editor: "json",
		description:
			'Hosts contained commands may reach in allowlist mode. A JSON list; "*.example.com" matches subdomains of example.com but not example.com itself.',
	},
});
