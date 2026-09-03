import { type Component, Input, matchesKey, ProcessTerminal, Text, TUI } from "../src";

class DemoChoices implements Component {
	debugId = "choices";
	debugKind = "ChoiceList";
	readonly #choices = ["alpha", "beta", "gamma"];
	#selected = 0;

	render(_width: number): readonly string[] {
		return this.#choices.map((choice, index) => `${index === this.#selected ? ">" : " "} ${choice}`);
	}

	debugState(): Record<string, unknown> {
		return { selected: this.#choices[this.#selected] };
	}
}

const tui = new TUI(new ProcessTerminal());
const title = new Text("OMP TUI debug demo", 0, 0);
const debugTitle: Component = title;
debugTitle.debugId = "title";
const input = new Input();
const debugInput: Component = input;
debugInput.debugId = "input";
input.prompt = "Name: ";

const choices = new DemoChoices();
tui.addChild(title);
tui.addChild(input);
tui.addChild(choices);
tui.setFocus(input);
tui.addInputListener(data => {
	if (!matchesKey(data, "ctrl+c")) return undefined;
	tui.stop();
	process.exit(0);
});
tui.start();
