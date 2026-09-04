//! `/move` directory editor and missing-directory confirmation.
//!
//! The editor keeps a real one-line editor
//! focused, lists matching child directories, accepts the highlighted path
//! with Tab or Enter, and sends the chosen path back through the console
//! command stream. Filesystem mutation remains in the application controller
//! (ADR 0005).

use std::path::{Path, PathBuf};

use omp_core::{Str, sf};
use omp_tui::{Frame, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, dom};

use super::{Panel, PanelAnchor, PanelEvent};
use crate::{
	commands::workspace::{directory_choices, quote_console_atom},
	host::HostCommand,
};

/// Stable panel identity reported to the host.
pub const ID: &str = "move";
const INPUT_ID: &str = "move-path";
const EMPTY_ID: &str = "move-empty";
const OPTION_PREFIX: &str = "move-option:";
const TITLE: &str = "Move to directory";
const INPUT_HINT: &str = "Type to filter · ↑↓ navigate · Tab accept · Enter confirm · Esc cancel";
const CONFIRM_HINT: &str = "y/Enter create and move · n/Esc cancel";
const MAX_RESULTS: usize = 15;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Choice {
	value: Str,
	label: Str,
}

enum Mode {
	Input,
	Confirm(PathBuf),
}

/// Focused directory autocomplete editor used by a bare `/move`.
pub struct MovePanel {
	cwd:      PathBuf,
	input:    Str,
	choices:  Vec<Choice>,
	selected: usize,
	mode:     Mode,
	ui:       Ui,
	ctx:      UiContext,
	width:    u16,
}

impl MovePanel {
	/// Opens the path editor over the current working directory.
	#[must_use]
	pub fn open(cwd: PathBuf, viewport: Size, ctx: &UiContext) -> Self {
		let mut panel = Self {
			cwd,
			input: Str::default(),
			choices: Vec::new(),
			selected: 0,
			mode: Mode::Input,
			ui: Ui::from_root(dom! { <col/> }, viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			width: viewport.width,
		};
		panel.rebuild();
		panel
	}

	/// Opens only the confirmation step for a missing target.
	#[must_use]
	pub fn confirm(target: PathBuf, viewport: Size, ctx: &UiContext) -> Self {
		let cwd = target
			.parent()
			.map_or_else(|| PathBuf::from("."), Path::to_path_buf);
		let mut panel = Self {
			cwd,
			input: Str::default(),
			choices: Vec::new(),
			selected: 0,
			mode: Mode::Confirm(target),
			ui: Ui::from_root(dom! { <col/> }, viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			width: viewport.width,
		};
		panel.rebuild();
		panel
	}

	/// Current editor text.
	#[must_use]
	pub fn input(&self) -> &str {
		&self.input
	}

	/// Highlighted completion value, if any.
	#[must_use]
	pub fn selected(&self) -> Option<&str> {
		self
			.choices
			.get(self.selected)
			.map(|choice| choice.value.as_str())
	}

	fn rebuild(&mut self) {
		self.ui = match &self.mode {
			Mode::Input => self.build_input(),
			Mode::Confirm(target) => self.build_confirm(target),
		};
		if matches!(self.mode, Mode::Input) {
			self.refresh_choices();
		}
	}

	fn build_input(&self) -> Ui {
		let current = sf!("Current: {}", self.cwd.display());
		let value = self.input.clone();
		let tree = dom! {
			<box border=round title={TITLE} pad-x=1>
				<col>
					<text fg=muted truncate>{current}</text>
					<input id={INPUT_ID} value={value} placeholder="Type a directory path…" submit/>
					<hr border=round/>
					for index in 0..MAX_RESULTS {
						<button id={sf!("{OPTION_PREFIX}{index}")} variant=ghost active={index == self.selected}>{""}</button>
					}
					<text id={EMPTY_ID} fg=muted>{"No matching directories"}</text>
					<hr border=round/>
					<text fg=muted truncate>{INPUT_HINT}</text>
				</col>
			</box>
		};
		Ui::from_root(tree, self.width, self.ctx.clone())
	}

	fn build_confirm(&self, target: &Path) -> Ui {
		let name = target
			.file_name()
			.and_then(|name| name.to_str())
			.unwrap_or_default();
		let question = sf!("\"{name}\" does not exist. Create it?");
		let destination = sf!("Destination: {}", target.display());
		let tree = dom! {
			<box border=round title="Create directory?" pad-x=1>
				<col>
					<text fg=warn>{question}</text>
					<text fg=muted truncate>{destination}</text>
					<hr border=round/>
					<text fg=muted truncate>{CONFIRM_HINT}</text>
				</col>
			</box>
		};
		Ui::from_root(tree, self.width, self.ctx.clone())
	}

	fn refresh_choices(&mut self) {
		self.choices = directory_choices(self.input.as_str(), &self.cwd, MAX_RESULTS, true)
			.into_iter()
			.map(|choice| Choice { value: choice.value, label: choice.label })
			.collect();
		self.selected = self.selected.min(self.choices.len().saturating_sub(1));
		for index in 0..MAX_RESULTS {
			let id = sf!("{OPTION_PREFIX}{index}");
			if let Some(choice) = self.choices.get(index) {
				self
					.ui
					.set_prop(id.as_str(), Prop::Label, choice.label.clone());
				self.ui.set_visible(id.as_str(), true);
				self
					.ui
					.set_prop(id.as_str(), Prop::Active, index == self.selected);
			} else {
				self.ui.set_visible(id.as_str(), false);
			}
		}
		self
			.ui
			.set_visible(EMPTY_ID, self.choices.is_empty() && !self.input.is_empty());
	}

	fn move_selection(&mut self, delta: isize) -> PanelEvent {
		if self.choices.is_empty() {
			return PanelEvent::Consumed;
		}
		let next = self
			.selected
			.saturating_add_signed(delta)
			.min(self.choices.len().saturating_sub(1));
		if next != self.selected {
			let previous = sf!("{OPTION_PREFIX}{}", self.selected);
			self.ui.set_prop(previous.as_str(), Prop::Active, false);
			self.selected = next;
			let selected = sf!("{OPTION_PREFIX}{}", self.selected);
			self.ui.set_prop(selected.as_str(), Prop::Active, true);
		}
		PanelEvent::Consumed
	}

	fn accept_completion(&mut self) -> PanelEvent {
		let Some(choice) = self.choices.get(self.selected) else {
			return PanelEvent::Consumed;
		};
		self.input = choice.value.clone();
		self.selected = 0;
		// Rebuilding only for completion acceptance intentionally places the
		// caret at the end of the accepted path. Ordinary edits stay in the
		// retained input, preserving the user's real cursor position.
		self.rebuild();
		PanelEvent::Consumed
	}

	fn submit(&self) -> PanelEvent {
		let path = self
			.choices
			.get(self.selected)
			.map(|choice| choice.value.as_str())
			.unwrap_or_else(|| self.input.as_str().trim());
		if path.is_empty() {
			return PanelEvent::Close;
		}
		let mut line = String::from("move ");
		quote_console_atom(&mut line, path);
		PanelEvent::Finish(Str::new(line))
	}

	fn input_event(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Submit => self.submit(),
			UiEvent::Changed { id, value } if id.as_str() == INPUT_ID => {
				self.input = value;
				self.selected = 0;
				self.refresh_choices();
				PanelEvent::Consumed
			},
			UiEvent::Pressed(id) => {
				let Some(index) = id
					.as_str()
					.strip_prefix(OPTION_PREFIX)
					.and_then(|index| index.parse::<usize>().ok())
				else {
					return PanelEvent::Consumed;
				};
				if index < self.choices.len() {
					self.selected = index;
					self.submit()
				} else {
					PanelEvent::Consumed
				}
			},
			UiEvent::Copied(text) => PanelEvent::Copy(text),
			_ => PanelEvent::Consumed,
		}
	}

	fn confirm_key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Char('y' | 'Y') | Key::Enter => {
				let Mode::Confirm(path) = &self.mode else {
					return PanelEvent::Consumed;
				};
				PanelEvent::FinishCommand(HostCommand::Move { path: path.clone(), create: true })
			},
			Key::Char('n' | 'N') | Key::Esc => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}
}

impl Panel for MovePanel {
	fn id(&self) -> &'static str {
		ID
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if matches!(self.mode, Mode::Confirm(_)) {
			return self.confirm_key(key);
		}
		match key {
			Key::Esc => PanelEvent::Close,
			Key::Enter => self.submit(),
			Key::Tab => self.accept_completion(),
			Key::Up => self.move_selection(-1),
			Key::Down => self.move_selection(1),
			Key::PageUp => self.move_selection(-5),
			Key::PageDown => self.move_selection(5),
			_ => {
				let event = self.ui.handle_key(key);
				self.input_event(event)
			},
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		if matches!(self.mode, Mode::Confirm(_)) {
			return PanelEvent::Consumed;
		}
		let event = self.ui.handle_paste(text);
		self.input_event(event)
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		if matches!(self.mode, Mode::Confirm(_)) {
			return PanelEvent::Consumed;
		}
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.input_event(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::{Mods, Mouse, MouseButton, frame_text};
	use tempfile::TempDir;

	use super::*;

	fn fixture() -> (TempDir, MovePanel) {
		let dir = tempfile::tempdir().expect("tempdir");
		std::fs::create_dir(dir.path().join("alpha")).expect("alpha");
		std::fs::create_dir(dir.path().join("beta")).expect("beta");
		std::fs::create_dir(dir.path().join(".hidden")).expect("hidden");
		std::fs::create_dir(dir.path().join("My Project")).expect("spaced");
		std::fs::write(dir.path().join("README.md"), "not a directory").expect("file");
		let panel =
			MovePanel::open(dir.path().to_path_buf(), Size::new(80, 30), &UiContext::default());
		(dir, panel)
	}

	fn point(text: &str, needle: &str) -> (u16, u16) {
		text
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				line
					.find(needle)
					.map(|col| (u16::try_from(col).expect("col"), u16::try_from(row).expect("row")))
			})
			.expect("needle in frame")
	}

	#[test]
	fn current_directory_and_only_child_directories_are_suggested() {
		let (dir, mut panel) = fixture();
		let text = frame_text(panel.frame(Size::new(80, 30)));
		assert!(text.contains(&format!("Current: {}", dir.path().display())));
		assert!(text.contains("alpha/"));
		assert!(text.contains("beta/"));
		assert!(!text.contains(".hidden/"));
		assert!(!text.contains("README.md"));
	}

	#[test]
	fn typed_selected_tabbed_and_quoted_paths_use_the_typed_move_route() {
		let (_dir, mut panel) = fixture();
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(Str::new_static("move \"alpha/\"")));

		let (_dir, mut panel) = fixture();
		assert_eq!(panel.key(Key::Tab), PanelEvent::Consumed);
		assert_eq!(panel.input(), "alpha/");
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(Str::new_static("move \"alpha/\"")));

		let (_dir, mut panel) = fixture();
		assert_eq!(panel.paste("\"My Project\""), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(Str::new_static("move \"My Project\"")));

		let (_dir, mut panel) = fixture();
		panel.paste("zz");
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(Str::new_static("move \"zz\"")));
	}

	#[test]
	fn escape_cancels_and_confirmation_sends_create_move() {
		let (_dir, mut panel) = fixture();
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
		let target = PathBuf::from("/tmp/new project");
		let mut confirm =
			MovePanel::confirm(target.clone(), Size::new(80, 30), &UiContext::default());
		assert_eq!(
			confirm.key(Key::Enter),
			PanelEvent::FinishCommand(HostCommand::Move { path: target, create: true })
		);
	}

	#[test]
	fn pointer_activation_confirms_the_clicked_directory() {
		let (_dir, mut panel) = fixture();
		let text = frame_text(panel.frame(Size::new(80, 30)));
		let (col, row) = point(&text, "beta/");
		let event = panel.mouse(MouseReport {
			kind: Mouse::Click,
			col,
			row,
			button: MouseButton::Left,
			mods: Mods::default(),
			pressed: true,
		});
		assert_eq!(event, PanelEvent::Finish(Str::new_static("move \"beta/\"")));
	}
}
