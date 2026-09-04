//! Long-tail public-site extractor catalog.
//!
//! The table follows registry order. Matching is deliberately separate from
//! rendering so a recognized URL may decline and fall through to the
//! generic bounded fetch pipeline.

use std::{fmt::Write as _, str};

use omp_core::USER_AGENT;
use serde_json::Value;
use url::Url;

use crate::read::web::types::{HttpClient, HttpRequest, RenderResult, WebError};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, strum::Display)]
#[strum(serialize_all = "title_case")]
enum Site {
	Vimeo,
	Spotify,
	Discogs,
	MusicBrainz,
	Rawg,
	Bluesky,
	Mastodon,
	Lemmy,
	Lobsters,
	Discourse,
	DevTo,
	ReadTheDocs,
	Searchcode,
	Sourcegraph,
	Tldr,
	CheatSh,
	FirefoxAddons,
	VscodeMarketplace,
	NuGet,
	Chocolatey,
	Clojars,
	Brew,
	DockerHub,
	Fdroid,
	Flathub,
	GoPkg,
	Hex,
	Packagist,
	PubDev,
	Maven,
	JetBrainsMarketplace,
	OpenVsx,
	ArtifactHub,
	RubyGems,
	Terraform,
	Aur,
	Hackage,
	MetaCpan,
	Repology,
	Snapcraft,
	Ollama,
	Biorxiv,
	Crossref,
	Iacr,
	Orcid,
	SemanticScholar,
	PubMed,
	Rfc,
	CisaKev,
	Nvd,
	Osv,
	CoinGecko,
	OpenCorporates,
	SecEdgar,
	OpenLibrary,
	ChooseALicense,
	W3c,
	Spdx,
	Wikidata,
}

const ALL: [Site; 59] = [
	Site::Vimeo,
	Site::Spotify,
	Site::Discogs,
	Site::MusicBrainz,
	Site::Rawg,
	Site::Bluesky,
	Site::Mastodon,
	Site::Lemmy,
	Site::Lobsters,
	Site::Discourse,
	Site::DevTo,
	Site::ReadTheDocs,
	Site::Searchcode,
	Site::Sourcegraph,
	Site::Tldr,
	Site::CheatSh,
	Site::FirefoxAddons,
	Site::VscodeMarketplace,
	Site::NuGet,
	Site::Chocolatey,
	Site::Clojars,
	Site::Brew,
	Site::DockerHub,
	Site::Fdroid,
	Site::Flathub,
	Site::GoPkg,
	Site::Hex,
	Site::Packagist,
	Site::PubDev,
	Site::Maven,
	Site::JetBrainsMarketplace,
	Site::OpenVsx,
	Site::ArtifactHub,
	Site::RubyGems,
	Site::Terraform,
	Site::Aur,
	Site::Hackage,
	Site::MetaCpan,
	Site::Repology,
	Site::Snapcraft,
	Site::Ollama,
	Site::Biorxiv,
	Site::Crossref,
	Site::Iacr,
	Site::Orcid,
	Site::SemanticScholar,
	Site::PubMed,
	Site::Rfc,
	Site::CisaKev,
	Site::Nvd,
	Site::Osv,
	Site::CoinGecko,
	Site::OpenCorporates,
	Site::SecEdgar,
	Site::OpenLibrary,
	Site::ChooseALicense,
	Site::W3c,
	Site::Spdx,
	Site::Wikidata,
];

pub(super) fn matches(url: &Url) -> bool {
	find(url).is_some()
}

pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(site) = find(url) else {
		return Ok(None);
	};
	let Some(api_url) = api_url(site, url) else {
		return Ok(None);
	};
	let Ok(response) = client
		.get(HttpRequest::new(api_url).with_header("User-Agent", USER_AGENT))
		.await
	else {
		return Ok(None);
	};
	if !response.is_success() {
		return Ok(None);
	}
	let content_type = response.header("content-type").unwrap_or("");
	let mut markdown = String::new();
	writeln!(markdown, "# {site}\n").expect("writing markdown to a string");
	writeln!(markdown, "**Source:** {url}\n").expect("writing markdown to a string");
	if content_type.contains("json")
		|| response
			.body
			.first()
			.is_some_and(|byte| matches!(byte, b'{' | b'['))
	{
		let Ok(value) = serde_json::from_slice::<Value>(&response.body) else {
			return Ok(None);
		};
		render_json(&mut markdown, &value, 0);
	} else {
		let Ok(text) = str::from_utf8(&response.body) else {
			return Ok(None);
		};
		if text.trim().is_empty() || text.contains("<html") || text.contains("<!DOCTYPE") {
			return Ok(None);
		}
		markdown.push_str("```text\n");
		markdown.push_str(text.trim());
		markdown.push_str("\n```\n");
	}
	Ok(Some(RenderResult::markdown(&markdown, "catalog")))
}

fn find(url: &Url) -> Option<Site> {
	ALL.into_iter().find(|site| site_matches(*site, url))
}

fn site_matches(site: Site, url: &Url) -> bool {
	let host = url
		.host_str()
		.unwrap_or("")
		.trim_start_matches("www.")
		.to_ascii_lowercase();
	let path = url.path();
	match site {
		Site::Vimeo => host == "vimeo.com" || host == "player.vimeo.com",
		Site::Spotify => host == "open.spotify.com",
		Site::Discogs => host.ends_with("discogs.com"),
		Site::MusicBrainz => host == "musicbrainz.org",
		Site::Rawg => host == "rawg.io",
		Site::Bluesky => host == "bsky.app",
		Site::Mastodon => path.contains("/@") || path.starts_with("/users/"),
		Site::Lemmy => path.starts_with("/post/") || path.starts_with("/c/"),
		Site::Lobsters => host == "lobste.rs",
		Site::Discourse => path.starts_with("/t/") && !host.ends_with("reddit.com"),
		Site::DevTo => host == "dev.to",
		Site::ReadTheDocs => host.ends_with("readthedocs.io") || host == "readthedocs.org",
		Site::Searchcode => host == "searchcode.com",
		Site::Sourcegraph => host == "sourcegraph.com",
		Site::Tldr => host == "tldr.inbrowser.app" || host == "tldr.sh",
		Site::CheatSh => host == "cheat.sh" || host == "cht.sh",
		Site::FirefoxAddons => host == "addons.mozilla.org",
		Site::VscodeMarketplace => host == "marketplace.visualstudio.com",
		Site::NuGet => host == "nuget.org" || host == "www.nuget.org",
		Site::Chocolatey => host.ends_with("chocolatey.org"),
		Site::Clojars => host == "clojars.org",
		Site::Brew => host == "formulae.brew.sh",
		Site::DockerHub => host == "hub.docker.com",
		Site::Fdroid => host == "f-droid.org",
		Site::Flathub => host == "flathub.org",
		Site::GoPkg => host == "pkg.go.dev",
		Site::Hex => host == "hex.pm",
		Site::Packagist => host == "packagist.org",
		Site::PubDev => host == "pub.dev",
		Site::Maven => {
			matches!(host.as_str(), "mvnrepository.com" | "central.sonatype.com" | "search.maven.org")
		},
		Site::JetBrainsMarketplace => host == "plugins.jetbrains.com",
		Site::OpenVsx => host == "open-vsx.org",
		Site::ArtifactHub => host == "artifacthub.io",
		Site::RubyGems => host == "rubygems.org",
		Site::Terraform => host == "registry.terraform.io",
		Site::Aur => host == "aur.archlinux.org",
		Site::Hackage => host == "hackage.haskell.org",
		Site::MetaCpan => host == "metacpan.org",
		Site::Repology => host == "repology.org",
		Site::Snapcraft => host == "snapcraft.io",
		Site::Ollama => host == "ollama.com" || host == "ollama.ai",
		Site::Biorxiv => matches!(host.as_str(), "biorxiv.org" | "medrxiv.org"),
		Site::Crossref => matches!(host.as_str(), "doi.org" | "dx.doi.org"),
		Site::Iacr => host == "eprint.iacr.org",
		Site::Orcid => host == "orcid.org",
		Site::SemanticScholar => host == "semanticscholar.org",
		Site::PubMed => host == "pubmed.ncbi.nlm.nih.gov",
		Site::Rfc => host == "rfc-editor.org" || host == "www.rfc-editor.org",
		Site::CisaKev => {
			host.ends_with("cisa.gov") && path.contains("known-exploited-vulnerabilities")
		},
		Site::Nvd => host == "nvd.nist.gov",
		Site::Osv => host == "osv.dev",
		Site::CoinGecko => host.ends_with("coingecko.com"),
		Site::OpenCorporates => host == "opencorporates.com",
		Site::SecEdgar => host == "sec.gov" || host.ends_with(".sec.gov"),
		Site::OpenLibrary => host == "openlibrary.org",
		Site::ChooseALicense => host == "choosealicense.com",
		Site::W3c => host == "w3.org" || host == "www.w3.org",
		Site::Spdx => host == "spdx.org",
		Site::Wikidata => host == "wikidata.org" || host == "www.wikidata.org",
	}
}

fn segments(url: &Url) -> Vec<&str> {
	url.path_segments()
		.map_or_else(Vec::new, |parts| parts.filter(|part| !part.is_empty()).collect())
}

fn api_url(site: Site, url: &Url) -> Option<String> {
	let parts = segments(url);
	let last = parts.last().copied()?;
	let host = url.host_str()?.trim_start_matches("www.");
	let endpoint = match site {
		Site::Vimeo => format!("https://vimeo.com/api/oembed.json?url={url}"),
		Site::Spotify => format!("https://open.spotify.com/oembed?url={url}"),
		Site::Discogs => format!("https://api.discogs.com/{}/{}", if parts.contains(&"master") { "masters" } else { "releases" }, last),
		Site::MusicBrainz => format!("https://musicbrainz.org/ws/2/{}/{last}?fmt=json&inc=aliases+tags+ratings", parts.first().copied().unwrap_or("recording")),
		Site::Rawg => return None,
		Site::Bluesky => format!("https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://{}/{}/{}", parts.get(1)?, "app.bsky.feed.post", last),
		Site::Mastodon => format!("{}://{host}/api/v1/statuses/{last}", url.scheme()),
		Site::Lemmy => format!("{}://{host}/api/v3/post?id={last}", url.scheme()),
		Site::Lobsters => format!("https://lobste.rs/s/{last}.json"),
		Site::Discourse => format!("{}://{host}/t/{last}.json?include_raw=1", url.scheme()),
		Site::DevTo => format!("https://dev.to/api/articles/{}", parts.join("/")),
		Site::ReadTheDocs => format!("https://readthedocs.org/api/v3/projects/{last}/"),
		Site::Searchcode => format!("https://searchcode.com/api/codesearch_I/?q={last}"),
		Site::Sourcegraph => return None,
		Site::Tldr => format!("https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/common/{last}.md"),
		Site::CheatSh => format!("https://cheat.sh/{last}?T"),
		Site::FirefoxAddons => format!("https://addons.mozilla.org/api/v5/addons/addon/{last}/"),
		Site::VscodeMarketplace => return None,
		Site::NuGet => format!("https://api.nuget.org/v3/registration5-semver1/{}/index.json", last.to_ascii_lowercase()),
		Site::Chocolatey => format!("https://community.chocolatey.org/api/v2/Packages()?$filter=Id%20eq%20'{last}'&$top=1"),
		Site::Clojars => format!("https://clojars.org/api/artifacts/{}", parts.join("/")),
		Site::Brew => format!("https://formulae.brew.sh/api/{}/{last}.json", if parts.contains(&"cask") { "cask" } else { "formula" }),
		Site::DockerHub => format!("https://hub.docker.com/v2/repositories/{}", parts.iter().skip_while(|part| **part != "r").skip(1).copied().collect::<Vec<_>>().join("/")),
		Site::Fdroid => format!("https://f-droid.org/api/v1/packages/{last}"),
		Site::Flathub => format!("https://flathub.org/api/v2/appstream/{last}"),
		Site::GoPkg => format!("https://proxy.golang.org/{}/@latest", parts.join("/")),
		Site::Hex => format!("https://hex.pm/api/packages/{last}"),
		Site::Packagist => format!("https://repo.packagist.org/p2/{}.json", parts.iter().skip(1).copied().collect::<Vec<_>>().join("/")),
		Site::PubDev => format!("https://pub.dev/api/packages/{last}"),
		Site::Maven => format!("https://search.maven.org/solrsearch/select?q={last}&rows=20&wt=json"),
		Site::JetBrainsMarketplace => format!("https://plugins.jetbrains.com/api/plugins/{last}"),
		Site::OpenVsx => format!("https://open-vsx.org/api/{}/{}", parts.get(parts.len().saturating_sub(2))?, last),
		Site::ArtifactHub => format!("https://artifacthub.io/api/v1/packages/{}", parts.iter().skip(1).copied().collect::<Vec<_>>().join("/")),
		Site::RubyGems => format!("https://rubygems.org/api/v1/gems/{last}.json"),
		Site::Terraform => format!("https://registry.terraform.io/v1/modules/{}", parts.iter().skip(1).copied().collect::<Vec<_>>().join("/")),
		Site::Aur => format!("https://aur.archlinux.org/rpc/?v=5&type=info&arg={last}"),
		Site::Hackage => format!("https://hackage.haskell.org/package/{last}/{last}.json"),
		Site::MetaCpan => format!("https://fastapi.metacpan.org/v1/release/{last}"),
		Site::Repology => format!("https://repology.org/api/v1/project/{last}"),
		Site::Snapcraft => format!("https://api.snapcraft.io/v2/snaps/info/{last}"),
		Site::Ollama => format!("https://ollama.com/api/tags/{last}"),
		Site::Biorxiv => format!("https://api.{host}/details/{}/{last}/na/json", host.split('.').next()?),
		Site::Crossref => format!("https://api.crossref.org/works/{}", parts.join("/")),
		Site::Iacr => format!("https://eprint.iacr.org/{}/{}.json", parts.first()?, last),
		Site::Orcid => format!("https://pub.orcid.org/v3.0/{last}/record"),
		Site::SemanticScholar => format!("https://api.semanticscholar.org/graph/v1/paper/{last}?fields=title,abstract,authors,year,citationCount,url"),
		Site::PubMed => format!("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id={last}&retmode=json"),
		Site::Rfc => format!("https://www.rfc-editor.org/rfc/{last}.json"),
		Site::CisaKev => "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json".to_owned(),
		Site::Nvd => format!("https://services.nvd.nist.gov/rest/json/cves/2.0?cveId={last}"),
		Site::Osv => format!("https://api.osv.dev/v1/vulns/{last}"),
		Site::CoinGecko => format!("https://api.coingecko.com/api/v3/coins/{last}?localization=false&tickers=false&community_data=false&developer_data=false"),
		Site::OpenCorporates => format!("https://api.opencorporates.com/v0.4/companies/search?q={last}"),
		Site::SecEdgar => return None,
		Site::OpenLibrary => format!("https://openlibrary.org/{}.json", parts.join("/")),
		Site::ChooseALicense => format!("https://api.github.com/repos/github/choosealicense.com/contents/_licenses/{last}.txt"),
		Site::W3c => return None,
		Site::Spdx => format!("https://raw.githubusercontent.com/spdx/license-list-data/main/json/details/{last}.json"),
		Site::Wikidata => format!("https://www.wikidata.org/wiki/Special:EntityData/{last}.json"),
	};
	Some(endpoint)
}

fn render_json(markdown: &mut String, value: &Value, depth: usize) {
	if depth > 5 || markdown.len() >= 450_000 {
		return;
	}
	match value {
		Value::Object(fields) => {
			for (key, value) in fields.iter().take(80) {
				match value {
					Value::Null => {},
					Value::Bool(value) => {
						writeln!(markdown, "- **{key}:** {value}").expect("writing markdown to a string");
					},
					Value::Number(value) => {
						writeln!(markdown, "- **{key}:** {value}").expect("writing markdown to a string");
					},
					Value::String(value) if !value.trim().is_empty() => {
						writeln!(markdown, "- **{key}:** {}", value.trim())
							.expect("writing markdown to a string");
					},
					Value::Array(values) if values.iter().all(|item| item.is_string()) => {
						writeln!(
							markdown,
							"- **{key}:** {}",
							values
								.iter()
								.filter_map(Value::as_str)
								.collect::<Vec<_>>()
								.join(", ")
						)
						.expect("writing markdown to a string");
					},
					_ => {
						writeln!(markdown, "\n{}## {key}\n", "#".repeat(depth.min(3)))
							.expect("writing markdown to a string");
						render_json(markdown, value, depth + 1);
					},
				}
			}
		},
		Value::Array(values) => {
			for value in values.iter().take(40) {
				render_json(markdown, value, depth + 1);
			}
		},
		_ => {},
	}
}
