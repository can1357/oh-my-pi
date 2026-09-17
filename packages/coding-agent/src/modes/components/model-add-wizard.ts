/**
 * Model Add Wizard Component
 *
 * Interactive multi-step wizard for adding custom OpenAI-compatible providers and models
 * with full tool calling and MCP support enabled.
 */
import { Container, Input, matchesKey, replaceTabs, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import {
	type AddCustomOpenAIProviderOptions,
	probeOpenAIEndpoint,
	sanitizeBaseUrl,
	validateBaseUrl,
	validateProviderId,
} from "../../config/models-config-writer";
import { theme } from "../theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { OverlayPanel } from "./overlay-box";

type WizardStep =
	| "provider"
	| "baseUrl"
	| "api"
	| "authMethod"
	| "apiKey"
	| "modelMode"
	| "manualModelId"
	| "manualModelName"
	| "contextWindow"
	| "testConnection"
	| "confirm";

interface WizardState {
	provider: string;
	baseUrl: string;
	api: "openai-completions" | "openai-responses";
	authMethod: "apiKey" | "none";
	apiKey: string;
	modelMode: "discovery" | "manual";
	manualModelId: string;
	manualModelName: string;
	contextWindow: string;
	probedModels: string[];
	probeError: string | null;
	probeStatus: "idle" | "probing" | "success" | "failed";
}

const MAX_DISPLAY_WIDTH = 120;

function sanitize(text: string): string {
	return truncateToWidth(replaceTabs(text), MAX_DISPLAY_WIDTH);
}

export class ModelAddWizard extends OverlayPanel {
	#currentStep: WizardStep = "provider";
	#state: WizardState = {
		provider: "",
		baseUrl: "",
		api: "openai-completions",
		authMethod: "none",
		apiKey: "",
		modelMode: "discovery",
		manualModelId: "",
		manualModelName: "",
		contextWindow: "128000",
		probedModels: [],
		probeError: null,
		probeStatus: "idle",
	};

	#contentContainer: Container;
	#inputField: Input | null = null;
	#selectedIndex = 0;
	#validationError: string | null = null;
	#onCompleteCallback: (options: AddCustomOpenAIProviderOptions) => void;
	#onCancelCallback: () => void;
	#onRenderCallback: (() => void) | null = null;
	#probeAbortController: AbortController | null = null;

	constructor(
		onComplete: (options: AddCustomOpenAIProviderOptions) => void,
		onCancel: () => void,
		onRender?: () => void,
		initialProvider?: string,
	) {
		super("Add Custom OpenAI Provider");
		this.#onCompleteCallback = onComplete;
		this.#onCancelCallback = onCancel;
		this.#onRenderCallback = onRender ?? null;

		if (initialProvider && initialProvider.trim()) {
			this.#state.provider = initialProvider.trim();
			this.#currentStep = "baseUrl";
		}

		this.addChild(new Spacer(1));
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);
		this.addChild(new Spacer(1));

		this.#renderStep();
	}

	get currentStep(): WizardStep {
		return this.#currentStep;
	}

	get isProbeSettled(): boolean {
		return this.#state.probeStatus === "success" || this.#state.probeStatus === "failed";
	}
	#requestRender(): void {
		this.#onRenderCallback?.();
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#inputField = null;

		switch (this.#currentStep) {
			case "provider":
				this.#renderProviderStep();
				break;
			case "baseUrl":
				this.#renderBaseUrlStep();
				break;
			case "api":
				this.#renderApiStep();
				break;
			case "authMethod":
				this.#renderAuthMethodStep();
				break;
			case "apiKey":
				this.#renderApiKeyStep();
				break;
			case "modelMode":
				this.#renderModelModeStep();
				break;
			case "manualModelId":
				this.#renderManualModelIdStep();
				break;
			case "manualModelName":
				this.#renderManualModelNameStep();
				break;
			case "contextWindow":
				this.#renderContextWindowStep();
				break;
			case "testConnection":
				this.#renderTestConnectionStep();
				break;
			case "confirm":
				this.#renderConfirmStep();
				break;
		}
	}

	#renderProviderStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 1: Provider Identifier")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter a unique identifier for this provider:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.provider);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[Letters, numbers, hyphens, and underscores (e.g. local-vllm, deepseek-proxy)]"), 0, 0),
		);
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to cancel]"), 0, 0));
	}

	#renderBaseUrlStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 2: Base URL")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the base endpoint URL for this OpenAI-compatible server:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.baseUrl);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[Default: http://localhost:8000/v1. Enter to use default or continue, Esc to go back]"), 0, 0),
		);
	}

	#renderApiStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 3: API Format")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Select the API endpoint format:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{
				value: "openai-completions" as const,
				label: "openai-completions (Chat Completions: /chat/completions)",
				desc: "Standard format supported by vLLM, Ollama, LM Studio, DeepSeek, and most proxies",
			},
			{
				value: "openai-responses" as const,
				label: "openai-responses (GA Responses API: /responses)",
				desc: "OpenAI Responses API with stateful session containers",
			},
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
			if (!isSelected) {
				this.#contentContainer.addChild(new Text(`    ${theme.fg("dim", option.desc)}`, 0, 0));
			}
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
		);
	}

	#renderAuthMethodStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 4: Authentication")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Select authentication mode:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{
				value: "none" as const,
				label: "None / Local (No API key required)",
				desc: "Ideal for local Ollama, LM Studio, or unauthenticated local vLLM instances",
			},
			{
				value: "apiKey" as const,
				label: "API Key (Bearer token authentication)",
				desc: "Required for cloud providers or secured private endpoints",
			},
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
			if (!isSelected) {
				this.#contentContainer.addChild(new Text(`    ${theme.fg("dim", option.desc)}`, 0, 0));
			}
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
		);
	}

	#renderApiKeyStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 5: API Key")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the API key for this provider:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.mask = true;
		this.#inputField.setValue(this.#state.apiKey);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[Input is masked. Enter to continue, Esc to go back]"), 0, 0),
		);
	}

	#renderModelModeStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 6: Model Configuration Mode")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("How should models under this provider be configured?", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{
				value: "discovery" as const,
				label: "Automatic Model Discovery (openai-models-list)",
				desc: "Automatically detects models via GET /models endpoint. Recommended for dynamic servers.",
			},
			{
				value: "manual" as const,
				label: "Manual Model Specification",
				desc: "Configure an explicit model identifier and context window limit directly.",
			},
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
			if (!isSelected) {
				this.#contentContainer.addChild(new Text(`    ${theme.fg("dim", option.desc)}`, 0, 0));
			}
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
		);
	}

	#renderManualModelIdStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 7: Model Identifier")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the model ID (as recognized by the provider):", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.manualModelId);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[e.g. meta-llama/Llama-3-70b-instruct, qwen2.5-coder:32b, deepseek-ai/DeepSeek-V3]"), 0, 0),
		);
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderManualModelNameStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 8: Display Name (Optional)")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter a friendly display name for the model (press Enter to use model ID):", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.manualModelName || this.#state.manualModelId);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderContextWindowStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 9: Context Window (Tokens)")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the maximum context window size in tokens:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.contextWindow || "128000");
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Must be a positive integer, e.g. 128000, 65536, 32768]"), 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderTestConnectionStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 10: Endpoint Connectivity Check")));
		this.#contentContainer.addChild(new Spacer(1));

		const target = `${sanitizeBaseUrl(this.#state.baseUrl)}/models`;
		this.#contentContainer.addChild(new Text(`Probing ${sanitize(target)}...`, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#state.probeStatus === "probing") {
			this.#contentContainer.addChild(new Text(theme.fg("muted", "Connecting to server (timeout 8s)..."), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("muted", "[Esc to cancel probe and go back]"), 0, 0));
			return;
		}

		if (this.#state.probeStatus === "success") {
			this.#contentContainer.addChild(new Text(theme.fg("success", `✓ Connection successful!`), 0, 0));
			if (this.#state.probedModels.length > 0) {
				const preview = this.#state.probedModels.slice(0, 5).join(", ");
				const remaining = this.#state.probedModels.length > 5 ? ` and ${this.#state.probedModels.length - 5} more` : "";
				this.#contentContainer.addChild(
					new Text(theme.fg("muted", `Detected ${this.#state.probedModels.length} models: ${sanitize(preview)}${remaining}`), 0, 0),
				);
			} else {
				this.#contentContainer.addChild(new Text(theme.fg("muted", "Endpoint reachable (0 models returned by list)."), 0, 0));
			}
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("accent", "→ Continue to confirmation"), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
			return;
		}

		if (this.#state.probeStatus === "failed") {
			this.#contentContainer.addChild(new Text(theme.fg("warning", `⚠ Connection check failed:`), 0, 0));
			if (this.#state.probeError) {
				this.#contentContainer.addChild(new Text(theme.fg("error", `  ${sanitize(this.#state.probeError)}`), 0, 0));
			}
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(
				new Text(theme.fg("muted", "Note: Offline or containerized servers not yet started can still be saved."), 0, 0),
			);
			this.#contentContainer.addChild(new Spacer(1));

			const options = [
				{ label: "Save anyway (server will be started later)" },
				{ label: "Go back and adjust settings" },
				{ label: "Retry connection test" },
			];

			for (let i = 0; i < options.length; i++) {
				const isSelected = i === this.#selectedIndex;
				const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
				const text = isSelected ? theme.fg("accent", options[i].label) : options[i].label;
				this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
			}

			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(
				new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
			);
		}
	}

	#renderConfirmStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 11: Review & Confirm Configuration")));
		this.#contentContainer.addChild(new Spacer(1));

		this.#contentContainer.addChild(new Text(`${theme.fg("accent", "Provider ID:")}     ${this.#state.provider}`, 0, 0));
		this.#contentContainer.addChild(new Text(`${theme.fg("accent", "Base URL:")}        ${sanitize(this.#state.baseUrl)}`, 0, 0));
		this.#contentContainer.addChild(new Text(`${theme.fg("accent", "API Protocol:")}    ${this.#state.api}`, 0, 0));
		this.#contentContainer.addChild(
			new Text(`${theme.fg("accent", "Authentication:")}  ${this.#state.authMethod === "none" ? "None (Local)" : "API Key configured"}`, 0, 0),
		);

		if (this.#state.modelMode === "discovery") {
			this.#contentContainer.addChild(new Text(`${theme.fg("accent", "Model Mode:")}      Auto-discovery (openai-models-list)`, 0, 0));
		} else {
			this.#contentContainer.addChild(new Text(`${theme.fg("accent", "Model ID:")}        ${this.#state.manualModelId}`, 0, 0));
			if (this.#state.manualModelName) {
				this.#contentContainer.addChild(new Text(`${theme.fg("accent", "Display Name:")}    ${this.#state.manualModelName}`, 0, 0));
			}
			this.#contentContainer.addChild(new Text(`${theme.fg("accent", "Context Window:")}  ${this.#state.contextWindow} tokens`, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("success", "✓ MCP Tools & Skills: Enabled (supportsTools: true, disableStrictTools: true)"), 0, 0),
		);
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{ label: "Save configuration to models.yml and register" },
			{ label: "Cancel and exit wizard" },
		];

		for (let i = 0; i < options.length; i++) {
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", options[i].label) : options[i].label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to confirm, Esc to go back]"), 0, 0),
		);
	}

	override handleInput(keyData: string): void {
		if (keyData === "\x03") {
			this.#cancelProbe();
			this.#onCancelCallback();
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			if (this.#currentStep === "provider") {
				this.#onCancelCallback();
				return;
			}
			this.#goBack();
			return;
		}

		if (this.#inputField) {
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#saveInputAndProceed();
				return;
			}
			this.#inputField.handleInput(keyData);
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentOption();
			return;
		}

		if (matchesSelectUp(keyData) || matchesKey(keyData, "up") || matchesKey(keyData, "shift+tab")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(keyData) || matchesKey(keyData, "down") || matchesKey(keyData, "tab")) {
			this.#moveSelection(1);
			return;
		}
	}

	#cancelProbe(): void {
		if (this.#probeAbortController) {
			this.#probeAbortController.abort();
			this.#probeAbortController = null;
		}
	}

	#moveSelection(delta: number): void {
		const maxIndex = this.#getMaxSelectionIndex();
		if (maxIndex <= 0) return;

		this.#selectedIndex = (this.#selectedIndex + delta + (maxIndex + 1)) % (maxIndex + 1);
		this.#renderStep();
		this.#requestRender();
	}

	#getMaxSelectionIndex(): number {
		switch (this.#currentStep) {
			case "api":
			case "authMethod":
			case "modelMode":
				return 1;
			case "testConnection":
				return this.#state.probeStatus === "failed" ? 2 : 0;
			case "confirm":
				return 1;
			default:
				return 0;
		}
	}

	#goBack(): void {
		this.#cancelProbe();
		this.#validationError = null;

		switch (this.#currentStep) {
			case "baseUrl":
				this.#currentStep = "provider";
				break;
			case "api":
				this.#currentStep = "baseUrl";
				break;
			case "authMethod":
				this.#currentStep = "api";
				this.#selectedIndex = this.#state.api === "openai-completions" ? 0 : 1;
				break;
			case "apiKey":
				this.#currentStep = "authMethod";
				this.#selectedIndex = 1;
				break;
			case "modelMode":
				if (this.#state.authMethod === "apiKey") {
					this.#currentStep = "apiKey";
				} else {
					this.#currentStep = "authMethod";
					this.#selectedIndex = 0;
				}
				break;
			case "manualModelId":
				this.#currentStep = "modelMode";
				this.#selectedIndex = 1;
				break;
			case "manualModelName":
				this.#currentStep = "manualModelId";
				break;
			case "contextWindow":
				this.#currentStep = "manualModelName";
				break;
			case "testConnection":
				if (this.#state.modelMode === "discovery") {
					this.#currentStep = "modelMode";
					this.#selectedIndex = 0;
				} else {
					this.#currentStep = "contextWindow";
				}
				break;
			case "confirm":
				this.#currentStep = "testConnection";
				this.#selectedIndex = 0;
				break;
		}

		this.#renderStep();
		this.#requestRender();
	}

	#saveInputAndProceed(): void {
		const value = this.#inputField?.getValue().trim() ?? "";

		switch (this.#currentStep) {
			case "provider": {
				const error = validateProviderId(value);
				if (error) {
					this.#validationError = error;
					this.#renderStep();
					this.#requestRender();
					return;
				}
				this.#state.provider = value;
				this.#validationError = null;
				this.#currentStep = "baseUrl";
				break;
			}
			case "baseUrl": {
				const rawValue = this.#inputField?.getValue().trim() ?? "";
				const value = rawValue || this.#state.baseUrl || "http://localhost:8000/v1";
				const error = validateBaseUrl(value);
				if (error) {
					this.#validationError = error;
					this.#renderStep();
					this.#requestRender();
					return;
				}
				this.#state.baseUrl = sanitizeBaseUrl(value);
				this.#validationError = null;
				this.#currentStep = "api";
				this.#selectedIndex = 0;
				break;
			}
			case "apiKey": {
				if (this.#state.authMethod === "apiKey" && !value) {
					this.#validationError = "API key cannot be empty when API key authentication is selected";
					this.#renderStep();
					this.#requestRender();
					return;
				}
				this.#state.apiKey = value;
				this.#validationError = null;
				this.#currentStep = "modelMode";
				this.#selectedIndex = 0;
				break;
			}
			case "manualModelId": {
				if (!value) {
					this.#validationError = "Model identifier cannot be empty";
					this.#renderStep();
					this.#requestRender();
					return;
				}
				this.#state.manualModelId = value;
				this.#validationError = null;
				this.#currentStep = "manualModelName";
				break;
			}
			case "manualModelName": {
				this.#state.manualModelName = value || this.#state.manualModelId;
				this.#validationError = null;
				this.#currentStep = "contextWindow";
				break;
			}
			case "contextWindow": {
				const parsedNum = Number.parseInt(value, 10);
				if (Number.isNaN(parsedNum) || parsedNum <= 0) {
					this.#validationError = "Context window must be a positive integer";
					this.#renderStep();
					this.#requestRender();
					return;
				}
				this.#state.contextWindow = String(parsedNum);
				this.#validationError = null;
				this.#startProbe();
				return;
			}
		}

		this.#renderStep();
		this.#requestRender();
	}

	#selectCurrentOption(): void {
		switch (this.#currentStep) {
			case "api":
				this.#state.api = this.#selectedIndex === 0 ? "openai-completions" : "openai-responses";
				this.#currentStep = "authMethod";
				this.#selectedIndex = 0;
				break;
			case "authMethod":
				this.#state.authMethod = this.#selectedIndex === 0 ? "none" : "apiKey";
				if (this.#state.authMethod === "apiKey") {
					this.#currentStep = "apiKey";
				} else {
					this.#state.apiKey = "";
					this.#currentStep = "modelMode";
					this.#selectedIndex = 0;
				}
				break;
			case "modelMode":
				this.#state.modelMode = this.#selectedIndex === 0 ? "discovery" : "manual";
				if (this.#state.modelMode === "discovery") {
					this.#startProbe();
					return;
				}
				this.#currentStep = "manualModelId";
				break;
			case "testConnection":
				if (this.#state.probeStatus === "success") {
					this.#currentStep = "confirm";
					this.#selectedIndex = 0;
				} else if (this.#state.probeStatus === "failed") {
					if (this.#selectedIndex === 0) {
						// Save anyway
						this.#currentStep = "confirm";
						this.#selectedIndex = 0;
					} else if (this.#selectedIndex === 1) {
						// Go back
						this.#goBack();
						return;
					} else if (this.#selectedIndex === 2) {
						// Retry
						this.#startProbe();
						return;
					}
				}
				break;
			case "confirm":
				if (this.#selectedIndex === 0) {
					this.#complete();
					return;
				}
				this.#onCancelCallback();
				return;
		}

		this.#renderStep();
		this.#requestRender();
	}

	#startProbe(): void {
		this.#currentStep = "testConnection";
		this.#state.probeStatus = "probing";
		this.#state.probeError = null;
		this.#state.probedModels = [];
		this.#selectedIndex = 0;
		this.#renderStep();
		this.#requestRender();

		const baseUrl = this.#state.baseUrl;
		const apiKey = this.#state.authMethod === "apiKey" ? this.#state.apiKey : undefined;

		probeOpenAIEndpoint(baseUrl, apiKey, 8000)
			.then(result => {
				if (this.#currentStep !== "testConnection") return;
				if (result.ok) {
					this.#state.probeStatus = "success";
					this.#state.probedModels = result.models;
				} else {
					this.#state.probeStatus = "failed";
					this.#state.probeError = result.error ?? "Unknown error reaching endpoint";
				}
				this.#selectedIndex = 0;
				this.#renderStep();
				this.#requestRender();
			})
			.catch(err => {
				if (this.#currentStep !== "testConnection") return;
				this.#state.probeStatus = "failed";
				this.#state.probeError = err instanceof Error ? err.message : String(err);
				this.#selectedIndex = 0;
				this.#renderStep();
				this.#requestRender();
			});
	}

	#complete(): void {
		const options: AddCustomOpenAIProviderOptions = {
			provider: this.#state.provider,
			baseUrl: this.#state.baseUrl,
			api: this.#state.api,
			auth: this.#state.authMethod,
			apiKey: this.#state.authMethod === "apiKey" ? this.#state.apiKey : undefined,
			disableStrictTools: true,
		};

		if (this.#state.modelMode === "discovery") {
			options.discovery = true;
		} else {
			const contextWindowNum = Number.parseInt(this.#state.contextWindow, 10);
			options.model = {
				id: this.#state.manualModelId,
				name: this.#state.manualModelName || this.#state.manualModelId,
				contextWindow: Number.isNaN(contextWindowNum) ? 128000 : contextWindowNum,
			};
		}

		this.#onCompleteCallback(options);
	}
}
