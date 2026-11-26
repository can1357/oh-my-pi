//! tldr pages (`tldr.sh`, `tldr.ostera.io`): the command's page from the
//! tldr-pages repository, trying the `common`, `linux` and `osx` platforms in
//! order until one answers.

use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch};

/// Registry entry.
pub const SITE: Site = Site { name: "tldr", open };

const BASE: &str = "https://raw.githubusercontent.com/tldr-pages/tldr/main/pages";
const METHOD: &str = "tldr";
const PLATFORMS: &[&str] = &["common", "linux", "osx"];

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "tldr.sh" | "tldr.ostera.io") {
		return None;
	}
	let path = url.path().strip_prefix('/')?;
	let command = path.strip_suffix(".md").unwrap_or(path);
	if command.is_empty() || command.contains('/') {
		return None;
	}
	attempt(command.to_owned(), 0)
}

/// Fetch the page from platform `index`, falling through to the next one while
/// the reply is not a non-empty body.
fn attempt(command: String, index: usize) -> Option<Action> {
	let platform = *PLATFORMS.get(index)?;
	let raw = format!("{BASE}/{platform}/{command}.md");
	let raw_url = raw.clone();
	fetch(Fetch::get(raw), move |reply, _| {
		if let Some(text) = reply.body_text().filter(|text| !text.trim().is_empty()) {
			let mut done = Done::new(text, METHOD);
			done.url = Some(raw_url);
			done
				.notes
				.push(format!("Fetched from tldr-pages ({platform})"));
			return done.finish();
		}
		attempt(command, index + 1)
	})
}

#[cfg(test)]
mod tests {
	use super::super::{Fetched, testing::run};

	#[test]
	fn the_first_platform_with_content_wins() {
		let mut requests = Vec::new();
		let done = run("https://tldr.sh/git", |request| {
			requests.push(request.url.clone());
			if request.url.contains("/linux/") {
				Fetched::text("text/markdown", "# git\n\n> Distributed version control.\n")
			} else {
				Fetched::status(404)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/common/git.md",
			"https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/linux/git.md"
		]);
		assert_eq!(done.method, "tldr");
		assert_eq!(
			done.url.as_deref(),
			Some("https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/linux/git.md")
		);
		assert_eq!(done.notes, ["Fetched from tldr-pages (linux)"]);
		assert!(
			done
				.markdown
				.starts_with("# git\n\n> Distributed version control.")
		);
	}

	#[test]
	fn an_alias_host_and_a_md_suffix_are_its_own() {
		let done = run("https://tldr.ostera.io/osx/tar.md", |_| Fetched::status(404));
		assert_eq!(done, None, "no platform has the page");
		assert_eq!(run("https://tldr.sh/nested/path", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.com/git", |_| panic!("no fetch expected")), None);
	}
}
