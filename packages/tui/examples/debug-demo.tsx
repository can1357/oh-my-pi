/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A small pi-tui app for the repository's `tui` debug tool
 * (`tui start file=packages/tui/examples/debug-demo.tsx`): a keyed title, a
 * focused `input`, and a `list`. Tab moves the focus between the input and the
 * list, Up/Down move the list's selection, Ctrl+C quits.
 */
import { batch, createSurface, signal, startHost, type UiNode } from "@oh-my-pi/pi-tui";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");
const name = signal({ text: "", cursor: 0 });
const CHOICES = ["alpha", "beta", "gamma"];
const selected = signal(CHOICES[0]!);
let input: UiNode | undefined;
let choices: UiNode | undefined;

const surface = createSurface(() => ({
	main: <text key="title" text="OMP TUI debug demo" />,
	dock: (
		<col key="form">
			<input
				key="input"
				ref={node => (input = node)}
				prompt="Name: "
				sendable={false}
				text={() => name().text}
				cursor={() => name().cursor}
				onEdit={edit => {
					const line = name.peek();
					if (edit.len !== line.text.length) return;
					batch(() =>
						name.set({
							text: `${line.text.slice(0, edit.from)}${edit.text}${line.text.slice(edit.to)}`,
							cursor: edit.cursor,
						}),
					);
				}}
			/>
			<list
				key="choices"
				ref={node => (choices = node)}
				selected={selected}
				onSelect={item => selected.set(item)}
				onKey={key => {
					const step = key.id === "down" ? 1 : key.id === "up" ? -1 : 0;
					if (step === 0) return false;
					const at = CHOICES.indexOf(selected.peek());
					selected.set(CHOICES[(at + step + CHOICES.length) % CHOICES.length]!);
					return true;
				}}
			>
				{CHOICES.map(choice => (
					<item key={choice} label={choice} />
				))}
			</list>
		</col>
	),
}));
surface.focus(input ?? null);

const host = await startHost({
	surface,
	theme: () => theme,
	title: "debug demo",
	onKey: key => {
		if (key.id === "ctrl+c") {
			void host.stop().then(() => process.exit(0));
			return true;
		}
		if (key.id === "tab") {
			surface.focus(surface.focused() === input ? (choices ?? null) : (input ?? null));
			return true;
		}
		return false;
	},
});
