//! Repology (`repology.org/project/<name>`): packaging status across
//! distributions from the Repology API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, segment, str_of, strs_of};

/// Registry entry.
pub const SITE: Site = Site { name: "repology", open };

const METHOD: &str = "repology";
/// Repositories listed in the table before eliding the rest.
const SHOWN_REPOS: usize = 15;

/// Version statuses, richest first; also the table's sort order.
const STATUS_ORDER: [&str; 10] = [
	"newest",
	"unique",
	"devel",
	"rolling",
	"outdated",
	"legacy",
	"noscheme",
	"incorrect",
	"untrusted",
	"ignored",
];

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "repology.org" | "www.repology.org") {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "project" {
		return None;
	}
	let name = segments.next().filter(|name| !name.is_empty())?.to_owned();
	let page_url = url.as_str().to_owned();
	let request = Fetch::get(format!("https://repology.org/api/v1/project/{}", segment(&name)))
		.accept_json()
		.header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
	fetch(request, move |reply, _| {
		let packages = reply.json_value()?;
		let packages = packages.as_array()?;
		if packages.is_empty() {
			return None;
		}
		summary(&name, packages, &page_url).finish()
	})
}

/// The status's emoji indicator.
fn indicator(status: &str) -> &'static str {
	match status {
		"newest" => "✅",
		"devel" => "🚧",
		"unique" => "🔵",
		"outdated" => "🔴",
		"legacy" => "⚠️",
		"rolling" => "🔄",
		_ => "➖",
	}
}

/// A human-readable repository name.
fn prettify_repo(repo: &str) -> String {
	const MAPPING: [(&str, &str); 29] = [
		("arch", "Arch Linux"),
		("aur", "AUR"),
		("debian_unstable", "Debian Unstable"),
		("debian_stable", "Debian Stable"),
		("ubuntu_24_04", "Ubuntu 24.04"),
		("ubuntu_22_04", "Ubuntu 22.04"),
		("fedora_rawhide", "Fedora Rawhide"),
		("fedora_40", "Fedora 40"),
		("gentoo", "Gentoo"),
		("nix_unstable", "Nixpkgs Unstable"),
		("nix_stable", "Nixpkgs Stable"),
		("homebrew", "Homebrew"),
		("macports", "MacPorts"),
		("alpine_edge", "Alpine Edge"),
		("freebsd", "FreeBSD"),
		("openbsd", "OpenBSD"),
		("void_x86_64", "Void Linux"),
		("opensuse_tumbleweed", "openSUSE Tumbleweed"),
		("msys2_mingw", "MSYS2"),
		("chocolatey", "Chocolatey"),
		("winget", "Winget"),
		("scoop", "Scoop"),
		("conda_main", "Conda"),
		("pypi", "PyPI"),
		("crates_io", "Crates.io"),
		("npm", "npm"),
		("rubygems", "RubyGems"),
		("cpan", "CPAN"),
		("hackage", "Hackage"),
	];
	if let Some((_, name)) = MAPPING.iter().find(|(key, _)| *key == repo) {
		return (*name).to_owned();
	}
	if let Some((_, name)) = MAPPING.iter().find(|(key, _)| repo.starts_with(key)) {
		return (*name).to_owned();
	}
	repo
		.split('_')
		.map(|word| {
			let mut chars = word.chars();
			chars.next().map_or_else(String::new, |first| {
				first.to_uppercase().collect::<String>() + chars.as_str()
			})
		})
		.collect::<Vec<_>>()
		.join(" ")
}

fn priority(package: &Value) -> u8 {
	let status = str_of(package, "status").unwrap_or("");
	STATUS_ORDER
		.iter()
		.position(|candidate| *candidate == status)
		.map_or(10, |index| index as u8)
}

fn summary(name: &str, packages: &[Value], page_url: &str) -> Done {
	let mut newest_versions: Vec<String> = Vec::new();
	let mut summary: Option<&str> = None;
	let mut licenses: Vec<String> = Vec::new();
	let mut categories: Vec<&str> = Vec::new();

	for package in packages {
		let status = str_of(package, "status").unwrap_or("");
		if matches!(status, "newest" | "unique")
			&& let Some(version) = str_of(package, "version")
			&& !newest_versions.iter().any(|seen| seen == version)
		{
			newest_versions.push(version.to_owned());
		}
		if summary.is_none() {
			summary = str_of(package, "summary");
		}
		if licenses.is_empty() {
			licenses = strs_of(package, "licenses")
				.into_iter()
				.map(str::to_owned)
				.collect();
		}
		for category in strs_of(package, "categories") {
			if !categories.contains(&category) {
				categories.push(category);
			}
		}
	}
	if newest_versions.is_empty()
		&& let Some(version) = packages
			.first()
			.and_then(|package| str_of(package, "version"))
	{
		newest_versions.push(version.to_owned());
	}

	let mut md = format!("# {name}\n\n");
	if let Some(summary) = summary {
		let _ = write!(md, "{summary}\n\n");
	}
	let newest = if newest_versions.is_empty() {
		"unknown".to_owned()
	} else {
		newest_versions.join(", ")
	};
	let _ = writeln!(md, "**Newest Version:** {newest}");
	let _ = writeln!(md, "**Repositories:** {}", packages.len());
	if !licenses.is_empty() {
		let _ = writeln!(md, "**License:** {}", licenses.join(", "));
	}
	if !categories.is_empty() {
		let _ = writeln!(md, "**Categories:** {}", categories.join(", "));
	}
	md.push('\n');

	md.push_str("## Version Status Summary\n\n");
	for status in STATUS_ORDER {
		let count = packages
			.iter()
			.filter(|package| str_of(package, "status") == Some(status))
			.count();
		if count > 0 {
			let _ = writeln!(md, "- {} **{status}**: {count} repos", indicator(status));
		}
	}
	md.push('\n');

	let mut sorted: Vec<&Value> = packages.iter().collect();
	sorted.sort_by(|a, b| {
		priority(a).cmp(&priority(b)).then_with(|| {
			str_of(a, "repo")
				.unwrap_or("")
				.cmp(str_of(b, "repo").unwrap_or(""))
		})
	});

	md.push_str("## Package Versions by Repository\n\n");
	md.push_str("| Repository | Version | Status |\n");
	md.push_str("|------------|---------|--------|\n");
	let mut shown: Vec<String> = Vec::new();
	let mut count = 0;
	for package in sorted {
		let repo = str_of(package, "repo").unwrap_or("");
		let key = match str_of(package, "subrepo") {
			Some(subrepo) => format!("{repo}/{subrepo}"),
			None => repo.to_owned(),
		};
		if shown.contains(&key) {
			continue;
		}
		shown.push(key);
		let version = str_of(package, "origversion")
			.or_else(|| str_of(package, "version"))
			.unwrap_or("");
		let status = str_of(package, "status").unwrap_or("");
		let _ =
			writeln!(md, "| {} | `{version}` | {} {status} |", prettify_repo(repo), indicator(status));
		count += 1;
		if count >= SHOWN_REPOS {
			break;
		}
	}
	if packages.len() > SHOWN_REPOS {
		let _ = write!(md, "\n[…{} repositories elided…]\n", packages.len() - SHOWN_REPOS);
	}

	let _ = write!(md, "\n---\n\n[View on Repology]({page_url})\n");

	Done::new(md, METHOD)
		.title(name)
		.note("Fetched via Repology API")
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn api() -> serde_json::Value {
		json!([
			{ "repo": "arch", "version": "1.2.3", "status": "newest", "summary": "A text editor",
			  "categories": ["editors"], "licenses": ["MIT"] },
			{ "repo": "debian_unstable", "version": "1.2.2", "status": "outdated" },
			{ "repo": "nix_unstable", "version": "1.2.3", "status": "newest", "categories": ["editors"] },
			{ "repo": "arch", "subrepo": "extra", "version": "1.2.4", "status": "devel" }
		])
	}

	#[test]
	fn a_project_page_summarises_packaging_status() {
		let mut requests = Vec::new();
		let done = run("https://repology.org/project/vim/versions", |request| {
			requests.push(request.clone());
			Fetched::json(&api())
		})
		.unwrap();
		assert_eq!(requests.len(), 1);
		assert_eq!(requests[0].url, "https://repology.org/api/v1/project/vim");
		assert!(requests[0].headers.contains(&(
			"User-Agent".to_owned(),
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36".to_owned()
		)));
		assert_eq!((done.method, done.title.as_deref()), ("repology", Some("vim")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# vim\n\nA text editor\n\n**Newest Version:** 1.2.3\n**Repositories:** 4\n**License:** \
			 MIT\n**Categories:** editors\n\n## Version Status Summary\n\n- ✅ **newest**: 2 \
			 repos\n- 🚧 **devel**: 1 repos\n- 🔴 **outdated**: 1 repos\n\n"
		));
		assert!(md.contains(
			"## Package Versions by Repository\n\n| Repository | Version | Status \
			 |\n|------------|---------|--------|\n| Arch Linux | `1.2.3` | ✅ newest |\n| Nixpkgs \
			 Unstable | `1.2.3` | ✅ newest |\n| Arch Linux | `1.2.4` | 🚧 devel |\n| Debian \
			 Unstable | `1.2.2` | 🔴 outdated |\n"
		));
		assert!(
			md.ends_with("\n---\n\n[View on Repology](https://repology.org/project/vim/versions)\n")
		);
	}

	#[test]
	fn an_empty_package_list_declines() {
		assert_eq!(run("https://repology.org/project/nope", |_| Fetched::json(&json!([]))), None);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://repology.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://repology.org/project/vim", |_| Fetched::status(404)), None);
	}
}
