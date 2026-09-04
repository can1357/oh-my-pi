//! Git workbench and transcript copy commands. `/git` opens
//! the fullscreen workbench over the session's project root; `/copy` opens
//! the transcript picker, or with `code`/`cmd`/`link` copies the last fenced
//! block, shell command, or hyperlink straight from the replica through a
//! host call; `/open` hands the last hyperlink to the system opener.

use omp_con::ConError;
use omp_core::{Str, sf};
use omp_tui::Icon;

use super::{PaletteEntry, rest};
use crate::{
	actions::{HostAction, post},
	markdown::last_link,
	overlays::{
		Panel, PanelCall, PanelEvent, PanelOpener,
		copy::{CopySelector, last_code_block, last_command},
		git::GitWorkbench,
	},
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "git", icon: Icon::Branch },
	PaletteEntry { name: "copy", icon: Icon::Copy },
	PaletteEntry { name: "open", icon: Icon::Globe },
];

/// `/copy` argument forms.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CopyOp {
	/// Open the transcript picker.
	Picker,
	/// Copy the last fenced code block.
	Code,
	/// Copy the last `bash`/`eval` command.
	Command,
	/// Copy the last hyperlink of an assistant message.
	Link,
}

/// Parses `/copy [code|cmd|link]`; other input returns its usage line.
pub fn copy_op(words: Option<Str>) -> Result<CopyOp, ConError> {
	let arg = words.unwrap_or_default();
	let arg = arg.as_str().trim().to_ascii_lowercase();
	Ok(match arg.as_str() {
		"" => CopyOp::Picker,
		"code" => CopyOp::Code,
		"cmd" | "command" => CopyOp::Command,
		"link" | "url" => CopyOp::Link,
		_ => return Err(ConError::Usage(Str::new_static("Usage: /copy [code|cmd|link]"))),
	})
}

/// Validates `/open [link]`; other input points at the picker's `o`.
pub fn open_op(words: Option<Str>) -> Result<(), ConError> {
	let arg = words.unwrap_or_default();
	match arg.as_str().trim().to_ascii_lowercase().as_str() {
		"" | "link" | "url" => Ok(()),
		_ => Err(ConError::Usage(Str::new_static(
			"Usage: /open [link]  (pick a specific link: /copy, → blocks, o)",
		))),
	}
}

omp_con::cmd! {
	/// Opens the git UI (split diff viewer, staging, commit composer); a revision pins the view to that commit.
	git(?revision: Str) = |ctx, args| {
		let revision = rest(args, 0);
		post(ctx, HostAction::Open(PanelOpener::new(move |cx| {
			GitWorkbench::open(cx, revision.clone()).map(|panel| Box::new(panel) as Box<dyn Panel>)
		})))
	};

	/// Picks text or code from the conversation to copy: `/copy [code|cmd|link]`.
	copy(?what: Str) = |ctx, args| {
		match copy_op(rest(args, 0))? {
			CopyOp::Picker => post(ctx, HostAction::Open(PanelOpener::new(|cx| {
				let show_thinking =
					crate::settings::CL_SHOWTHINKING.try_get(cx.con).unwrap_or(true);
				let show_tools = crate::actions::CL_SHOWTOOLS.try_get(cx.con).unwrap_or(true);
				let prose_only =
					crate::transcript::CL_THINKING_PROSE_ONLY.try_get(cx.con).unwrap_or(true);
				let panel =
					CopySelector::open(cx.dom, show_thinking, show_tools, prose_only, cx.ui);
				if panel.target_count() == 0 {
					return Err(Str::new_static("Nothing to copy yet."));
				}
				Ok(Box::new(panel) as Box<dyn Panel>)
			}))),
			CopyOp::Code => post(ctx, HostAction::Call(PanelCall::new(|cx| {
				last_code_block(cx.dom).map_or_else(
					|| PanelEvent::Notice(Str::new_static("No code block to copy.")),
					|block| PanelEvent::Copy(block.content),
				)
			}))),
			CopyOp::Command => post(ctx, HostAction::Call(PanelCall::new(|cx| {
				last_command(cx.dom).map_or_else(
					|| PanelEvent::Notice(Str::new_static("No command to copy.")),
					|(_, code)| PanelEvent::Copy(code),
				)
			}))),
			CopyOp::Link => post(ctx, HostAction::Call(PanelCall::new(|cx| {
				last_link(cx.dom).map_or_else(
					|| PanelEvent::Notice(Str::new_static("No link to copy.")),
					|link| PanelEvent::Copy(link.href),
				)
			}))),
		}
	};

	/// Opens the last link from the conversation in your browser (or pick one with /copy).
	open(?what: Str) = |ctx, args| {
		open_op(rest(args, 0))?;
		post(ctx, HostAction::Call(PanelCall::new(|cx| {
			last_link(cx.dom).map_or_else(
				|| PanelEvent::Notice(Str::new_static("No link to open.")),
				|link| {
					omp_core::open::open_path(link.href.as_str());
					PanelEvent::Notice(sf!("Opening {}", link.href))
				},
			)
		})))
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn copy_words_select_the_picker_code_or_command() {
		assert_eq!(copy_op(None).unwrap(), CopyOp::Picker);
		assert_eq!(copy_op(Some(Str::new_static("code"))).unwrap(), CopyOp::Code);
		assert_eq!(copy_op(Some(Str::new_static("CMD"))).unwrap(), CopyOp::Command);
		assert_eq!(copy_op(Some(Str::new_static("command"))).unwrap(), CopyOp::Command);
		assert_eq!(copy_op(Some(Str::new_static("link"))).unwrap(), CopyOp::Link);
		assert_eq!(copy_op(Some(Str::new_static("URL"))).unwrap(), CopyOp::Link);
		let error = copy_op(Some(Str::new_static("all"))).unwrap_err();
		assert!(error.to_string().contains("Usage: /copy [code|cmd|link]"), "{error}");
	}

	#[test]
	fn open_accepts_only_the_link_words() {
		assert!(open_op(None).is_ok());
		assert!(open_op(Some(Str::new_static("link"))).is_ok());
		assert!(open_op(Some(Str::new_static("url"))).is_ok());
		let error = open_op(Some(Str::new_static("file"))).unwrap_err();
		assert!(error.to_string().contains("Usage: /open [link]"), "{error}");
	}
}
