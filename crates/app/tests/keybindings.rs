//! Literal pi keybinding parity for both the TUI and coding-agent registries.

use std::collections::BTreeSet;

use omp_app::keybindings::{DEFAULT_BINDS, PI_ACTIONS, config::ConsoleKeybindings};
use omp_chat::input::normalize_chord;

/// Pi `getDefaultPasteImageKeys(process.platform)`.
#[cfg(target_os = "macos")]
const IMAGE_PASTE_KEYS: &[&str] = &["ctrl+v", "super+v"];
#[cfg(target_os = "windows")]
const IMAGE_PASTE_KEYS: &[&str] = &["ctrl+v", "alt+v"];
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const IMAGE_PASTE_KEYS: &[&str] = &["ctrl+v"];

/// Literal `TUI_KEYBINDINGS` plus coding-agent `KEYBINDINGS`, including
/// actions with no default. Keep this table line-for-line comparable with
/// `/work/pi/packages/{tui/src,coding-agent/src/config}/keybindings.ts`.
const PI_DEFAULTS: &[(&str, &[&str])] = &[
	("tui.editor.cursorUp", &["up"]),
	("tui.editor.cursorDown", &["down"]),
	("tui.editor.cursorLeft", &["left", "ctrl+b"]),
	("tui.editor.cursorRight", &["right", "ctrl+f"]),
	("tui.editor.cursorWordLeft", &["alt+left", "ctrl+left", "alt+b"]),
	("tui.editor.cursorWordRight", &["alt+right", "ctrl+right", "alt+f"]),
	("tui.editor.cursorLineStart", &["home", "ctrl+a"]),
	("tui.editor.cursorLineEnd", &["end", "ctrl+e"]),
	("tui.editor.jumpForward", &["ctrl+]"]),
	("tui.editor.jumpBackward", &["ctrl+alt+]"]),
	("tui.editor.pageUp", &["pageup"]),
	("tui.editor.pageDown", &["pagedown"]),
	("tui.editor.deleteCharBackward", &["backspace"]),
	("tui.editor.deleteCharForward", &["delete", "ctrl+d"]),
	("tui.editor.deleteWordBackward", &[
		"ctrl+w",
		"alt+backspace",
		"ctrl+backspace",
		"super+alt+backspace",
	]),
	("tui.editor.deleteWordForward", &["alt+delete", "alt+d", "super+alt+delete", "super+alt+d"]),
	("tui.editor.deleteToLineStart", &["ctrl+u"]),
	("tui.editor.deleteToLineEnd", &["ctrl+k"]),
	("tui.editor.yank", &["ctrl+y"]),
	("tui.editor.yankPop", &["alt+y"]),
	("tui.editor.undo", &["ctrl+-", "ctrl+_"]),
	("tui.editor.spellingSuggestions", &["ctrl+."]),
	("tui.input.newLine", &["shift+enter", "ctrl+j"]),
	("tui.input.submit", &["enter"]),
	("tui.input.tab", &["tab"]),
	("tui.input.copy", &["ctrl+c"]),
	("tui.select.up", &["up"]),
	("tui.select.down", &["down"]),
	("tui.select.pageUp", &["pageup"]),
	("tui.select.pageDown", &["pagedown"]),
	("tui.select.confirm", &["enter"]),
	("tui.select.cancel", &["escape", "ctrl+c"]),
	("app.interrupt", &["escape"]),
	("app.clear", &["ctrl+c"]),
	("app.exit", &["ctrl+d"]),
	("app.suspend", &["ctrl+z"]),
	("app.display.reset", &["alt+l"]),
	("app.thinking.cycle", &["shift+tab"]),
	("app.thinking.toggle", &["ctrl+t"]),
	("app.model.cycleForward", &["ctrl+p"]),
	("app.model.cycleBackward", &["shift+ctrl+p"]),
	("app.model.select", &["alt+m"]),
	("app.model.selectTemporary", &["alt+p"]),
	("app.tools.expand", &["ctrl+o"]),
	("app.tools.toggleVisibility", &["ctrl+shift+o"]),
	("app.editor.external", &["ctrl+g"]),
	("app.message.followUp", &["ctrl+q", "ctrl+enter"]),
	("app.retry", &["f5", "alt+r"]),
	("app.message.dequeue", &["alt+up", "shift+up"]),
	("app.clipboard.pasteImage", IMAGE_PASTE_KEYS),
	("app.clipboard.pasteTextRaw", &["ctrl+shift+v", "alt+shift+v"]),
	("app.clipboard.copyLine", &["alt+shift+l"]),
	("app.clipboard.copyPrompt", &["alt+shift+c"]),
	("app.session.new", &[]),
	("app.session.tree", &[]),
	("app.session.fork", &[]),
	("app.session.resume", &[]),
	("app.agents.hub", &["alt+a"]),
	("app.session.observe", &["ctrl+s"]),
	("app.session.togglePath", &["ctrl+p"]),
	("app.session.toggleSort", &["ctrl+s"]),
	("app.session.rename", &["ctrl+r"]),
	("app.session.delete", &["ctrl+d"]),
	("app.session.deleteNoninvasive", &["ctrl+backspace"]),
	("app.tree.foldOrUp", &["ctrl+left", "alt+left"]),
	("app.tree.unfoldOrDown", &["ctrl+right", "alt+right"]),
	("app.plan.toggle", &["alt+shift+p"]),
	("app.history.search", &["ctrl+r"]),
	("app.stt.toggle", &[]),
	("app.live.toggle", &["ctrl+l"]),
];

fn default_bindings() -> ConsoleKeybindings {
	let ctx = omp_con::Ctx::new();
	ctx.exec(DEFAULT_BINDS, omp_con::Source::Config("default-binds.cfg".into()))
		.expect("default bind cfg executes");
	ConsoleKeybindings::from_ctx(&ctx).expect("default chords normalize")
}

#[test]
fn literal_full_pi_keymap_is_expressed_by_default_cfg() {
	let bindings = default_bindings();
	let action_commands: std::collections::BTreeMap<_, _> = PI_ACTIONS.iter().copied().collect();
	let declared_actions: BTreeSet<_> = PI_ACTIONS.iter().map(|(action, _)| *action).collect();
	let oracle_actions: BTreeSet<_> = PI_DEFAULTS.iter().map(|(action, _)| *action).collect();
	assert_eq!(declared_actions, oracle_actions, "migration table must cover the full pi keymap");

	let mut oracle_chords = BTreeSet::new();
	for (action, chords) in PI_DEFAULTS {
		let command = action_commands[action];
		for chord in *chords {
			let chord = normalize_chord(chord).expect("literal pi chord normalizes");
			oracle_chords.insert(chord.clone());
			let script = bindings
				.command_for(chord.as_str())
				.unwrap_or_else(|| panic!("{action} default `{chord}` is not bound"));
			assert!(
				script
					.split(";")
					.any(|statement| statement.trim() == command),
				"{action} default `{chord}` runs `{script}`, missing `{command}`"
			);
		}
	}
	// Owner override: Ctrl+Shift+D is omp's direct Debug menu chord. Pi has
	// the menu but no default chord; keep the deviation explicit instead of
	// weakening the literal pi oracle.
	let debug = normalize_chord("ctrl+shift+d").expect("debug chord normalizes");
	assert_eq!(bindings.command_for(debug.as_str()), Some("debug"));
	oracle_chords.insert(debug);
	let actual_chords: BTreeSet<_> = bindings.bindings.keys().cloned().collect();
	assert_eq!(
		actual_chords, oracle_chords,
		"default cfg has an unreviewed chord or misses a pi/owner chord"
	);
}

#[test]
fn custom_editor_actions_precede_colliding_base_editor_defaults() {
	let bindings = default_bindings();
	assert_eq!(
		bindings.command_for("ctrl+c"),
		Some("cl_clear; cl_interrupt; ed_copy"),
		"the custom editor clear action precedes base-editor copy"
	);
	assert_eq!(
		bindings.command_for("ctrl+d"),
		Some("panel_delete; cl_exit; ed_delete"),
		"panel deletion gets first refusal, then custom editor exit precedes base deletion"
	);
}

#[test]
fn every_default_bind_names_registered_console_commands() {
	let ctx = omp_con::Ctx::new();
	for (_, script) in default_bindings().bindings {
		for statement in script.split(";") {
			let name = statement
				.split_whitespace()
				.next()
				.expect("non-empty bind statement");
			assert!(ctx.find(name).is_some(), "bind runs unknown console name `{name}`");
		}
	}
}

#[test]
fn process_ctx_seeds_defaults_then_lets_config_cfg_override() {
	let config = tempfile::tempdir().expect("config directory");
	// SAFETY: nextest runs each test in its own process; nothing else reads the
	// variable concurrently.
	unsafe { std::env::set_var("OMP_CONFIG_DIR", config.path()) };
	std::fs::write(config.path().join("config.cfg"), "unbind alt+p\nbind alt+x cl_model_select\n")
		.expect("user cfg");
	let project = tempfile::tempdir().expect("project directory");
	let ctx = omp_app::process_ctx(project.path()).expect("process ctx");
	let bindings = ConsoleKeybindings::from_ctx(&ctx).expect("bindings");
	assert_eq!(bindings.command_for("alt+p"), None, "config.cfg unbinds a default");
	assert_eq!(bindings.command_for("alt+x"), Some("cl_model_select"));
	assert_eq!(bindings.command_for("shift+tab"), Some("cl_thinking_cycle"));
	assert_eq!(bindings.command_for("ctrl+t"), Some("toggle cl_showthinking"));
}
