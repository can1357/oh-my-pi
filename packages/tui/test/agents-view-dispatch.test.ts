import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { type AgentsViewHost, AgentsViewComponent, createAgentsViewState } from "../src/apps/agents-view";
import { VirtualTerminal } from "./virtual-terminal";

function type(component: AgentsViewComponent, text: string): void {
	for (const char of text) component.handleInput(char);
}

// The view awaited `launch` before the test does, so its continuation has run
// by the time the test's own `await launch.promise` resumes.
/** A view whose launches wait on `launch`; `dispatched` records the prompts. */
function setup() {
	const launch = Promise.withResolvers<string>();
	const dispatched: string[] = [];
	const host: AgentsViewHost = {
		list: async () => [],
		dispatch: prompt => {
			dispatched.push(prompt);
			return launch.promise;
		},
		stop: async () => {},
	};
	const state = createAgentsViewState();
	const component = new AgentsViewComponent(new TUI(new VirtualTerminal(80, 24)), state, host);
	return { launch, dispatched, state, component };
}

describe("agents view dispatch", () => {
	it("keeps what the user types while a launch is pending", async () => {
		const { launch, dispatched, state, component } = setup();
		type(component, "first");
		component.handleInput("\r");
		type(component, "second");
		launch.resolve("agent-1");
		await launch.promise;
		component.dispose();
		expect(dispatched).toEqual(["first"]);
		expect(state.draft).toBe("second");
		expect(state.selectedKey).toBe("agent-1");
	});

	it("gives a failed prompt back only when the line is still empty", async () => {
		const empty = setup();
		type(empty.component, "first");
		empty.component.handleInput("\r");
		empty.launch.reject(new Error("daemon down"));
		await empty.launch.promise.catch(() => {});
		empty.component.dispose();
		expect(empty.state.draft).toBe("first");

		const typed = setup();
		type(typed.component, "first");
		typed.component.handleInput("\r");
		type(typed.component, "second");
		typed.launch.reject(new Error("daemon down"));
		await typed.launch.promise.catch(() => {});
		typed.component.dispose();
		expect(typed.state.draft).toBe("second");
	});
});
