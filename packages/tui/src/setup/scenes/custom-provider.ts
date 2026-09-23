import { Container } from "../../tui";
import { Input } from "../../components/input";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { theme } from "../../theme/theme";
import type { SetupSceneHost, SetupTab } from "./types";

const FIELDS = [
	{ id: "id", label: "Provider ID", prompt: "Provider ID: " },
	{ id: "baseUrl", label: "Endpoint URL", prompt: "Endpoint URL: " },
	{ id: "apiKey", label: "API key (optional for local servers)", prompt: "API key: ", secret: true },
] as const;

/** Register an OpenAI-compatible endpoint and discover its models. */
export class CustomProviderTab implements SetupTab {
	readonly id = "custom";
	readonly label = "Custom endpoint";
	#host: SetupSceneHost;
	#inputs = FIELDS.map(field => {
		const input = new Input();
		input.prompt = field.prompt;
		input.mask = field.id === "apiKey";
		return input;
	});
	#index = 0;
	#saving = false;
	#status: string | undefined;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#inputs.forEach((input, index) => {
			input.onSubmit = value => void this.#submit(index, value);
			input.onEscape = () => host.finish("skipped");
		});
	}

	onActivate(): void {
		if (!this.#saving) this.#focusCurrent();
	}

	get modal(): boolean {
		return this.#saving;
	}

	render(width: number, maxLines?: number): readonly string[] {
		const field = FIELDS[this.#index];
		const content = new Container();
		content.addChild(this.#inputs[this.#index]);
		const intro = new Text(
			"Add an OpenAI-compatible API endpoint. Models are discovered from its /v1/models endpoint.",
			0,
		);
		const status = this.#status ? new Text(this.#status, 0, 0) : undefined;
		const step = new WizardStep({
			kind: this.#saving ? "async" : "input",
			heading: new Text(theme.bold(field.label), 0, 0),
			intro,
			content,
			status,
			footer: new Text(theme.fg("dim", "Enter continues · Esc closes provider setup"), 0, 0),
		});
		step.setMaxHeight(maxLines);
		return step.render(width);
	}

	handleInput(data: string): void {
		if (this.#saving) return;
		this.#inputs[this.#index].handleInput(data);
	}

	invalidate(): void {
		for (const input of this.#inputs) input.invalidate();
	}

	dispose(): void {
		this.#host.restoreFocus();
	}

	async #submit(index: number, rawValue: string): Promise<void> {
		const value = rawValue.trim();
		if (index === 0 && !/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
			this.#status = theme.fg("error", "Use lowercase letters, numbers, - or _; start with a letter or number.");
			this.#host.requestRender();
			return;
		}
		if (index === 1 && !value) {
			this.#status = theme.fg("error", "Endpoint URL is required.");
			this.#host.requestRender();
			return;
		}
		this.#status = undefined;
		if (index < FIELDS.length - 1) {
			this.#index++;
			this.#focusCurrent();
			this.#host.requestRender();
			return;
		}

		this.#saving = true;
		this.#status = theme.fg("muted", "Saving provider and discovering models…");
		this.#host.requestRender();
		try {
			await this.#host.ctx.addCustomProvider({
				id: this.#inputs[0].getValue().trim(),
				baseUrl: this.#inputs[1].getValue().trim(),
				apiKey: this.#inputs[2].getValue().trim(),
			});
			this.#status = theme.fg("success", "Provider saved. Its discovered models are available in the model picker.");
			this.#saving = false;
			this.#host.finish("done");
		} catch (error) {
			this.#index = 0;
			this.#focusCurrent();
			const message = error instanceof Error ? error.message : String(error);
			this.#status = theme.fg(
				"error",
				message.includes("already configured")
					? `${message} Press Esc to continue to model selection, or enter a different provider ID.`
					: message,
			);
		} finally {
			this.#saving = false;
			this.#host.requestRender();
		}
	}

	#focusCurrent(): void {
		this.#host.setFocus(this.#inputs[this.#index]);
	}
}
