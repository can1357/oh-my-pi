//! Sourcegraph public GraphQL search, repository metadata and file contents.

use std::fmt::Write as _;

use serde_json::{Value, json};
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, decode_segment, fetch, str_of};

pub const SITE: Site = Site { name: "sourcegraph", open };

const GRAPHQL: &str = "https://sourcegraph.com/.api/graphql";
const NOTE: &str = "Fetched via Sourcegraph GraphQL API";
const MAX_RESULTS: usize = 10;
const MAX_LINES: usize = 5;

const REPO_QUERY: &str = "query Repo($name: String!) {
	repository(name: $name) {
		name
		url
		description
		defaultBranch { name }
	}
}";

const FILE_QUERY: &str = "query RepoFile($name: String!, $path: String!, $rev: String!) {
	repository(name: $name) {
		name
		url
		description
		defaultBranch { name }
		commit(rev: $rev) {
			blob(path: $path) { content }
		}
	}
}";

const SEARCH_QUERY: &str = "query Search($query: String!) {
	search(query: $query, version: V2) {
		results {
			results {
				__typename
				... on FileMatch {
					repository { name url }
					file { path url }
					lineMatches { preview lineNumber }
				}
				... on Repository { name url }
			}
			matchCount
			limitHit
		}
	}
}";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "sourcegraph.com" | "www.sourcegraph.com") {
		return None;
	}
	if url.path().starts_with("/search") {
		let query = url.query_pairs().find(|(key, _)| key == "q")?.1;
		let query = query.trim();
		if query.is_empty() {
			return None;
		}
		let request = graphql(SEARCH_QUERY, json!({ "query": query }));
		let query = query.to_owned();
		return fetch(request, move |reply, _| {
			let data = reply.json_value()?;
			render_search(&data_field(&data)?["search"]["results"], &query)
		});
	}

	let parts: Vec<_> = url
		.path_segments()?
		.filter(|part| !part.is_empty())
		.map(decode_segment)
		.collect::<Option<_>>()?;
	let repo_end = parts
		.iter()
		.position(|part| part == "-")
		.unwrap_or(parts.len());
	if repo_end < 3 {
		return None;
	}
	let (head, tail) = parts.split_at(repo_end - 1);
	let at = tail[0].find('@').filter(|&at| at > 0);
	let (repo_tail, rev) =
		at.map_or_else(|| (tail[0].as_ref(), ""), |at| (&tail[0][..at], &tail[0][at + 1..]));
	let mut name = head.join("/");
	name.push('/');
	name.push_str(repo_tail);
	let route = &parts[repo_end..];
	if route.get(1).is_some_and(|part| part == "blob") {
		let path = route[2..].join("/");
		if path.is_empty() {
			return None;
		}
		let rev = if rev.is_empty() { "HEAD" } else { rev };
		let request = graphql(FILE_QUERY, json!({ "name": name, "path": path, "rev": rev }));
		let rev = rev.to_owned();
		return fetch(request, move |reply, _| {
			let data = reply.json_value()?;
			let repo = &data_field(&data)?["repository"];
			let content = repo["commit"]["blob"]["content"].as_str()?;
			let (title, mut md) = repo_markdown(repo)?;
			let _ = writeln!(
				md,
				"\n**Path:** {path}\n**Revision:** {rev}\n\n---\n\n## File\n\n```text\n{content}\n```"
			);
			Done::new(md, "sourcegraph-file")
				.title(title)
				.note(NOTE)
				.finish()
		});
	}

	fetch(graphql(REPO_QUERY, json!({ "name": name })), |reply, _| {
		let data = reply.json_value()?;
		let (title, md) = repo_markdown(&data_field(&data)?["repository"])?;
		Done::new(md, "sourcegraph-repo")
			.title(title)
			.note(NOTE)
			.finish()
	})
}

fn graphql(query: &str, variables: Value) -> Fetch {
	Fetch::post_json(GRAPHQL, &json!({ "query": query, "variables": variables }))
}

fn data_field(reply: &Value) -> Option<&Value> {
	if !arr_of(reply, "errors").is_empty() {
		return None;
	}
	reply.get("data")
}

fn repo_markdown(repo: &Value) -> Option<(&str, String)> {
	let title = str_of(repo, "name")?;
	let link = str_of(repo, "url")?;
	let mut md = format!("# {title}\n\n");
	if let Some(description) = str_of(repo, "description") {
		let _ = write!(md, "{description}\n\n");
	}
	let _ = writeln!(md, "**URL:** {link}");
	if let Some(branch) = str_of(&repo["defaultBranch"], "name") {
		let _ = writeln!(md, "**Default branch:** {branch}");
	}
	Some((title, md))
}

fn render_search(data: &Value, query: &str) -> Option<Action> {
	if !data.is_object() {
		return None;
	}
	let title = "Sourcegraph Search";
	let mut md = format!("# {title}\n\n**Query:** `{query}`\n");
	if let Value::Number(count) = &data["matchCount"] {
		let _ = writeln!(md, "**Matches:** {count}");
	}
	if let Some(limit_hit) = data["limitHit"].as_bool() {
		let _ = writeln!(md, "**Limit hit:** {}", if limit_hit { "yes" } else { "no" });
	}
	md.push('\n');
	let results = arr_of(data, "results");
	if results.is_empty() {
		md.push_str("_No results._\n");
	} else {
		md.push_str("## Results\n\n");
		for result in results.iter().take(MAX_RESULTS) {
			match result["__typename"].as_str() {
				Some("FileMatch") => write_file_match(&mut md, result),
				Some("Repository") => {
					let title = result["name"].as_str().unwrap_or("unknown");
					let _ = write!(md, "### {title}\n\n");
					if let Some(link) = str_of(result, "url") {
						let _ = writeln!(md, "**Repository:** {link}");
					}
					md.push('\n');
				},
				_ => {},
			}
		}
		if results.len() > MAX_RESULTS {
			let _ = writeln!(md, "[…{} results elided…]", results.len() - MAX_RESULTS);
		}
	}
	Done::new(md, "sourcegraph-search")
		.title(title)
		.note(NOTE)
		.finish()
}

fn write_file_match(md: &mut String, result: &Value) {
	let repo = &result["repository"];
	let file = &result["file"];
	let name = repo["name"].as_str().unwrap_or("unknown");
	let path = file["path"].as_str().unwrap_or("unknown");
	let _ = write!(md, "### {name}/{path}\n\n");
	if let Some(link) = str_of(repo, "url") {
		let _ = writeln!(md, "**Repository:** {link}");
	}
	if let Some(link) = str_of(file, "url") {
		let _ = writeln!(md, "**File:** {link}");
	}
	let lines = arr_of(result, "lineMatches");
	if lines.is_empty() {
		return;
	}
	md.push_str("\n```text\n");
	for line in lines.iter().take(MAX_LINES) {
		let number = line["lineNumber"].as_i64().unwrap_or(0);
		let _ = write!(md, "L{number}: ");
		let mut parts = line["preview"].as_str().unwrap_or_default().trim().lines();
		md.push_str(parts.next().unwrap_or_default());
		for part in parts {
			md.push(' ');
			md.push_str(part);
		}
		md.push('\n');
	}
	md.push_str("```\n\n");
}

#[cfg(test)]
mod tests {
	use super::{
		super::{Fetched, testing::run},
		*,
	};

	fn variables(request: &Fetch) -> Value {
		assert_eq!(request.method, "POST");
		assert_eq!(request.url, GRAPHQL);
		let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
		body["variables"].clone()
	}

	#[test]
	fn repo_routes_and_blobs_send_their_distinct_graphql_variables() {
		for (suffix, method, expected) in [
			("@old/-/tree/src", "sourcegraph-repo", json!({"name": "github.com/acme/tools"})),
			(
				"/-/blob/lib.rs",
				"sourcegraph-file",
				json!({"name": "github.com/acme/tools", "path": "lib.rs", "rev": "HEAD"}),
			),
			(
				"@feature%2Fone/-/blob/src/a+b%20c.rs",
				"sourcegraph-file",
				json!({"name": "github.com/acme/tools", "path": "src/a+b c.rs", "rev": "feature/one"}),
			),
		] {
			let done = run(&format!("https://www.sourcegraph.com/github.com/acme/tools{suffix}"), |request| {
				assert_eq!(variables(request), expected);
				Fetched::json(&json!({"data": {"repository": {
					"name": "github.com/acme/tools", "url": "/github.com/acme/tools", "defaultBranch": {"name": "main"},
					"commit": {"blob": {"content": "  indented\n"}}
				}}}))
			}).unwrap();
			assert_eq!(done.method, method);
			assert!(done.markdown.contains("**Default branch:** main"));
			if method == "sourcegraph-file" {
				assert!(done.markdown.contains("```text\n  indented\n\n```"));
				assert!(done.markdown.contains(expected["rev"].as_str().unwrap()));
			} else {
				assert!(!done.markdown.contains("## File"));
			}
		}
	}

	#[test]
	fn search_renders_matches_and_flattens_line_previews() {
		let done =
			run("https://sourcegraph.com/search/stream?q=+repo%3Atools+find%2Bme+", |request| {
				assert_eq!(variables(request), json!({"query": "repo:tools find+me"}));
				Fetched::json(
					&json!({"data": {"search": {"results": {"matchCount": 12, "limitHit": true, "results": [
						{"__typename": "FileMatch", "repository": {"name": "acme/tools", "url": "/acme/tools"},
							"file": {"path": "lib.rs", "url": "/acme/tools/-/blob/lib.rs"},
							"lineMatches": [{"lineNumber": 2, "preview": "  find\nme  "}]},
						{"__typename": "Repository", "name": "acme/more", "url": "/acme/more"}
					]}}}}),
				)
			})
			.unwrap();
		assert_eq!(done.method, "sourcegraph-search");
		assert!(
			done
				.markdown
				.contains("**Matches:** 12\n**Limit hit:** yes")
		);
		assert!(done.markdown.contains("### acme/tools/lib.rs\n\n"));
		assert!(
			done.markdown.contains("L2: find me\n```") && done.markdown.contains("### acme/more\n\n")
		);
	}

	#[test]
	fn malformed_routes_and_graphql_errors_decline() {
		assert_eq!(
			run("https://sourcegraph.com/github.com/acme/tools/-/blob", |_| panic!(
				"no fetch expected"
			)),
			None
		);
		assert_eq!(run("https://sourcegraph.com/search?q=+", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://sourcegraph.com/github.com/acme/tools", |_| Fetched::status(503)),
			None
		);
		assert_eq!(
			run("https://sourcegraph.com/github.com/acme/tools", |_| {
				Fetched::json(&json!({"errors": [{"message": "unavailable"}], "data": {
					"repository": {"name": "github.com/acme/tools", "url": "/github.com/acme/tools"}
				}}))
			}),
			None
		);
	}
}
