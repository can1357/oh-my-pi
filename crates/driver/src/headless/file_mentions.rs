//! Environment-backed `@path` materialization for authored turns.

use std::path::Path;

use omp_agent::{FileMentionSource, MAX_INLINE_MENTION_BYTES, MaterializedFileMention};
use omp_core::{EnvPath, Str};
use omp_env::{ClientError, EnvClient};
use omp_proto::document::v1::FileKind;
use omp_tools::read::{BINARY_SNIFF_BYTES, SNAPSHOT_MAX_BYTES, image, is_probably_binary_header};

const MAX_AUTO_READ_TEXT_BYTES: u64 = SNAPSHOT_MAX_BYTES as u64;
const MAX_AUTO_READ_IMAGE_BYTES: u64 = image::MAX_IMAGE_INPUT_BYTES as u64;
const MAX_MENTION_DIRECTORY_ENTRIES: usize = 500;

/// Production mention source over the same environment document authority as
/// Read.
#[derive(Clone)]
pub(crate) struct EnvFileMentionSource {
	client: EnvClient,
}

impl EnvFileMentionSource {
	pub(crate) const fn new(client: EnvClient) -> Self {
		Self { client }
	}

	async fn directory(
		&self,
		path: Str,
		env_path: &EnvPath,
	) -> Result<Option<MaterializedFileMention>, ClientError> {
		let mut entries = self.client.list_directory(env_path).await?;
		entries.sort_by(|left, right| {
			left
				.name
				.bytes()
				.map(|byte| byte.to_ascii_lowercase())
				.cmp(right.name.bytes().map(|byte| byte.to_ascii_lowercase()))
				.then_with(|| left.name.cmp(&right.name))
		});
		entries.truncate(MAX_MENTION_DIRECTORY_ENTRIES);
		let mut content = String::new();
		for entry in &entries {
			if !content.is_empty() {
				content.push('\n');
			}
			content.push_str(&entry.name);
			if entry
				.metadata
				.as_ref()
				.and_then(|metadata| FileKind::try_from(metadata.kind).ok())
				== Some(FileKind::Directory)
			{
				content.push('/');
			}
		}
		if content.is_empty() {
			content.push_str("(empty directory)");
		}
		let line_count = u64::try_from(content.lines().count()).ok();
		Ok(Some(MaterializedFileMention::Lines { path, content: bounded_text(&content), line_count }))
	}
}

impl FileMentionSource for EnvFileMentionSource {
	type Error = ClientError;

	async fn materialize(&self, path: Str) -> Result<Option<MaterializedFileMention>, Self::Error> {
		let Ok(env_path) = EnvPath::new(path.clone()) else {
			return Ok(None);
		};
		let metadata = match self.client.stat_path(&env_path).await {
			Ok(metadata) => metadata,
			Err(_) => return Ok(None),
		};
		let kind = FileKind::try_from(metadata.kind).unwrap_or(FileKind::Unspecified);
		if kind == FileKind::Directory {
			return self.directory(path, &env_path).await;
		}
		if kind != FileKind::RegularFile {
			return Ok(Some(MaterializedFileMention::SkippedBinary {
				path,
				byte_size: Some(metadata.byte_length),
			}));
		}
		if metadata.byte_length == 0 {
			return Ok(None);
		}

		let extension_says_image = image::is_supported_extension(Path::new(path.as_str()));
		let limit = if extension_says_image {
			MAX_AUTO_READ_IMAGE_BYTES
		} else {
			MAX_AUTO_READ_TEXT_BYTES
		};
		if metadata.byte_length > limit {
			return Ok(Some(MaterializedFileMention::TooLarge {
				path,
				byte_size: Some(metadata.byte_length),
			}));
		}

		let lease = match self.client.open_document(&env_path, None).await {
			Ok(lease) => lease,
			Err(_) => return Ok(None),
		};
		let read = self.client.read_document(&lease, None, None).await?;
		let Some(bytes) = read.content().cloned() else {
			return Ok(None);
		};
		if bytes.is_empty() {
			return Ok(None);
		}

		let image_by_magic = image::sniff_metadata(&bytes[..bytes.len().min(256 * 1024)]).is_some();
		if extension_says_image || image_by_magic {
			if metadata.byte_length > MAX_AUTO_READ_IMAGE_BYTES {
				return Ok(Some(MaterializedFileMention::TooLarge {
					path,
					byte_size: Some(metadata.byte_length),
				}));
			}
			return Ok(match image::process_image_with_policy(bytes, true) {
				Ok(Some(image)) => Some(MaterializedFileMention::Image {
					path,
					media_type: image.media_type,
					bytes: image.data,
				}),
				_ => Some(MaterializedFileMention::SkippedBinary {
					path,
					byte_size: Some(metadata.byte_length),
				}),
			});
		}

		if is_probably_binary_header(&bytes[..bytes.len().min(BINARY_SNIFF_BYTES)]) {
			return Ok(Some(MaterializedFileMention::SkippedBinary {
				path,
				byte_size: Some(metadata.byte_length),
			}));
		}
		let Ok(text) = std::str::from_utf8(&bytes) else {
			return Ok(Some(MaterializedFileMention::SkippedBinary {
				path,
				byte_size: Some(metadata.byte_length),
			}));
		};
		let line_count = u64::try_from(text.lines().count()).ok();
		Ok(Some(MaterializedFileMention::Lines { path, content: bounded_text(text), line_count }))
	}
}

fn bounded_text(text: &str) -> Str {
	const NOTICE: &str = "\n\n[File mention truncated at the host inline-output limit.]";
	if text.len() <= MAX_INLINE_MENTION_BYTES {
		return Str::new(text);
	}
	let mut end = MAX_INLINE_MENTION_BYTES.saturating_sub(NOTICE.len());
	while !text.is_char_boundary(end) {
		end -= 1;
	}
	let mut bounded = String::with_capacity(end + NOTICE.len());
	bounded.push_str(&text[..end]);
	bounded.push_str(NOTICE);
	Str::new(bounded)
}
