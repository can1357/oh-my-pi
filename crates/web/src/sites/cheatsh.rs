//! cheat.sh / cht.sh (`cheat.sh/<topic>` and its `cht.sh` alias): the
//! plain-text cheatsheet for a topic, wrapped in a fenced code block.

use std::fmt::Write as _;

use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, segment};

/// Registry entry.
pub const SITE: Site = Site { name: "cheat.sh", open };

const METHOD: &str = "cheat.sh";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "cheat.sh" | "cht.sh") {
		return None;
	}
	// The topic is the raw (still percent-encoded) path; the API wants it
	// percent-encoded once more, so a nested topic becomes `python%2Flist`.
	let topic = url.path().strip_prefix('/')?;
	if topic.is_empty() {
		return None;
	}
	let display = percent_decode(topic);
	let request =
		Fetch::get(format!("https://cheat.sh/{}?T", segment(topic))).header("Accept", "text/plain");
	fetch(request, move |reply, _| {
		let content = reply.body_text()?.trim().to_owned();
		if content.is_empty() {
			return None;
		}
		let mut md = format!("# cheat.sh/{display}\n\n");
		// Code examples and nested topics fence with their language; plain
		// command cheatsheets fence without one.
		let language = if has_code_indicators(&content) || display.contains('/') {
			display
				.split('/')
				.next()
				.filter(|part| !part.is_empty())
				.unwrap_or("bash")
		} else {
			""
		};
		let _ = write!(md, "```{language}\n{content}\n```\n");
		Done::new(md, METHOD)
			.title(format!("cheat.sh/{display}"))
			.note("Fetched via cheat.sh")
			.finish()
	})
}

/// Whether any line looks like code rather than prose.
fn has_code_indicators(content: &str) -> bool {
	content.lines().any(|line| {
		line.starts_with('$')
			|| line.starts_with('#')
			|| line.contains("()")
			|| line.contains("=>")
			|| starts_with_keyword(line.trim_start())
	})
}

/// The `^\s*(if|for|while|def|func|fn|let|const|var)\b` test of the TS handler.
fn starts_with_keyword(line: &str) -> bool {
	const KEYWORDS: [&str; 9] = ["if", "for", "while", "def", "func", "fn", "let", "const", "var"];
	KEYWORDS.iter().copied().any(|keyword| {
		line
			.strip_prefix(keyword)
			.is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
	})
}

/// `decodeURIComponent` of a percent-encoded path; invalid escapes pass
/// through.
fn percent_decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& index + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
		{
			out.push(high * 16 + low);
			index += 3;
			continue;
		}
		out.push(bytes[index]);
		index += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

const fn hex(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::super::{Fetched, testing::run};

	#[test]
	fn a_topic_renders_the_cheatsheet_in_a_code_block() {
		let mut requests = Vec::new();
		let done = run("https://cheat.sh/curl", |request| {
			requests.push(request.url.clone());
			let accept = request
				.headers
				.iter()
				.find(|(name, _)| name.as_str() == "Accept");
			assert_eq!(accept.map(|(_, value)| value.as_str()), Some("text/plain"));
			Fetched::text("text/plain", "\n$ curl -s https://x.test\n  Fetch a URL.\n")
		})
		.unwrap();
		assert_eq!(requests, ["https://cheat.sh/curl?T"]);
		assert_eq!(done.method, "cheat.sh");
		assert_eq!(
			done.markdown,
			"# cheat.sh/curl\n\n```curl\n$ curl -s https://x.test\n  Fetch a URL.\n```\n"
		);
	}

	#[test]
	fn a_nested_topic_fences_with_its_language() {
		let done = run("https://cht.sh/go/slice", |request| {
			assert_eq!(request.url, "https://cheat.sh/go%2Fslice?T");
			Fetched::text("text/plain", "make([]T, 0, n) // an empty slice")
		})
		.unwrap();
		assert_eq!(
			done.markdown,
			"# cheat.sh/go/slice\n\n```go\nmake([]T, 0, n) // an empty slice\n```\n"
		);
	}

	#[test]
	fn other_hosts_empty_topics_and_failures_fall_through() {
		assert_eq!(run("https://example.com/curl", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://cheat.sh/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://cheat.sh/curl", |_| Fetched::status(500)), None);
		assert_eq!(run("https://cheat.sh/curl", |_| Fetched::text("text/plain", "  \n")), None);
	}
}
