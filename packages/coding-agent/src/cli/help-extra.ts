import "@oh-my-pi/pi-utils/env";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";
import { uiText } from "@oh-my-pi/pi-utils/ui-language";
import { BUILTIN_TOOL_HELP, type BuiltinToolHelp } from "../tools/builtin-names";

function renderBuiltinToolSummary(help: BuiltinToolHelp): string {
	if (help.defaultState === "detected") {
		return uiText("{{summary}} (when {{condition}})", {
			summary: uiText(help.summary),
			condition: uiText(help.detectedWhen),
		});
	}
	return uiText(help.summary);
}

/** Lists tools in `BUILTIN_TOOL_HELP` entry order, which ranks them by how often they are used. */
function renderBuiltinTools(group: "default" | "optional"): string {
	return Object.entries(BUILTIN_TOOL_HELP)
		.filter(([, help]) => (help.defaultState === "off") === (group === "optional"))
		.map(([name, help]) => `  ${name.padEnd(14)}- ${renderBuiltinToolSummary(help)}`)
		.join("\n");
}

export function getExtraHelpText(): string {
	return `${chalk.bold(uiText("Environment Variables:"))}
  ${chalk.dim(uiText("# Core Providers"))}
  ANTHROPIC_API_KEY          - ${uiText("Anthropic Claude models")}
  ANTHROPIC_OAUTH_TOKEN      - ${uiText("Anthropic OAuth (takes precedence over API key)")}
  CLAUDE_CODE_USE_FOUNDRY    - ${uiText("Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)")}
  FOUNDRY_BASE_URL           - ${uiText("Anthropic Foundry base URL (e.g., https://<foundry-host>)")}
  ANTHROPIC_FOUNDRY_API_KEY  - ${uiText("Anthropic token used as Authorization: Bearer <token> in Foundry mode")}
  ANTHROPIC_CUSTOM_HEADERS   - ${uiText('Extra headers for Foundry or any custom ANTHROPIC_BASE_URL gateway (e.g., "user-id: USERNAME")')}
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS - ${uiText("Omit pre-release Anthropic fields (context_management, beta tool fields, task budgets, thinking.block_binding) for gateways that reject them")}
  CLAUDE_CODE_CLIENT_CERT    - ${uiText("Client certificate (PEM path or inline PEM) for mTLS")}
  CLAUDE_CODE_CLIENT_KEY     - ${uiText("Client private key (PEM path or inline PEM) for mTLS")}
  NODE_EXTRA_CA_CERTS        - ${uiText("CA bundle path (or inline PEM) for server certificate validation")}
  OPENAI_API_KEY             - ${uiText("OpenAI GPT models")}
  GEMINI_API_KEY             - ${uiText("Google Gemini models")}
  COPILOT_GITHUB_TOKEN      - ${uiText("GitHub Copilot")}

  ${chalk.dim(uiText("# Additional LLM Providers"))}
  AZURE_OPENAI_API_KEY       - ${uiText("Azure OpenAI models")}
  GROQ_API_KEY               - ${uiText("Groq models")}
  CEREBRAS_API_KEY           - ${uiText("Cerebras models")}
  XAI_API_KEY                - ${uiText("xAI Grok models")}
  OPENROUTER_API_KEY         - ${uiText("OpenRouter aggregated models")}
  KILO_API_KEY               - ${uiText("Kilo Gateway models")}
  MISTRAL_API_KEY            - ${uiText("Mistral models")}
  ZAI_API_KEY                - ${uiText("z.ai models (ZhipuAI/GLM)")}
  UMANS_AI_CODING_PLAN_API_KEY - ${uiText("Umans AI Coding Plan models")}
  ABLITERATION_API_KEY       - ${uiText("Abliteration uncensored GLM models")}
  KIRO_API_KEY               - ${uiText("Kiro agentic IDE models")}
  UMANS_WEBSEARCH_PROVIDER    - ${uiText("Umans gateway web search backend (native or exa)")}
  MINIMAX_API_KEY            - ${uiText("MiniMax models")}
  OPENCODE_API_KEY           - ${uiText("OpenCode Zen/OpenCode Go models")}
  CURSOR_ACCESS_TOKEN        - ${uiText("Cursor AI models")}
  CLINE_API_KEY              - ${uiText("ClinePass subscription models")}
  COMMAND_CODE_API_KEY       - ${uiText("Command Code Provider API models")}
  CHARM_HYPER_API_KEY        - ${uiText("Charm Hyper inference gateway models")}
  AI_GATEWAY_API_KEY         - ${uiText("Vercel AI Gateway")}
  STEPFUN_API_KEY            - ${uiText("StepFun Step models")}
  HELMCODE_API_KEY           - ${uiText("Helmcode private EU inference")}
  WAFER_SERVERLESS_API_KEY   - ${uiText("Wafer Serverless (pay-as-you-go)")}
  YOLO_AUTO_API_KEY          - ${uiText("Yolo-Auto flat-rate Qwen models")}
  SINGULARITYAPI_DEV_API_KEY - ${uiText("SingularityAPI universal gateway (300+ models)")}
  SINGULARITYAPI_TECH_API_KEY - ${uiText("SingularityAPI reserved DeepSeek lanes")}
  SCW_SECRET_KEY             - ${uiText("Scaleway Generative APIs models")}
  OTARI_API_KEY              - ${uiText("Otari AI gateway (workspace models)")}
  OTARI_BASE_URL             - ${uiText("Otari self-hosted API root (e.g. https://host/api/v1)")}

  ${chalk.dim(uiText("# Cloud Providers"))}
  AWS_PROFILE                - ${uiText("AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)")}
  GOOGLE_CLOUD_PROJECT       - ${uiText("Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)")}
  GOOGLE_APPLICATION_CREDENTIALS - ${uiText("Service account for Vertex AI")}

  ${chalk.dim(uiText("# Search & Tools"))}
  EXA_API_KEY                - ${uiText("Exa web search")}
  BRAVE_API_KEY              - ${uiText("Brave web search")}
  PERPLEXITY_API_KEY         - ${uiText("Perplexity web search API key (optional; anonymous fallback)")}
  PERPLEXITY_COOKIES         - ${uiText("Perplexity web search (session cookie)")}
  TAVILY_API_KEY             - ${uiText("Tavily web search")}
  TINYFISH_API_KEY           - ${uiText("TinyFish web search")}
  KEENABLE_API_KEY           - ${uiText("Keenable web search (optional; keyless public fallback)")}
  SOFYA_API_KEY              - ${uiText("Sofya web search")}
  FIRECRAWL_API_KEY          - ${uiText("Firecrawl web search + fetch reader backend")}
  ANTHROPIC_SEARCH_API_KEY   - ${uiText("Anthropic web search (override; isolates search from main ANTHROPIC_API_KEY)")}
  ANTHROPIC_SEARCH_BASE_URL  - ${uiText("Anthropic web search base URL (override; pairs with ANTHROPIC_SEARCH_API_KEY)")}
  TYPESAFE_API_KEY           - ${uiText("TypeSafe System One judgments (auto thinking, unexpected-stop, AI staging, eval judge())")}

  ${chalk.dim(uiText("# Configuration"))}
  OMP_PROFILE                 - ${uiText("Named profile for isolated agent state (same as --profile)")}
  ${uiText("Use `omp --profile <name> --alias <command>` to create a shell shortcut for a profile")}
  PI_CODING_AGENT_DIR        - ${uiText("Session storage directory (default: ~/{{dir}}/agent)", { dir: CONFIG_DIR_NAME })}
  PI_PACKAGE_DIR             - ${uiText("Override package directory (for Nix/Guix store paths)")}
  PI_SMOL_MODEL              - ${uiText("Override smol/fast model (see --smol)")}
  PI_SLOW_MODEL              - ${uiText("Override slow/reasoning model (see --slow)")}
  PI_PLAN_MODEL              - ${uiText("Override planning model (see --plan)")}
  PI_NO_PTY                  - ${uiText("Disable PTY-based interactive bash execution")}
  ${uiText("For complete environment variable reference, see:")}
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold(uiText("Built-in Tools (names accepted by --tools):"))}
  ${chalk.dim(uiText("# Enabled by default"))}
${renderBuiltinTools("default")}

  ${chalk.dim(uiText("# Optional (off by default; enable in settings)"))}
${renderBuiltinTools("optional")}

  ${uiText(
		"Browser and computer use run inside eval: toggle with the browser.enabled\n  (default on) and computer.enabled (default off) settings.",
	)}

${chalk.bold(uiText("Plugin Options:"))}
  --plugin-dir <path>        ${uiText("Load plugin from directory (repeatable)")}

${chalk.bold(uiText("Useful Commands:"))}
  omp agents unpack           - ${uiText("Export bundled subagents to ~/.omp/agent/agents (default)")}
  omp agents unpack --project - ${uiText("Export bundled subagents to ./.omp/agents")}`;
}
