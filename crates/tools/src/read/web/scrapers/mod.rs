//! Ordered, allocation-free registry of supported site-specific scrapers.

use url::Url;

use crate::read::web::types::{HttpClient, RenderResult, WebError};

mod arxiv;
mod catalog;
mod crates_io;
mod docs_rs;
mod github;
mod github_gist;
mod gitlab;
mod hackernews;
mod huggingface;
mod mdn;
mod npm;
mod pypi;
mod reddit;
mod stackoverflow;
mod twitter;
pub(super) mod utils;
mod wikipedia;
mod youtube;

/// A supported site-specific renderer.
///
/// `ALL` preserves the relative first-match precedence from the scraper
/// registry. Dispatch is a concrete match so a request never allocates a trait
/// object or boxed future.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Scraper {
	/// GitHub Gist pages, before the broader GitHub matcher.
	GitHubGist,
	/// GitHub repositories and content.
	GitHub,
	/// GitLab repositories and content.
	GitLab,
	/// Ordered long-tail public API catalog.
	LongTail,
	/// `YouTube` videos and channels.
	YouTube,
	/// Twitter and X posts.
	Twitter,
	/// Hacker News stories and discussions.
	HackerNews,
	/// Reddit posts and discussions.
	Reddit,
	/// Stack Overflow questions.
	StackOverflow,
	/// Mozilla Developer Network documentation.
	Mdn,
	/// docs.rs crate documentation.
	DocsRs,
	/// npm package pages.
	Npm,
	/// Python Package Index projects.
	PyPi,
	/// crates.io crate pages.
	CratesIo,
	/// Hugging Face models, datasets, and spaces.
	HuggingFace,
	/// arXiv papers.
	Arxiv,
	/// Wikipedia articles.
	Wikipedia,
}

impl Scraper {
	/// Scrapers in deterministic first-match order.
	pub const ALL: [Self; 17] = [
		Self::GitHubGist,
		Self::GitHub,
		Self::GitLab,
		Self::LongTail,
		Self::YouTube,
		Self::Twitter,
		Self::HackerNews,
		Self::Reddit,
		Self::StackOverflow,
		Self::Mdn,
		Self::DocsRs,
		Self::Npm,
		Self::PyPi,
		Self::CratesIo,
		Self::HuggingFace,
		Self::Arxiv,
		Self::Wikipedia,
	];

	/// Returns whether this scraper recognizes a URL.
	pub fn matches(self, url: &Url) -> bool {
		match self {
			Self::GitHubGist => github_gist::matches(url),
			Self::GitHub => github::matches(url),
			Self::GitLab => gitlab::matches(url),
			Self::LongTail => catalog::matches(url),
			Self::YouTube => youtube::matches(url),
			Self::Twitter => twitter::matches(url),
			Self::HackerNews => hackernews::matches(url),
			Self::Reddit => reddit::matches(url),
			Self::StackOverflow => stackoverflow::matches(url),
			Self::Mdn => mdn::matches(url),
			Self::DocsRs => docs_rs::matches(url),
			Self::Npm => npm::matches(url),
			Self::PyPi => pypi::matches(url),
			Self::CratesIo => crates_io::matches(url),
			Self::HuggingFace => huggingface::matches(url),
			Self::Arxiv => arxiv::matches(url),
			Self::Wikipedia => wikipedia::matches(url),
		}
	}

	/// Runs this scraper using the shared unboxed HTTP transport.
	pub async fn render<C: HttpClient + Sync>(
		self,
		client: &C,
		url: &Url,
	) -> Result<Option<RenderResult>, WebError> {
		match self {
			Self::GitHubGist => github_gist::render(client, url).await,
			Self::GitHub => github::render(client, url).await,
			Self::GitLab => gitlab::render(client, url).await,
			Self::LongTail => catalog::render(client, url).await,
			Self::YouTube => youtube::render(client, url).await,
			Self::Twitter => twitter::render(client, url).await,
			Self::HackerNews => hackernews::render(client, url).await,
			Self::Reddit => reddit::render(client, url).await,
			Self::StackOverflow => stackoverflow::render(client, url).await,
			Self::Mdn => mdn::render(client, url).await,
			Self::DocsRs => docs_rs::render(client, url).await,
			Self::Npm => npm::render(client, url).await,
			Self::PyPi => pypi::render(client, url).await,
			Self::CratesIo => crates_io::render(client, url).await,
			Self::HuggingFace => huggingface::render(client, url).await,
			Self::Arxiv => arxiv::render(client, url).await,
			Self::Wikipedia => wikipedia::render(client, url).await,
		}
	}
}

/// Selects the first registered scraper accepted by `predicate`.
///
/// Keeping precedence in one helper prevents URL lookup and rendering dispatch
/// from drifting when the registry grows.
fn first_registered_matching(mut predicate: impl FnMut(Scraper) -> bool) -> Option<Scraper> {
	Scraper::ALL.into_iter().find(|scraper| predicate(*scraper))
}

/// Selects the first registered scraper that recognizes `url`.
pub fn scraper_for(url: &Url) -> Option<Scraper> {
	first_registered_matching(|scraper| scraper.matches(url))
}

/// Renders a URL with the first site-specific scraper that accepts it.
///
/// Handlers run in registry order and treat `None` as a decline, so a later
/// handler may still accept the same URL. `None` from the full registry
/// allows the caller to use the ordinary fetch pipeline. Typed scraper errors
/// stop dispatch and propagate unchanged.
pub async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	for scraper in Scraper::ALL {
		if let Some(rendered) = scraper.render(client, url).await? {
			return Ok(Some(rendered));
		}
	}
	Ok(None)
}

#[cfg(test)]
mod tests {
	use super::{Scraper, first_registered_matching};

	#[test]
	fn overlapping_matches_use_pi_registry_precedence() {
		for (candidates, expected) in [
			(&[Scraper::GitHub, Scraper::GitHubGist][..], Scraper::GitHubGist),
			(&[Scraper::CratesIo, Scraper::DocsRs], Scraper::DocsRs),
			(&[Scraper::Wikipedia, Scraper::Arxiv], Scraper::Arxiv),
		] {
			assert_eq!(
				first_registered_matching(|scraper| candidates.contains(&scraper)),
				Some(expected)
			);
		}
	}
}
