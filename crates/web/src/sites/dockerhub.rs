//! Docker Hub (`hub.docker.com/_/<image>` and `/r/<namespace>/<repo>`):
//! repository stats and recent tags from the Docker Hub API.

use std::{fmt::Write as _, sync::LazyLock};

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, iso_date, str_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "dockerhub", open };

const METHOD: &str = "dockerhub";

static OFFICIAL_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/_/([^/]+)").unwrap());
static REPO_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/r/([^/]+)/([^/]+)").unwrap());

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("hub.docker.com") {
		return None;
	}
	let path = url.path();
	let (namespace, repository) = if let Some(captures) = OFFICIAL_PATH.captures(path) {
		("library".to_owned(), captures.get(1)?.as_str().to_owned())
	} else {
		let captures = REPO_PATH.captures(path)?;
		(captures.get(1)?.as_str().to_owned(), captures.get(2)?.as_str().to_owned())
	};
	let repo_url = format!("https://hub.docker.com/v2/repositories/{namespace}/{repository}/");
	fetch(Fetch::get(repo_url).accept_json(), move |reply, _| {
		let repo = reply.json_value()?;
		let name = str_of(&repo, "name").unwrap_or(&repository).to_owned();
		let full_name = if namespace == "library" {
			name
		} else {
			format!("{namespace}/{name}")
		};
		let tags_url = format!(
			"https://hub.docker.com/v2/repositories/{namespace}/{repository}/tags/?page_size=10"
		);
		fetch(Fetch::get(tags_url).accept_json(), move |reply, _| {
			let tags = reply
				.json_value()
				.and_then(|data| data.get("results").and_then(Value::as_array).cloned())
				.unwrap_or_default();
			let md = markdown(&full_name, &repo, &tags);
			Done::new(md, METHOD)
				.title(full_name)
				.note("Fetched via Docker Hub API")
				.finish()
		})
	})
}

fn markdown(full_name: &str, repo: &Value, tags: &[Value]) -> String {
	let mut md = format!("# {full_name}\n\n");
	if let Some(description) = str_of(repo, "description") {
		let _ = write!(md, "{description}\n\n");
	}

	let mut stats: Vec<String> = Vec::new();
	if let Some(pulls) = u64_of(repo, "pull_count") {
		stats.push(format!("**Pulls:** {}", format_number(pulls as f64)));
	}
	if let Some(stars) = u64_of(repo, "star_count") {
		stats.push(format!("**Stars:** {}", format_number(stars as f64)));
	}
	if repo.get("is_official").and_then(Value::as_bool) == Some(true) {
		stats.push("**Official Image**".to_owned());
	}
	if repo.get("is_automated").and_then(Value::as_bool) == Some(true) {
		stats.push("**Automated Build**".to_owned());
	}
	if !stats.is_empty() {
		let _ = writeln!(md, "{}", stats.join(" · "));
	}
	if let Some(updated) = str_of(repo, "last_updated") {
		let _ = writeln!(md, "**Last Updated:** {}", iso_date(updated).unwrap_or_default());
	}
	md.push('\n');

	md.push_str("## Quick Start\n\n```bash\n");
	let _ = writeln!(md, "docker pull {full_name}");
	md.push_str("```\n\n");

	if !tags.is_empty() {
		md.push_str(
			"## Recent Tags\n\n| Tag | Size | Architectures | Updated \
			 |\n|-----|------|---------------|--------|\n",
		);
		for tag in tags {
			let size = u64_of(tag, "full_size")
				.filter(|size| *size > 0)
				.map_or_else(|| "-".to_owned(), format_bytes);
			let archs: Vec<&str> = arr_of(tag, "images")
				.iter()
				.filter_map(|image| str_of(image, "architecture"))
				.collect();
			let archs = if archs.is_empty() {
				"-".to_owned()
			} else {
				archs.join(", ")
			};
			let updated = str_of(tag, "last_updated").map_or_else(
				|| "-".to_owned(),
				|updated| iso_date(updated).unwrap_or_default().to_owned(),
			);
			let _ = writeln!(
				md,
				"| `{}` | {size} | {archs} | {updated} |",
				str_of(tag, "name").unwrap_or_default()
			);
		}
		md.push('\n');
	}
	md
}

/// Binary byte count (`512B`, `1.5KB`, `2.3MB`, `1.2GB`).
fn format_bytes(bytes: u64) -> String {
	const KB: f64 = 1024.0;
	const MB: f64 = KB * 1024.0;
	const GB: f64 = MB * 1024.0;
	let value = bytes as f64;
	if value < KB {
		format!("{bytes}B")
	} else if value < MB {
		format!("{:.1}KB", value / KB)
	} else if value < GB {
		format!("{:.1}MB", value / MB)
	} else {
		format!("{:.1}GB", value / GB)
	}
}

#[cfg(test)]
mod tests {
	use serde_json::{Value, json};

	use super::super::{Fetched, testing::run};

	fn repo() -> Value {
		json!({
			"name": "nginx", "namespace": "library", "description": "Official build of Nginx.",
			"star_count": 19_000, "pull_count": 1_234_567_890, "last_updated": "2024-01-02T03:04:05.000000Z",
			"is_official": true, "is_automated": false
		})
	}

	fn tags() -> Value {
		json!({ "results": [
			{
				"name": "1.25", "last_updated": "2024-01-02T03:04:05.000000Z", "full_size": 1_536,
				"images": [{ "architecture": "amd64", "size": 1_536 }, { "architecture": "arm64" }]
			},
			{ "name": "latest", "full_size": 0, "images": [] }
		] })
	}

	#[test]
	fn an_official_image_reads_the_repository_and_its_tags() {
		let mut requests = Vec::new();
		let done = run("https://hub.docker.com/_/nginx", |request| {
			requests.push(request.url.clone());
			if request.url.contains("/tags/") {
				Fetched::json(&tags())
			} else {
				Fetched::json(&repo())
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://hub.docker.com/v2/repositories/library/nginx/",
			"https://hub.docker.com/v2/repositories/library/nginx/tags/?page_size=10"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("dockerhub", Some("nginx")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# nginx\n\nOfficial build of Nginx.\n\n**Pulls:** 1.2B · **Stars:** 19K · **Official \
			 Image**\n**Last Updated:** 2024-01-02\n\n## Quick Start\n\n```bash\ndocker pull \
			 nginx\n```\n\n## Recent Tags\n\n"
		));
		assert!(
			md.contains("| `1.25` | 1.5KB | amd64, arm64 | 2024-01-02 |\n| `latest` | - | - | - |\n")
		);
	}

	#[test]
	fn a_namespaced_image_keeps_the_namespace_in_the_pull_command() {
		let done = run("https://hub.docker.com/r/grafana/grafana", |request| {
			if request.url.contains("/tags/") {
				Fetched::status(404)
			} else {
				Fetched::json(&json!({ "name": "grafana", "pull_count": 10, "star_count": 2 }))
			}
		})
		.unwrap();
		assert_eq!(done.title.as_deref(), Some("grafana/grafana"));
		assert!(done.markdown.starts_with(
			"# grafana/grafana\n\n**Pulls:** 10 · **Stars:** 2\n\n## Quick Start\n\n```bash\ndocker \
			 pull grafana/grafana\n```\n"
		));
		assert!(!done.markdown.contains("## Recent Tags"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://hub.docker.com/search", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/_/nginx", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://hub.docker.com/_/nginx", |_| Fetched::status(500)), None);
	}
}
