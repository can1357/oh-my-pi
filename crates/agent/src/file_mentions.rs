//! Typed production path for auto-reading submitted `@path` mentions.

use bytes::Bytes;
use flume::{Receiver, Sender};
use omp_core::{FastHashSet, Str};

/// Maximum model-visible text retained for one materialized mention.
pub const MAX_INLINE_MENTION_BYTES: usize = crate::DispatchPolicy::DEFAULT_MAX_OUTPUT_BYTES;

/// One authority-produced file mention, before image bytes enter the session
/// CAS.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MaterializedFileMention {
	/// Bounded model-visible text and its complete source line count.
	Lines {
		/// Path exactly as authored after the `@` sigil.
		path:       Str,
		/// Bounded materialized content.
		content:    Str,
		/// Complete line count when known.
		line_count: Option<u64>,
	},
	/// Image bytes normalized through Read's image policy.
	Image {
		/// Path exactly as authored after the `@` sigil.
		path:       Str,
		/// Model-facing media type.
		media_type: Str,
		/// Bounded, normalized encoded image.
		bytes:      Bytes,
	},
	/// A non-image binary deliberately omitted from inference.
	SkippedBinary {
		/// Path exactly as authored after the `@` sigil.
		path:      Str,
		/// Exact source size when known.
		byte_size: Option<u64>,
	},
	/// A resource exceeding the applicable auto-read bound.
	TooLarge {
		/// Path exactly as authored after the `@` sigil.
		path:      Str,
		/// Exact source size when known.
		byte_size: Option<u64>,
	},
}

/// Existing document/Read authority used to materialize one exact authored
/// path.
pub trait FileMentionSource: Send + Sync + 'static {
	/// Typed host error. Individual unreadable mentions are omitted, as in pi.
	type Error: std::error::Error + Send + 'static;

	/// Materializes one exact path without fuzzy recovery.
	fn materialize(
		&self,
		path: Str,
	) -> impl Future<Output = Result<Option<MaterializedFileMention>, Self::Error>> + Send;
}

struct Request {
	path:  Str,
	reply: Sender<Option<MaterializedFileMention>>,
}

/// Cloneable kernel handle to the authority-owned mention worker.
#[derive(Clone)]
pub(crate) struct FileMentionService {
	requests: Sender<Request>,
}

impl FileMentionService {
	pub(crate) fn spawn<S: FileMentionSource>(source: S) -> Self {
		let (requests, incoming) = flume::unbounded::<Request>();
		tokio::spawn(async move {
			while let Ok(request) = incoming.recv_async().await {
				let materialized = source.materialize(request.path).await.ok().flatten();
				let _ = request.reply.send(materialized);
			}
		});
		Self { requests }
	}

	pub(crate) async fn materialize(&self, path: Str) -> Option<MaterializedFileMention> {
		let (reply, response): (Sender<Option<MaterializedFileMention>>, Receiver<_>) =
			flume::bounded(1);
		self
			.requests
			.send_async(Request { path, reply })
			.await
			.ok()?;
		response.recv_async().await.ok().flatten()
	}
}

/// Parses exact `@path` tokens in authored order using the completion grammar.
///
/// A sigil starts at the beginning of text or after whitespace/opening
/// punctuation. Unquoted tokens end at whitespace or another `@`; quoted
/// tokens retain spaces and end at their matching quote. Repeated paths are
/// materialized once at their first position.
#[must_use]
pub fn parse_file_mentions(text: &str) -> Vec<Str> {
	let mut mentions = Vec::new();
	let mut seen = FastHashSet::default();
	let mut cursor = 0;
	while let Some(relative) = text[cursor..].find('@') {
		let start = cursor + relative;
		cursor = start + 1;
		if !is_file_token_start(text, start) {
			continue;
		}
		let Some((path, end)) = parse_path(text, cursor) else {
			continue;
		};
		cursor = end;
		let path = Str::new(path);
		if seen.insert(path.clone()) {
			mentions.push(path);
		}
	}
	mentions
}

/// Returns the `@` offset for the mention prefix ending at `cursor`.
///
/// The completion provider uses this directly, keeping submitted-token parsing
/// and completion recognition on one grammar.
#[must_use]
pub fn file_mention_prefix(text: &str, cursor: usize) -> Option<usize> {
	let before = text.get(..cursor)?;
	let start = before.rfind('@')?;
	if !is_file_token_start(text, start) || text[start + 1..cursor].contains(char::is_whitespace) {
		return None;
	}
	Some(start)
}

/// Returns the end of an unquoted file mention token starting at `start`.
#[must_use]
pub fn file_mention_token_end(text: &str, start: usize) -> usize {
	text[start..]
		.find(|character: char| character.is_whitespace() || character == '@')
		.map_or(text.len(), |offset| start + offset)
}

fn is_file_token_start(text: &str, at: usize) -> bool {
	text[..at].chars().next_back().is_none_or(|previous| {
		previous.is_whitespace() || matches!(previous, '"' | '\'' | '`' | '(' | '[' | '{' | '<' | '=')
	})
}

fn parse_path(text: &str, start: usize) -> Option<(&str, usize)> {
	let rest = text.get(start..)?;
	let quote = rest
		.chars()
		.next()
		.filter(|character| matches!(character, '"' | '\''));
	if let Some(quote) = quote {
		let body = &rest[quote.len_utf8()..];
		let end = body.find(quote)?;
		let path = body[..end].trim();
		return (!path.is_empty())
			.then_some((path, start + quote.len_utf8() + end + quote.len_utf8()));
	}
	let end = rest
		.find(|character: char| character.is_whitespace() || character == '@')
		.unwrap_or(rest.len());
	let path = rest[..end].trim_end_matches(|character| {
		matches!(
			character,
			')' | ']' | '}' | '>' | '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '`'
		)
	});
	(!path.is_empty()).then_some((path, start + end))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parser_matches_completion_boundaries_and_preserves_first_order() {
		assert_eq!(
			parse_file_mentions("read @src/a.rs, then (@\"notes/with space.md\") and @src/a.rs"),
			vec![Str::new_static("src/a.rs"), Str::new_static("notes/with space.md")]
		);
		assert!(parse_file_mentions("mail@example.com").is_empty());
		assert_eq!(file_mention_prefix("see (@src/li", 12), Some(5));
	}
}
