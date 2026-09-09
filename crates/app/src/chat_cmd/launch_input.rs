//! Launch-time prompt, pipe, and `@file` composition.

use std::{
	fmt::Write as _,
	fs,
	path::{Path, PathBuf},
	str,
};

use miette::{IntoDiagnostic as _, miette};
use omp_chat::{
	composer::{ComposerMediaKind, ComposerMediaSource},
	media::MAX_MEDIA_INPUT_BYTES,
};
use omp_core::{Str, dirs::home_dir};
use omp_session::AttachmentInput;
use omp_tools::{
	path::{HostPaths, normalize_target},
	read::{
		BINARY_SNIFF_BYTES, SNAPSHOT_MAX_BYTES, image, is_probably_binary_header, markit, notebook,
	},
};

use super::Launch;

/// One launch message before session blob storage.
pub(crate) struct Input {
	/// Model-visible user text.
	pub text:        Str,
	/// Normalized image inputs associated only with this message.
	pub attachments: Vec<AttachmentInput>,
}

/// Initial input plus the subsequent positional and explicit follow-up turns.
pub(crate) struct Inputs {
	/// Pipe/file context and the first positional message.
	pub first:      Option<Input>,
	/// Later positional messages, followed by explicit `--follow-up` values.
	pub follow_ups: Vec<Str>,
	/// Whether at least one `@file` argument was present.
	pub has_files:  bool,
}

/// Materializes `@file` inputs and composes only the first positional message
/// with pipe/file context. Every later positional remains a distinct turn.
pub(crate) fn prepare(
	launch: &Launch,
	piped: Option<Str>,
	explicit_follow_ups: Vec<Str>,
) -> miette::Result<Inputs> {
	let mut files = Vec::new();
	let mut messages = Vec::new();
	for argument in &launch.prompt {
		if let Some(path) = argument.strip_prefix("@") {
			files.push(path);
		} else {
			messages.push(launch.expand_prompt(argument));
		}
	}

	let has_files = !files.is_empty();
	let (file_text, attachments) = materialize_files(&launch.project, &files)?;
	let first_message = messages.first().cloned();
	let has_context = piped.is_some() || !file_text.is_empty() || !attachments.is_empty();
	let first = (first_message.is_some() || has_context).then(|| Input {
		text: combine_first(piped.as_deref(), &file_text, first_message.as_deref()),
		attachments,
	});
	let mut follow_ups = messages.into_iter().skip(1).collect::<Vec<_>>();
	follow_ups.extend(
		explicit_follow_ups
			.into_iter()
			.map(|text| launch.expand_prompt(&text)),
	);
	Ok(Inputs { first, follow_ups, has_files })
}

fn combine_first(piped: Option<&str>, file_text: &str, message: Option<&str>) -> Str {
	let body_len = file_text.len() + message.map_or(0, str::len);
	let capacity =
		piped.map_or(0, str::len) + usize::from(piped.is_some() && body_len > 0) + body_len;
	let mut combined = String::with_capacity(capacity);
	if let Some(piped) = piped {
		combined.push_str(piped);
		if body_len > 0 {
			combined.push('\n');
		}
	}
	combined.push_str(file_text);
	if let Some(message) = message {
		combined.push_str(message);
	}
	Str::from(combined)
}

fn materialize_files(
	project: &Path,
	files: &[Str],
) -> miette::Result<(String, Vec<AttachmentInput>)> {
	let mut text = String::new();
	let mut attachments = Vec::new();
	for authored in files {
		let path = resolve_file(project, authored)?;
		let metadata = fs::metadata(&path).into_diagnostic()?;
		if !metadata.is_file() {
			return Err(miette!("launch input is not a file: {}", path.display()));
		}
		let prefix_len = usize::try_from(metadata.len())
			.unwrap_or(usize::MAX)
			.min(BINARY_SNIFF_BYTES);
		let mut prefix = vec![0; prefix_len];
		if prefix_len > 0 {
			use std::io::Read as _;
			let mut source = fs::File::open(&path).into_diagnostic()?;
			source.read_exact(&mut prefix).into_diagnostic()?;
		}
		if image::sniff_metadata(&prefix).is_some() {
			if metadata.len() > MAX_MEDIA_INPUT_BYTES {
				append_skipped_file(&mut text, &path, metadata.len(), "image is too large");
				continue;
			}
			let source = ComposerMediaSource {
				kind:   ComposerMediaKind::Image,
				source: Str::new(path.to_string_lossy()),
			};
			let prepared = omp_chat::media::prepare_media_sources(&[source])
				.map_err(|source| miette!(source))?
				.pop()
				.expect("one media source produces one prepared item");
			text.push_str("<file name=\"");
			text.push_str(&path.to_string_lossy());
			text.push_str("\"></file>\n");
			attachments.push(prepared.input);
			continue;
		}
		if metadata.len() > SNAPSHOT_MAX_BYTES as u64 {
			append_skipped_file(&mut text, &path, metadata.len(), "file is too large");
			continue;
		}
		let bytes = fs::read(&path).into_diagnostic()?;
		if bytes.is_empty() {
			continue;
		}
		let display = path.to_string_lossy();
		let content = if path
			.extension()
			.is_some_and(|extension| extension.eq_ignore_ascii_case("ipynb"))
		{
			notebook::render(&bytes, &display)
				.map_err(|source| miette!(source))?
				.text
		} else if let Some(document) =
			markit::convert(&path, &bytes).map_err(|source| miette!(source))?
		{
			document.text.to_string()
		} else {
			if is_probably_binary_header(&prefix) {
				append_skipped_file(&mut text, &path, metadata.len(), "unsupported binary resource");
				continue;
			}
			str::from_utf8(&bytes).into_diagnostic()?.to_owned()
		};
		text.push_str("<file name=\"");
		text.push_str(&display);
		text.push_str("\">\n");
		text.push_str(&content);
		text.push_str("\n</file>\n");
	}
	Ok((text, attachments))
}

fn append_skipped_file(text: &mut String, path: &Path, bytes: u64, reason: &str) {
	text.push_str("<file name=\"");
	text.push_str(&path.to_string_lossy());
	text.push_str("\">(skipped: ");
	text.push_str(reason);
	writeln!(text, ", {bytes} bytes)</file>").expect("writing to a String cannot fail");
}

fn resolve_file(project: &Path, authored: &str) -> miette::Result<PathBuf> {
	let home = home_dir();
	let normalized = normalize_target(authored, home.as_deref(), HostPaths::current());
	let candidate = PathBuf::from(normalized.canonical.as_str());
	let candidate = if candidate.is_absolute() {
		candidate
	} else {
		project.join(candidate)
	};
	fs::canonicalize(candidate).into_diagnostic()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn first_context_order_does_not_absorb_follow_ups() {
		assert_eq!(
			combine_first(Some("pipe"), "<file>body</file>\n", Some("first")),
			"pipe\n<file>body</file>\nfirst"
		);
		assert_eq!(combine_first(None, "", Some("first")), "first");
	}

	#[test]
	fn image_files_use_the_composer_media_authority() {
		let directory = tempfile::tempdir().expect("tempdir");
		let image = directory.path().join("pixel.png");
		let png = omp_core::encoding::base64::decode(
			b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		)
		.into_vec()
		.expect("fixture base64");
		fs::write(&image, png).expect("write image");
		let (text, attachments) =
			materialize_files(directory.path(), &[Str::new_static("pixel.png")])
				.expect("materialize image");
		assert_eq!(attachments.len(), 1);
		assert!(attachments[0].mime.starts_with("image/"));
		let image = fs::canonicalize(image).expect("canonical image path");
		assert_eq!(text, format!("<file name=\"{}\"></file>\n", image.display()));
	}
}
