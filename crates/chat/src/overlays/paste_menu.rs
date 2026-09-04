//! Large-paste menu: a marker-sized paste of
//! at least `cl_paste_large_menu_threshold` lines asks how to land it —
//! wrapped in `<attachment>` tags, saved as a `local://paste-N.md` file the
//! agent can `read`, or collapsed to an inline chip. Esc keeps the default
//! chip so the pasted content is never lost.

use omp_core::{Str, sf};
use omp_tui::{Frame, Key, Size, Ui, UiContext, dom};
use strum::{EnumCount, EnumProperty, IntoStaticStr, VariantArray};

use super::{Panel, PanelAnchor, PanelEvent, Services, services::ServiceError};

/// Overlay id reported through `HostCommand::Overlay`.
pub const ID: &str = "paste-menu";

/// How the user asked to land a large paste.
#[derive(
	Clone, Copy, Debug, Eq, PartialEq, EnumCount, EnumProperty, IntoStaticStr, VariantArray,
)]
pub enum PasteChoice {
	/// Chip whose submitted form is the text wrapped in `<attachment>` tags.
	#[strum(
		to_string = "Attach as a wrapped block",
		props(description = "Wrap the text in <attachment> tags, collapsed to a marker")
	)]
	Wrapped,
	/// Text saved under the session's `local://` root; the draft gets the
	/// URL.
	#[strum(
		to_string = "Attach as local file",
		props(description = "Save the text to a local://paste file")
	)]
	LocalFile,
	/// Plain chip (the default paste behavior).
	#[strum(
		to_string = "Paste inline",
		props(description = "Collapse the text to an inline paste marker")
	)]
	Inline,
}

impl PasteChoice {
	fn label(self) -> &'static str {
		self.into()
	}

	fn description(self) -> &'static str {
		self
			.get_str("description")
			.expect("every paste choice declares a description")
	}
}

/// Wraps a large paste in one quoted block for the model.
#[must_use]
pub fn wrap_in_attachment_block(text: &str) -> String {
	let mut wrapped = String::with_capacity(text.len() + 28);
	wrapped.push_str("<attachment>\n");
	wrapped.push_str(text);
	wrapped.push_str("\n</attachment>");
	wrapped
}

/// Saves `text` as the next free
/// `local://paste-N.md` of the live session and returns the URL. The host
/// inserts it into the draft; a failed write falls back to a chip.
pub fn save_paste_file(services: &dyn Services, text: &str) -> Result<Str, ServiceError> {
	// Failure to inspect the local store is not evidence that `paste-1.md`
	// is free. Propagate it so the caller can restore the inline chip rather
	// than risk replacing an earlier paste.
	let taken = services.list_local(".md")?;
	let mut counter = 0_u32;
	let name = loop {
		counter += 1;
		let name = sf!("paste-{counter}.md");
		if !taken
			.iter()
			.any(|url| url.as_str().strip_prefix("local://") == Some(name.as_str()))
		{
			break name;
		}
	};
	services.write_local(&name, text)
}

/// Modal three-way selector over one pending large paste.
pub struct PasteMenu {
	text:     Str,
	lines:    usize,
	selected: usize,
	ui:       Ui,
	ctx:      UiContext,
	width:    u16,
}

impl PasteMenu {
	/// Opens the menu for a paste of `lines` lines.
	#[must_use]
	pub fn new(text: Str, lines: usize, ctx: &UiContext) -> Self {
		let mut panel = Self {
			text,
			lines,
			selected: 0,
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 80,
		};
		panel.rebuild();
		panel
	}

	fn step(&mut self, delta: isize) {
		let count = PasteChoice::COUNT as isize;
		self.selected = (self.selected as isize + delta).rem_euclid(count) as usize;
		self.rebuild();
	}

	fn choose(&self, choice: PasteChoice) -> PanelEvent {
		PanelEvent::Paste { text: self.text.clone(), choice }
	}

	fn rebuild(&mut self) {
		let rows = PasteChoice::VARIANTS
			.iter()
			.enumerate()
			.map(|(index, choice)| (index == self.selected, choice.label(), choice.description()))
			.collect::<Vec<_>>();
		let title = sf!("Pasted {} lines", self.lines);
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					for (selected, label, description) in rows {
						<row>
							if selected { <icon name="cursor" fg=accent/> } else { <pre>{"  "}</pre> }
							<pre fg={if selected { "accent" } else { "fg" }}>{label}</pre>
							<pre fg=muted>{"  "}{description}</pre>
						</row>
					}
					<text fg=muted>{"↑/↓ select · Enter choose · Esc to paste inline"}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}
}

impl Panel for PasteMenu {
	fn id(&self) -> &'static str {
		ID
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			// Restores the held paste as the default inline chip when the
			// selector is cancelled, so neither the pending content nor the
			// draft around its insertion point is lost.
			Key::Esc | Key::Ctrl('c') => self.choose(PasteChoice::Inline),
			Key::Up => {
				self.step(-1);
				PanelEvent::Consumed
			},
			Key::Down => {
				self.step(1);
				PanelEvent::Consumed
			},
			Key::Enter => self.choose(PasteChoice::VARIANTS[self.selected]),
			Key::Char(digit @ '1'..='3') => {
				let index = usize::from(digit as u8 - b'1');
				self.choose(PasteChoice::VARIANTS[index])
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn paste(&mut self, _text: &str) -> PanelEvent {
		// This selector is modal. A second paste must not leak into the
		// hidden composer while the first remains pending.
		PanelEvent::Consumed
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if self.width != viewport.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}
}

#[cfg(test)]
mod tests {
	use parking_lot::Mutex;

	use super::*;
	use crate::overlays::services::ServiceResult;

	fn menu() -> PasteMenu {
		PasteMenu::new(Str::new("line\n".repeat(120)), 120, &UiContext::default())
	}

	#[test]
	fn enter_picks_the_highlighted_choice_and_esc_falls_back_to_inline() {
		let mut panel = menu();
		assert_eq!(panel.key(Key::Enter), PanelEvent::Paste {
			text:   panel.text.clone(),
			choice: PasteChoice::Wrapped,
		});
		panel.key(Key::Down);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Paste {
			text:   panel.text.clone(),
			choice: PasteChoice::LocalFile,
		});
		panel.key(Key::Up);
		panel.key(Key::Up);
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::Paste { text: panel.text.clone(), choice: PasteChoice::Inline },
			"selection wraps around"
		);
		assert_eq!(panel.key(Key::Esc), PanelEvent::Paste {
			text:   panel.text.clone(),
			choice: PasteChoice::Inline,
		});
		assert_eq!(panel.key(Key::Char('2')), PanelEvent::Paste {
			text:   panel.text.clone(),
			choice: PasteChoice::LocalFile,
		});
	}

	#[test]
	fn title_names_the_line_count_and_lists_pi_choices() {
		let mut panel = menu();
		let text = omp_tui::frame_text(panel.frame(Size::new(80, 24)));
		assert!(text.contains("Pasted 120 lines"), "{text}");
		for choice in PasteChoice::VARIANTS {
			assert!(text.contains(choice.label()), "{text}");
		}
	}

	#[test]
	fn modal_menu_refuses_a_second_paste_without_changing_the_pending_choice() {
		let mut panel = menu();
		assert_eq!(panel.paste("must not reach the composer"), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Paste {
			text:   panel.text.clone(),
			choice: PasteChoice::Wrapped,
		});
	}

	#[test]
	fn wrapped_block_matches_pi() {
		assert_eq!(wrap_in_attachment_block("a\nb"), "<attachment>\na\nb\n</attachment>");
	}

	#[derive(Default)]
	struct LocalStore {
		files: Mutex<Vec<(Str, Str)>>,
	}

	impl Services for LocalStore {
		fn list_local(&self, suffix: &str) -> ServiceResult<Vec<Str>> {
			Ok(self
				.files
				.lock()
				.iter()
				.filter(|(name, _)| name.ends_with(suffix))
				.map(|(name, _)| sf!("local://{name}"))
				.collect())
		}

		fn write_local(&self, name: &str, content: &str) -> ServiceResult<Str> {
			self.files.lock().push((Str::new(name), Str::new(content)));
			Ok(sf!("local://{name}"))
		}
	}

	#[test]
	fn local_file_takes_the_next_free_paste_number() {
		let store = LocalStore::default();
		assert_eq!(save_paste_file(&store, "one").unwrap(), "local://paste-1.md");
		assert_eq!(save_paste_file(&store, "two").unwrap(), "local://paste-2.md");
		let files = store.files.lock();
		assert_eq!(files[0], (Str::new_static("paste-1.md"), Str::new_static("one")));
		assert_eq!(files[1], (Str::new_static("paste-2.md"), Str::new_static("two")));
	}

	struct UnreadableStore;

	impl Services for UnreadableStore {
		fn list_local(&self, _suffix: &str) -> ServiceResult<Vec<Str>> {
			Err(ServiceError::Unavailable("local store"))
		}
	}

	#[test]
	fn local_file_never_guesses_a_free_name_when_listing_fails() {
		assert_eq!(
			save_paste_file(&UnreadableStore, "replacement"),
			Err(ServiceError::Unavailable("local store"))
		);
	}
}
