//! GitLab project pages, repository files and directories, issues, and merge
//! requests.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, html_to_markdown,
	iso_date, segment, str_of, strs_of, u64_of,
};

pub const SITE: Site = Site { name: "gitlab", open };

const PROJECTS: &str = "https://gitlab.com/api/v4/projects";

enum Route {
	Blob { reference: String, path: String },
	Tree { reference: String, path: String },
	Discussion { id: i64, merge_request: bool },
}

fn open(url: &Url, context: &Context) -> Option<Action> {
	if url.host_str()? != "gitlab.com" {
		return None;
	}
	let mut parts = url.path_segments()?.filter(|part| !part.is_empty());
	let (namespace, project) = (parts.next()?, parts.next()?);
	let route = match parts.next() {
		None => None,
		Some("-") => {
			let kind = parts.next()?;
			let arg = parts.next()?;
			Some(match kind {
				"blob" | "tree" => {
					let mut path = String::new();
					for part in parts {
						if !path.is_empty() {
							path.push('/');
						}
						path.push_str(part);
					}
					match kind {
						"tree" => Route::Tree { reference: arg.to_owned(), path },
						_ if !path.is_empty() => Route::Blob { reference: arg.to_owned(), path },
						_ => return None,
					}
				},
				"issues" | "merge_requests" if parts.next().is_none() => Route::Discussion {
					id:            parse_id(arg)?,
					merge_request: kind == "merge_requests",
				},
				_ => return None,
			})
		},
		_ => return None,
	};
	let endpoint = format!("{PROJECTS}/{}%2F{}", segment(namespace), segment(project));
	fetch(api(endpoint, context).accept_json(), move |reply, context| {
		let project = reply.json_value()?;
		if let Some(route) = route {
			let id = u64_of(&project, "id").filter(|id| *id > 0)?;
			repository_page(route, id, context)
		} else {
			repository(&project)
		}
	})
}

/// Match the leading decimal integer accepted by the original URL handler.
fn parse_id(text: &str) -> Option<i64> {
	let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
	let len = digits.bytes().take_while(u8::is_ascii_digit).count();
	text[..text.len() - digits.len() + len].parse().ok()
}

fn api(url: String, context: &Context) -> Fetch {
	Fetch::get(url).bearer(context.credential("gitlab"))
}

fn repository(repo: &Value) -> Option<Action> {
	let name = str_of(repo, "name")?;
	let mut md = format!("# {name}\n\n");
	if let Some(description) = str_of(repo, "description") {
		let _ = write!(md, "{description}\n\n");
	}
	let count = |key| format_number(f64_of(repo, key).unwrap_or_default());
	let _ = writeln!(
		md,
		"**Stars:** {} · **Forks:** {} · **Issues:** {}",
		count("star_count"),
		count("forks_count"),
		count("open_issues_count"),
	);
	let _ = writeln!(
		md,
		"**Visibility:** {} · **Default Branch:** {}",
		str_of(repo, "visibility").unwrap_or_default(),
		str_of(repo, "default_branch").unwrap_or_default(),
	);
	let topics = strs_of(repo, "topics");
	if !topics.is_empty() {
		let _ = writeln!(md, "**Topics:** {}", topics.join(", "));
	}
	let _ = write!(
		md,
		"**Created:** {} · **Last Activity:** {}\n\n",
		date(repo, "created_at"),
		date(repo, "last_activity_at"),
	);
	let mut done = Done::new(md, "gitlab-repo")
		.title(name)
		.note("Fetched repository via GitLab API");
	let Some(readme) = str_of(repo, "readme_url") else {
		return done.finish();
	};
	// This URL comes from the project metadata, not from the fixed API origin.
	fetch(Fetch::get(readme), move |reply, _| {
		if let Some(text) = reply.body_text()
			&& !text.trim().is_empty()
		{
			let _ = write!(done.markdown, "---\n\n## README\n\n{text}\n");
		}
		done.finish()
	})
}

fn repository_page(route: Route, project: u64, context: &Context) -> Option<Action> {
	match route {
		Route::Blob { reference, path } => {
			let endpoint =
				format!("{PROJECTS}/{project}/repository/files/{}/raw?ref={reference}", segment(&path));
			fetch(api(endpoint, context), |reply, _| {
				let mut done =
					Done::new(reply.body_text()?, "gitlab-raw").note("Fetched raw file via GitLab API");
				done.truncated = reply.truncated;
				done.finish()
			})
		},
		Route::Tree { reference, path } => {
			let endpoint = format!(
				"{PROJECTS}/{project}/repository/tree?ref={reference}&path={path}&per_page=100"
			);
			fetch(api(endpoint, context).accept_json(), move |reply, _| {
				let data = reply.json_value()?;
				let directory = if path.is_empty() { "/" } else { path.as_str() };
				tree(data.as_array()?, &reference, directory)
			})
		},
		Route::Discussion { id, merge_request } => {
			let collection = if merge_request {
				"merge_requests"
			} else {
				"issues"
			};
			let endpoint = format!("{PROJECTS}/{project}/{collection}/{id}");
			fetch(api(endpoint, context).accept_json(), move |reply, _| {
				discussion(&reply.json_value()?, id, merge_request)
			})
		},
	}
}

fn tree(entries: &[Value], reference: &str, directory: &str) -> Option<Action> {
	let title = format!("Directory: {directory}");
	let mut md = format!("# {title}\n\n**Ref:** {reference}\n\n");
	for (kind, section, icon, suffix) in
		[("tree", "Directories", "📁", "/"), ("blob", "Files", "📄", "")]
	{
		let names = entries
			.iter()
			.filter(|entry| str_of(entry, "type") == Some(kind))
			.filter_map(|entry| str_of(entry, "name"));
		let count = names.clone().count();
		if count == 0 {
			continue;
		}
		let _ = write!(md, "## {section} ({count})\n\n");
		for name in names {
			let _ = writeln!(md, "- {icon} {name}{suffix}");
		}
		if kind == "tree" {
			md.push('\n');
		}
	}
	Done::new(md, "gitlab-tree")
		.title(title)
		.note("Fetched directory tree via GitLab API")
		.finish()
}

fn discussion(item: &Value, id: i64, merge_request: bool) -> Option<Action> {
	let topic = str_of(item, "title")?;
	let (title, method, note) = if merge_request {
		(format!("MR !{id}: {topic}"), "gitlab-mr", "Fetched merge request via GitLab API")
	} else {
		(format!("Issue #{id}: {topic}"), "gitlab-issue", "Fetched issue via GitLab API")
	};
	let mut md = format!("# {title}\n\n");
	if merge_request && item.get("draft").and_then(Value::as_bool) == Some(true) {
		md.push_str("**[DRAFT]** ");
	}
	let author = item.get("author")?;
	let _ = writeln!(
		md,
		"**State:** {} · **Author:** {} (@{})",
		str_of(item, "state")?.to_uppercase(),
		str_of(author, "name")?,
		str_of(author, "username")?,
	);
	if merge_request {
		let _ = writeln!(
			md,
			"**Branch:** {} → {}",
			str_of(item, "source_branch")?,
			str_of(item, "target_branch")?
		);
	}
	let _ = writeln!(
		md,
		"**Created:** {} · **Updated:** {}",
		date(item, "created_at"),
		date(item, "updated_at")
	);
	if merge_request {
		let _ = write!(md, "**Merge Status:** {} · ", str_of(item, "merge_status")?);
	}
	let count = |key| u64_of(item, key).unwrap_or_default();
	let _ = writeln!(
		md,
		"**Upvotes:** {} · **Downvotes:** {} · **Comments:** {}",
		count("upvotes"),
		count("downvotes"),
		count("user_notes_count"),
	);
	let labels = strs_of(item, "labels");
	if !labels.is_empty() {
		let _ = writeln!(md, "**Labels:** {}", labels.join(", "));
	}
	let mut assignees = arr_of(item, "assignees")
		.iter()
		.filter_map(|assignee| str_of(assignee, "name"));
	if let Some(name) = assignees.next() {
		let _ = write!(md, "**Assignees:** {name}");
		for name in assignees {
			let _ = write!(md, ", {name}");
		}
		md.push('\n');
	}
	md.push_str("\n---\n\n## Description\n\n");
	if let Some(description) = str_of(item, "description") {
		md.push_str(&html_to_markdown(description, None));
	} else {
		md.push_str("*No description*");
	}
	Done::new(md, method).title(title).note(note).finish()
}

fn date<'a>(value: &'a Value, key: &str) -> &'a str {
	str_of(value, key).and_then(iso_date).unwrap_or_default()
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	const PROJECT: &str = "https://gitlab.com/group/project";
	const PROJECT_API: &str = "https://gitlab.com/api/v4/projects/group%2Fproject";
	const REPO_API: &str = "https://gitlab.com/api/v4/projects/42/repository";

	#[test]
	fn repository_routes_read_metadata_tree_or_raw_file() {
		let repo = run(PROJECT, |request| {
			if request.url == PROJECT_API {
				Fetched::json(&json!({
					"name": "Project", "description": "A widget", "star_count": 1_500, "forks_count": 7,
					"open_issues_count": 3, "visibility": "public", "default_branch": "main", "topics": ["widgets"],
					"created_at": "2026-10-01T10:00:00Z", "last_activity_at": "2026-10-02T10:00:00Z",
					"readme_url": "https://gitlab.com/group/project/-/raw/main/README.md"
				}))
			} else {
				assert_eq!(request.url, format!("{PROJECT}/-/raw/main/README.md"));
				Fetched::text("text/plain", "Setup instructions")
			}
		})
		.unwrap();
		assert_eq!(repo.method, "gitlab-repo");
		assert!(
			repo
				.markdown
				.contains("**Stars:** 1.5K · **Forks:** 7 · **Issues:** 3")
		);
		assert!(repo.markdown.contains("## README\n\nSetup instructions"));

		for (path, heading) in [("", "/"), ("/src/lib", "src/lib")] {
			let tree = run(&format!("{PROJECT}/-/tree/main{path}"), |request| {
				if request.url == PROJECT_API {
					return Fetched::json(&json!({ "id": 42 }));
				}
				assert_eq!(
					request.url,
					format!(
						"{REPO_API}/tree?ref=main&path={}&per_page=100",
						path.trim_start_matches('/')
					)
				);
				Fetched::json(
					&json!([{ "type": "blob", "name": "lib.rs" }, { "type": "tree", "name": "widgets" }]),
				)
			})
			.unwrap();
			assert_eq!(tree.method, "gitlab-tree");
			assert_eq!(
				tree.markdown,
				format!(
					"# Directory: {heading}\n\n**Ref:** main\n\n## Directories (1)\n\n- 📁 \
					 widgets/\n\n## Files (1)\n\n- 📄 lib.rs\n"
				)
			);
		}

		let file = run(&format!("{PROJECT}/-/blob/main/src/lib.rs"), |request| {
			if request.url == PROJECT_API {
				return Fetched::json(&json!({ "id": 42 }));
			}
			assert_eq!(request.url, format!("{REPO_API}/files/src%2Flib.rs/raw?ref=main"));
			Fetched { truncated: true, ..Fetched::text("text/plain", "pub mod widgets;") }
		})
		.unwrap();
		assert_eq!(
			(file.method, file.markdown.as_str(), file.truncated),
			("gitlab-raw", "pub mod widgets;", true)
		);
	}

	#[test]
	fn discussion_routes_render_state_and_html_descriptions() {
		for (kind, method, heading) in
			[("issues", "gitlab-issue", "Issue #1"), ("merge_requests", "gitlab-mr", "MR !1")]
		{
			let done = run(&format!("{PROJECT}/-/{kind}/1"), |request| {
				if request.url == PROJECT_API {
					return Fetched::json(&json!({ "id": 42 }));
				}
				assert_eq!(request.url, format!("https://gitlab.com/api/v4/projects/42/{kind}/1"));
				Fetched::json(&json!({
					"title": "Add frobnication", "description": "<p>This <strong>frobnicates</strong> the widget.</p>",
					"state": "opened", "author": { "name": "Ada", "username": "ada" }, "labels": ["widgets"],
					"created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-02T10:00:00Z",
					"upvotes": 1, "downvotes": 0, "user_notes_count": 2, "assignees": [{ "name": "Ada" }],
					"draft": true, "source_branch": "feat/frob", "target_branch": "main", "merge_status": "can_be_merged"
				}))
			})
			.unwrap();
			assert_eq!(done.method, method);
			assert!(
				done
					.markdown
					.starts_with(&format!("# {heading}: Add frobnication\n\n"))
			);
			assert!(
				done
					.markdown
					.contains("**State:** OPENED · **Author:** Ada (@ada)")
			);
			assert!(
				done
					.markdown
					.contains("**Labels:** widgets\n**Assignees:** Ada")
			);
			assert!(
				done
					.markdown
					.contains("## Description\n\nThis **frobnicates** the widget.")
			);
			if kind == "merge_requests" {
				assert!(done.markdown.contains("**[DRAFT]** **State:** OPENED"));
				assert!(done.markdown.contains("**Branch:** feat/frob → main"));
				assert!(
					done
						.markdown
						.contains("**Merge Status:** can_be_merged · **Upvotes:** 1")
				);
			} else {
				assert!(!done.markdown.contains("**Branch:**"));
			}
		}
	}

	#[test]
	fn unsupported_urls_and_api_failures_fall_through() {
		for path in ["/-/blob/main", "/-/issues/not-an-id", "/-/issues/1/edit", "/-/wikis/home"] {
			assert_eq!(run(&format!("{PROJECT}{path}"), |_| panic!("no fetch expected")), None);
		}
		assert_eq!(run(PROJECT, |_| Fetched::status(503)), None);
		assert_eq!(
			run(&format!("{PROJECT}/-/issues/1"), |request| {
				if request.url == PROJECT_API {
					Fetched::json(&json!({ "id": 42 }))
				} else {
					Fetched::status(404)
				}
			}),
			None
		);
	}
}
