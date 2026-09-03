import "@oh-my-pi/pi-utils/env";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";

export function getExtraHelpText(): string {
	return `${chalk.bold("Environment Variables:")}
  ${chalk.dim("# Core Providers")}
  ANTHROPIC_API_KEY          - Anthropic Claude models
  ANTHROPIC_OAUTH_TOKEN      - Anthropic OAuth (takes precedence over API key)
  CLAUDE_CODE_USE_FOUNDRY    - Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)
  FOUNDRY_BASE_URL           - Anthropic Foundry base URL (e.g., https://<foundry-host>)
  ANTHROPIC_FOUNDRY_API_KEY  - Anthropic token used as Authorization: Bearer <token> in Foundry mode
  ANTHROPIC_CUSTOM_HEADERS   - Extra headers for Foundry or any custom ANTHROPIC_BASE_URL gateway (e.g., "user-id: USERNAME")
  CLAUDE_CODE_CLIENT_CERT    - Client certificate (PEM path or inline PEM) for mTLS
  CLAUDE_CODE_CLIENT_KEY     - Client private key (PEM path or inline PEM) for mTLS
  NODE_EXTRA_CA_CERTS        - CA bundle path (or inline PEM) for server certificate validation
  OPENAI_API_KEY             - OpenAI GPT models
  GEMINI_API_KEY             - Google Gemini models
  COPILOT_GITHUB_TOKEN      - GitHub Copilot

  ${chalk.dim("# Additional LLM Providers")}
  AZURE_OPENAI_API_KEY       - Azure OpenAI models
  GROQ_API_KEY               - Groq models
  CEREBRAS_API_KEY           - Cerebras models
  XAI_API_KEY                - xAI Grok models
  OPENROUTER_API_KEY         - OpenRouter aggregated models
  KILO_API_KEY               - Kilo Gateway models
  MISTRAL_API_KEY            - Mistral models
  ZAI_API_KEY                - z.ai models (ZhipuAI/GLM)
  UMANS_AI_CODING_PLAN_API_KEY - Umans AI Coding Plan models
  ABLITERATION_API_KEY       - Abliteration uncensored GLM models
  UMANS_WEBSEARCH_PROVIDER    - Umans gateway web search backend (native or exa)
  MINIMAX_API_KEY            - MiniMax models
  OPENCODE_API_KEY           - OpenCode Zen/OpenCode Go models
  CURSOR_ACCESS_TOKEN        - Cursor AI models
  CLINE_API_KEY              - ClinePass subscription models
  AI_GATEWAY_API_KEY         - Vercel AI Gateway
  WAFER_SERVERLESS_API_KEY   - Wafer Serverless (pay-as-you-go)
  YOLO_AUTO_API_KEY          - Yolo-Auto flat-rate Qwen models

  ${chalk.dim("# Cloud Providers")}
  AWS_PROFILE                - AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
  GOOGLE_CLOUD_PROJECT       - Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)
  GOOGLE_APPLICATION_CREDENTIALS - Service account for Vertex AI

  ${chalk.dim("# Search & Tools")}
  EXA_API_KEY                - Exa web search
  BRAVE_API_KEY              - Brave web search
  PERPLEXITY_API_KEY         - Perplexity web search API key (optional; anonymous fallback)
  PERPLEXITY_COOKIES         - Perplexity web search (session cookie)
  TAVILY_API_KEY             - Tavily web search
  TINYFISH_API_KEY           - TinyFish web search
  FIRECRAWL_API_KEY          - Firecrawl web search + fetch reader backend
  ANTHROPIC_SEARCH_API_KEY   - Anthropic web search (override; isolates search from main ANTHROPIC_API_KEY)
  ANTHROPIC_SEARCH_BASE_URL  - Anthropic web search base URL (override; pairs with ANTHROPIC_SEARCH_API_KEY)

  ${chalk.dim("# Configuration")}
  OMP_PROFILE                 - Named profile for isolated agent state (same as --profile)
  Use \`omp --profile <name> --alias <command>\` to create a shell shortcut for a profile
  PI_CODING_AGENT_DIR        - Session storage directory (default: ~/${CONFIG_DIR_NAME}/agent)
  PI_PACKAGE_DIR             - Override package directory (for Nix/Guix store paths)
  PI_SMOL_MODEL              - Override smol/fast model (see --smol)
  PI_SLOW_MODEL              - Override slow/reasoning model (see --slow)
  PI_PLAN_MODEL              - Override planning model (see --plan)
  PI_NO_PTY                  - Disable PTY-based interactive bash execution
  For complete environment variable reference, see:
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold("Available Tools (default-enabled unless noted):")}
  read          - Read file contents
  bash          - Execute bash commands
  edit          - Edit files with find/replace
  write         - Write files (creates/overwrites)
  grep          - Search file contents
  glob          - Find files by glob pattern
  lsp           - Language server protocol (code intelligence)
  python        - Execute Python code (requires: ${APP_NAME} setup python)
  notebook      - Edit Jupyter notebooks
  inspect_image - Analyze images with a vision model
  browser       - Browser automation (Puppeteer)
  computer      - Native host desktop capture and input (disabled by default)
  task          - Launch sub-agents for parallel tasks
  todo          - Manage todo/task lists
  web_search    - Search the web
  ask           - Ask user questions (interactive mode only)

${chalk.bold("Plugin Options:")}
  --plugin-dir <path>        Load plugin from directory (repeatable)

${chalk.bold("Useful Commands:")}
  omp agents unpack           - Export bundled subagents to ~/.omp/agent/agents (default)
  omp agents unpack --project - Export bundled subagents to ./.omp/agents`;
}
