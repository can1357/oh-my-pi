import { describe } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type FifoCase, itRefusesFifo, mod, useFifoSandbox } from "./fifo-harness";

// Files a user or another tool places that the TUI, utils, AI and catalog
// packages read on their own: themes, keybindings, `.editorconfig`, CA bundles,
// cloud credentials and token files, and git metadata. Each case makes the
// reader's real call in a child process; see `fifo-harness.ts`.
const box = useFifoSandbox("@omp-fifo-other-packages-");

const THEME = "fifo-theme";
const themePath = (): string => path.join(box.agentDir, "themes", `${THEME}.json`);

/** Print the error the call under test ended with, as its caller would show it. */
const printError = (call: string): string =>
	`try {
		${call};
		console.log("no error");
	} catch (error) {
		console.log(\`error \${String(error)}\`);
	}`;

/** A fetch that is never meant to be reached: every case fails before its first request. */
const unreachedFetch = `async () => new Response("{}", { status: 404 })`;

const cases: FifoCase[] = [
	{
		// The first terminal frame: a theme that cannot be loaded falls back to dark.
		name: "~/.omp/agent/themes/<name>.json, at startup",
		at: themePath,
		script: () =>
			`import { initThemeSync } from ${mod("tui", "theme/theme.ts")};
			initThemeSync(undefined, undefined, ${JSON.stringify(THEME)}, ${JSON.stringify(THEME)});`,
		outcome: "skipped",
	},
	{
		// `/theme`, the settings selector, and the reload when the theme file changes.
		name: "~/.omp/agent/themes/<name>.json, on a theme change",
		at: themePath,
		script: () =>
			`import { setTheme } from ${mod("tui", "theme/theme.ts")};
			const result = await setTheme(${JSON.stringify(THEME)});
			console.log(result.success ? "no error" : \`error \${result.error}\`);`,
		outcome: "reported",
	},
	{
		// The settings migration and the setup wizard sort a custom theme into the dark or light slot.
		name: "~/.omp/agent/themes/<name>.json, when it is sorted dark or light",
		at: themePath,
		script: () =>
			`import { isLightTheme } from ${mod("tui", "theme/theme.ts")};
			isLightTheme(${JSON.stringify(THEME)});`,
		outcome: "skipped",
	},
	{
		name: "~/.omp/agent/keybindings.yml",
		at: () => path.join(box.agentDir, "keybindings.yml"),
		script: () =>
			`import { KeybindingsManager } from ${mod("tui", "app-keybindings.ts")};
			KeybindingsManager.create(${JSON.stringify(box.agentDir)});`,
		outcome: "skipped",
	},
	{
		// Read for each directory from an edited file up, by the edit renderer and LSP formatting.
		name: "<project>/.editorconfig",
		at: () => path.join(box.projectDir, ".editorconfig"),
		script: () =>
			`import { getEditorConfigFormatting } from ${mod("utils", "tab-spacing.ts")};
			getEditorConfigFormatting("src/main.ts", ${JSON.stringify(box.projectDir)});`,
		outcome: "skipped",
	},
	{
		// Read for every provider request and model discovery fetch.
		name: "$NODE_EXTRA_CA_CERTS",
		at: () => path.join(box.home, "certs", "extra-ca.pem"),
		script: () =>
			`import { wrapFetchForExtraCa } from ${mod("utils", "tls-fetch.ts")};
			const fetchWithCa = wrapFetchForExtraCa(${unreachedFetch});
			${printError(`await fetchWithCa("https://example.invalid/")`)}`,
		env: () => ({ NODE_EXTRA_CA_CERTS: path.join(box.home, "certs", "extra-ca.pem") }),
		outcome: "reported",
	},
	{
		name: "~/.config/gcloud/application_default_credentials.json",
		at: () => path.join(box.home, ".config", "gcloud", "application_default_credentials.json"),
		script: () =>
			`import { getVertexAccessToken } from ${mod("ai", "providers/google-auth.ts")};
			${printError(`await getVertexAccessToken({ fetch: ${unreachedFetch} })`)}`,
		// gcloud's own token override would answer before any file is read.
		env: () => ({ CLOUDSDK_AUTH_ACCESS_TOKEN: "" }),
		outcome: "reported",
	},
	{
		name: "$AWS_WEB_IDENTITY_TOKEN_FILE",
		at: () => path.join(box.home, ".aws", "web-identity-token"),
		script: () =>
			`import { resolveAwsCredentials } from ${mod("ai", "providers/aws-credentials.ts")};
			${printError(`await resolveAwsCredentials({ region: "us-east-1", fetch: ${unreachedFetch} })`)}`,
		env: () => ({
			AWS_WEB_IDENTITY_TOKEN_FILE: path.join(box.home, ".aws", "web-identity-token"),
			AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/omp-fifo",
		}),
		outcome: "reported",
	},
	{
		name: "$AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
		at: () => path.join(box.home, "container-authorization-token"),
		script: () =>
			`import { resolveAwsCredentials } from ${mod("ai", "providers/aws-credentials.ts")};
			${printError(`await resolveAwsCredentials({ region: "us-east-1", fetch: ${unreachedFetch} })`)}`,
		env: () => ({
			AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/omp-fifo",
			AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: path.join(box.home, "container-authorization-token"),
		}),
		outcome: "reported",
	},
	{
		// Every cached token is a candidate when the profile's own hash names none.
		name: "~/.aws/sso/cache/<token>.json",
		at: () => path.join(box.home, ".aws", "sso", "cache", "omp-fifo.json"),
		setup: () => {
			fs.mkdirSync(path.join(box.home, ".aws"), { recursive: true });
			fs.writeFileSync(
				path.join(box.home, ".aws", "config"),
				[
					"[profile omp-fifo]",
					"sso_start_url = https://omp-fifo.awsapps.com/start",
					"sso_region = us-east-1",
					"sso_account_id = 123456789012",
					"sso_role_name = OmpFifo",
					"",
				].join("\n"),
			);
		},
		script: () =>
			`import { resolveAwsCredentials } from ${mod("ai", "providers/aws-credentials.ts")};
			import { AwsCredentialsError } from ${mod("ai", "error/index.ts")};
			try {
				await resolveAwsCredentials({ profile: "omp-fifo", region: "us-east-1", fetch: ${unreachedFetch} });
			} catch (error) {
				// No cached SSO token is this call's own answer, as with an empty cache.
				if (!(error instanceof AwsCredentialsError)) throw error;
			}`,
		outcome: "skipped",
	},
	{
		// Microsoft Foundry mTLS material, read when an Anthropic request builds its TLS options.
		name: "$CLAUDE_CODE_CLIENT_CERT",
		at: () => path.join(box.home, "certs", "client-cert.pem"),
		script: () =>
			`import { buildModel } from ${mod("catalog", "build.ts")};
			import { buildClaudeCodeTlsFetchOptions } from ${mod("ai", "providers/anthropic-http-options.ts")};
			const model = buildModel({
				id: "omp-fifo-model",
				name: "FIFO Model",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			});
			${printError(`buildClaudeCodeTlsFetchOptions(model, "https://foundry.example.com")`)}`,
		env: () => ({
			CLAUDE_CODE_USE_FOUNDRY: "1",
			CLAUDE_CODE_CLIENT_CERT: path.join(box.home, "certs", "client-cert.pem"),
			// A non-path, non-PEM placeholder: the cert (the FIFO) is resolved first and throws, so the key is never read.
			CLAUDE_CODE_CLIENT_KEY: "key-placeholder-unused-in-this-test",
		}),
		outcome: "reported",
	},
	{
		// GitLab Duo Workflow finds the project from the workspace's git remotes.
		name: "<project>/.git/config",
		at: () => path.join(box.projectDir, ".git", "config"),
		script: () =>
			`import { discoverGitLabDuoWorkflowRuntimeNamespace } from ${mod("catalog", "discovery/gitlab-duo-workflow.ts")};
			// The token is irrelevant here: discovery reads the workspace .git/config (the FIFO) before any fetch.
			const token = ${JSON.stringify("omp-fifo-placeholder")};
			try {
				await discoverGitLabDuoWorkflowRuntimeNamespace({
					apiKey: token,
					cwd: ${JSON.stringify(box.projectDir)},
					fetch: ${unreachedFetch},
				});
			} catch (error) {
				// No namespace anywhere is this call's own answer, as with no remote at all.
				if (!String(error).includes("GitLab Duo Workflow namespace")) throw error;
			}`,
		env: () => ({ GITLAB_DUO_NAMESPACE_ID: "", GITLAB_DUO_PROJECT_ID: "", GITLAB_DUO_PROJECT_PATH: "" }),
		outcome: "skipped",
	},
];

describe.skipIf(process.platform === "win32")(
	"a FIFO at a file the TUI, utils, AI or catalog packages read is neither waited on nor read",
	() => {
		for (const c of cases) itRefusesFifo(box, c);
	},
);
