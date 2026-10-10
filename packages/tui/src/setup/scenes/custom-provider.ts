import { Container, type Component } from "../../tui";
import { Input } from "../../components/input";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { matchesSelectCancel } from "../../keybinding-matchers";
import { matchesKey } from "../../keys";
import { theme } from "../../theme/theme";
import type { SetupSceneHost } from "./types";

const FIELDS = [
	{ id: "id", label: "Provider ID", prompt: "Provider ID: " },
	{ id: "baseUrl", label: "Endpoint URL", prompt: "Endpoint URL: " },
	{ id: "apiKey", label: "API key (optional for local servers)", prompt: "API key: ", secret: true },
] as const;

const KEY_FIELD = 2;

/** Host surface the form needs; a scene host satisfies it, so does the /models hub. */
export type CustomProviderFormHost = Pick<SetupSceneHost, "requestRender" | "restoreFocus"> & {
	finish(result: "done" | "skipped"): void;
};

export interface CustomProviderFormValues {
	id: string;
	baseUrl: string;
	apiKey: string;
	/** Set only in edit mode when the user asked to drop the stored key. */
	clearApiKey?: boolean;
}

export interface CustomProviderFormOptions {
	/** Edit an existing provider: the ID is fixed and the URL is prefilled. */
	edit?: { id: string; baseUrl: string; hasKey: boolean };
}

/** Register or edit an OpenAI-compatible endpoint and discover its models. */
export class CustomProviderForm implements Component {
	#host: CustomProviderFormHost;
	#submitValues: (values: CustomProviderFormValues) => Promise<void>;
	#edit: CustomProviderFormOptions["edit"];
	#onCancel: () => void;
	#clearKey = false;
	/** Esc was pressed mid-save: the save still runs, but nothing reports back to a form nobody sees. */
	#abandoned = false;
	#inputs = FIELDS.map(field => {
		const input = new Input();
		input.prompt = field.prompt;
		input.mask = field.id === "apiKey";
		return input;
	});
	#index: number;
	#saving = false;
	#status: string | undefined;

	constructor(
		host: CustomProviderFormHost,
		submit: (values: CustomProviderFormValues) => Promise<void>,
		onCancel: () => void = () => host.finish("skipped"),
		options: CustomProviderFormOptions = {},
	) {
		this.#host = host;
		this.#submitValues = submit;
		this.#edit = options.edit;
		this.#onCancel = onCancel;
		this.#index = this.#edit ? 1 : 0;
		if (this.#edit) {
			this.#inputs[0].setValue(this.#edit.id);
			this.#inputs[1].setValue(this.#edit.baseUrl);
		}
		this.#inputs.forEach((input, index) => {
			input.onSubmit = value => void this.#submit(index, value);
			input.onEscape = onCancel;
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
		const edit = this.#edit;
		const label = edit?.hasKey && this.#index === KEY_FIELD ? "API key (blank keeps current key)" : field.label;
		const content = new Container();
		if (edit) content.addChild(new Text(theme.bold(label), 0, 0));
		content.addChild(this.#inputs[this.#index]);
		const intro = new Text(
			`${edit ? "Edit" : "Add"} an OpenAI-compatible endpoint; models are discovered from /v1/models. API keys are stored separately.`,
			0,
		);
		const canClearKey = edit?.hasKey && this.#index === KEY_FIELD;
		const hints = ["Enter continues", "Esc returns to provider list"];
		if (canClearKey) hints.push("Ctrl+X clear key");
		const status = this.#status ? new Text(this.#status, 0, 0) : undefined;
		const step = new WizardStep({
			kind: this.#saving ? "async" : "input",
			heading: new Text(theme.bold(edit ? `Edit provider ${edit.id}` : label), 0, 0),
			intro,
			content,
			status,
			footer: new Text(theme.fg("dim", hints.join(" · ")), 0, 0),
		});
		step.setMaxHeight(maxLines);
		return step.render(width);
	}

	handleInput(data: string): void {
		if (this.#saving) {
			if (matchesSelectCancel(data) && !this.#abandoned) {
				this.#abandoned = true;
				this.#onCancel();
			}
			return;
		}
		if (this.#edit?.hasKey && this.#index === KEY_FIELD && matchesKey(data, "ctrl+x")) {
			this.#clearKey = true;
			this.#inputs[KEY_FIELD].setValue("");
			this.#status = theme.fg("muted", "Stored key will be cleared on save.");
			this.#host.requestRender();
			return;
		}
		this.#inputs[this.#index].handleInput(data);
		if (this.#clearKey && this.#inputs[KEY_FIELD].getValue()) {
			this.#clearKey = false;
			this.#status = undefined;
		}
	}

	invalidate(): void {
		for (const input of this.#inputs) input.invalidate();
	}

	dispose(): void {
		for (const input of this.#inputs) input.focused = false;
		this.#host.restoreFocus();
	}

	async #submit(index: number, rawValue: string): Promise<void> {
		const value = rawValue.trim();
		if (index === 0 && !value) {
			this.#status = theme.fg("error", "Provider ID is required.");
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
			await this.#submitValues({
				id: this.#inputs[0].getValue().trim(),
				baseUrl: this.#inputs[1].getValue().trim(),
				apiKey: this.#clearKey ? "" : this.#inputs[KEY_FIELD].getValue().trim(),
				...(this.#clearKey ? { clearApiKey: true } : {}),
			});
			this.#status = theme.fg("success", "Provider saved. Its discovered models are available in the model picker.");
			this.#saving = false;
			if (!this.#abandoned) this.#host.finish("done");
		} catch (error) {
			// Nobody is looking at this form any more; do not take focus back from whatever replaced it.
			if (this.#abandoned) return;
			// The clear notice is replaced by the error below; a hidden pending clear must not fire on the retry.
			this.#clearKey = false;
			this.#index = this.#edit ? 1 : 0;
			this.#focusCurrent();
			const message = error instanceof Error ? error.message : String(error);
			this.#status = theme.fg(
				"error",
				message.includes("already configured")
					? `${message} Press Esc to return to the provider list, or enter a different provider ID.`
					: message,
			);
		} finally {
			this.#saving = false;
			this.#host.requestRender();
		}
	}

	#focusCurrent(): void {
		this.#inputs.forEach((input, index) => {
			input.focused = index === this.#index;
		});
		// Keep keyboard routing at the providers scene so Tab can switch panels
		// while the form is open; the active input still renders its cursor.
		this.#host.restoreFocus();
	}
}
