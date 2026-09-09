//! Typed auto-read file-mention transcript rows.

use std::fmt::Write as _;

use omp_core::{Str, StrMut, sf};
use omp_dom::Node;
use omp_journal::data::{FileMentions, MentionedFile, MentionedFileState};
use omp_tui::{IntoComponent as _, dom};

use crate::cards::{Component, file_link};

/// Decodes the replay-stable payload from a journal-derived `<user>` node.
#[must_use]
pub(crate) fn payload(node: &Node) -> Option<FileMentions> {
	omp_session::file_mentions(node).filter(|payload| !payload.files.is_empty())
}

/// Plain copy/export text in mention order.
#[must_use]
pub(crate) fn text(payload: &FileMentions) -> Str {
	let mut out = StrMut::new("");
	for (index, file) in payload.files.iter().enumerate() {
		if index > 0 {
			out.push('\n');
		}
		let _ = write!(out, "Read {} {}", file.path, suffix(file));
	}
	out.freeze()
}

/// One linked `Read <path> (<state>)` row per mention, in payload order.
#[must_use]
pub(crate) fn block(payload: &FileMentions) -> Component {
	let rows = payload.files.iter().map(row).collect::<Vec<_>>();
	dom! { <col>{rows}</col> }.into_component()
}

fn row(file: &MentionedFile) -> Component {
	let path = file.path.clone();
	let href = file_link(path.as_str());
	let suffix = suffix(file);
	dom! {
		<row gap=1 pad-x=1>
			<i:tree-last fg=muted/>
			<text fg=muted>{"Read"}</text>
			<text fg=accent href={href} wrap=pre>{path}</text>
			<text fg=muted wrap=pre>{suffix}</text>
		</row>
	}
	.into_component()
}

fn suffix(file: &MentionedFile) -> Str {
	match &file.state {
		MentionedFileState::Lines { line_count: Some(lines) } => sf!("({lines} lines)"),
		MentionedFileState::Lines { line_count: None } => Str::new_static("(unknown lines)"),
		MentionedFileState::Image { .. } => Str::new_static("(image)"),
		MentionedFileState::SkippedBinary { byte_size } => {
			let size = size_label(*byte_size);
			sf!("(skipped: binary, {size})")
		},
		MentionedFileState::TooLarge { byte_size } => {
			let size = size_label(*byte_size);
			sf!("(skipped: {size})")
		},
	}
}

fn size_label(bytes: Option<u64>) -> Str {
	bytes.map_or_else(
		|| Str::new_static("unknown size"),
		|bytes| Str::new(super::misc::format_bytes(usize::try_from(bytes).unwrap_or(usize::MAX))),
	)
}

#[cfg(test)]
mod tests {
	use omp_core::Hash32;
	use omp_journal::{blob::BlobRef, data::Attachment};
	use omp_tui::{Ui, UiContext, frame_text};

	use super::*;

	fn render(component: Component) -> String {
		let ui = Ui::from_root(component, 100, UiContext::default());
		frame_text(ui.frame())
	}

	#[test]
	fn renders_every_state_in_original_order_with_links() {
		let payload = FileMentions {
			files: vec![
				MentionedFile {
					path:    Str::new_static("notes.md"),
					content: Str::new_static("one\ntwo"),
					state:   MentionedFileState::Lines { line_count: Some(2) },
				},
				MentionedFile {
					path:    Str::new_static("shot.png"),
					content: Str::default(),
					state:   MentionedFileState::Image {
						attachment: Attachment {
							blob: BlobRef { hash: Hash32::new([7; 32]), size: 512 },
							mime: Str::new_static("image/png"),
						},
					},
				},
				MentionedFile {
					path:    Str::new_static("archive.bin"),
					content: Str::default(),
					state:   MentionedFileState::SkippedBinary { byte_size: Some(1_536) },
				},
				MentionedFile {
					path:    Str::new_static("huge.txt"),
					content: Str::default(),
					state:   MentionedFileState::TooLarge { byte_size: None },
				},
			],
		};
		let rendered = render(block(&payload));
		let positions = ["notes.md", "shot.png", "archive.bin", "huge.txt"]
			.map(|path| rendered.find(path).expect("path row"));
		assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
		assert!(rendered.contains("Read notes.md (2 lines)"));
		assert!(rendered.contains("Read shot.png (image)"));
		assert!(rendered.contains("Read archive.bin (skipped: binary, 1.5KB)"));
		assert!(rendered.contains("Read huge.txt (skipped: unknown size)"));
	}
}
