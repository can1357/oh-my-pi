//! GitHub repository pages, files, commits, issues, pull requests and workflow
//! runs.

mod actions;
mod commit;
mod issues;

use std::fmt::Write as _;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, segment, str_of, u64_of};

pub const SITE: Site = Site { name: "github", open };

struct Repo<'a> {
	owner: &'a str,
	name:  &'a str,
}

impl Repo<'_> {
	fn endpoint(&self) -> String {
		format!("/repos/{}/{}", self.owner, self.name)
	}

	fn raw_root(&self) -> String {
		format!("https://raw.githubusercontent.com/{}/{}", self.owner, self.name)
	}
}

fn open(url: &Url, context: &Context) -> Option<Action> {
	if url.host_str()? != "github.com" {
		return None;
	}
	let mut parts = url.path_segments()?.filter(|part| !part.is_empty());
	let repo = Repo { owner: parts.next()?, name: parts.next()? };
	match parts.next() {
		None => repository(context, repo.endpoint()),
		Some("blob") => {
			let reference = parts.next()?;
			let file = raw_url(&repo.raw_root(), reference, &join_path(parts));
			fetch(Fetch::get(file.clone()), move |reply, _| {
				let mut done =
					Done::new(reply.body_text()?, "github-raw").note(format!("Fetched raw: {file}"));
				done.url = Some(file);
				done.truncated = reply.truncated;
				done.finish()
			})
		},
		Some("tree") => tree(context, repo, parts.next(), join_path(parts)),
		Some("commit") => commit::read(context, repo, parts.next()?),
		Some(section @ ("issues" | "pull")) => {
			let pull = section == "pull";
			if let Some(number) = number(parts.next()) {
				issues::read(context, repo, number, pull)
			} else {
				issues::list(context, repo, url, pull)
			}
		},
		Some("pulls") => issues::list(context, repo, url, true),
		Some("actions") if parts.next() == Some("runs") => {
			let run = number(parts.next())?;
			if matches!(parts.next(), Some("job" | "jobs"))
				&& let Some(job) = number(parts.next())
			{
				actions::job(context, repo, run, job)
			} else {
				actions::run(context, repo, run)
			}
		},
		_ => None,
	}
}

fn number(part: Option<&str>) -> Option<u64> {
	let part = part?;
	if !part.bytes().all(|b| b.is_ascii_digit()) {
		return None;
	}
	part.parse().ok()
}

fn join_path<'a>(mut parts: impl Iterator<Item = &'a str>) -> String {
	let Some(first) = parts.next() else {
		return String::new();
	};
	let mut path = first.to_owned();
	for part in parts {
		path.push('/');
		path.push_str(part);
	}
	path
}

fn raw_url(root: &str, reference: &str, path: &str) -> String {
	format!("{root}/{reference}/{path}")
}

fn api(context: &Context, endpoint: impl std::fmt::Display) -> Fetch {
	Fetch::get(format!("https://api.github.com{endpoint}"))
		.header("Accept", "application/vnd.github.v3+json")
		.bearer(context.credential("github"))
}

fn api_done(markdown: String, method: &'static str) -> Done {
	Done::new(markdown, method).note("Fetched via GitHub API")
}

fn login(data: &Value) -> &str {
	str_of(&data["user"], "login").unwrap_or("ghost")
}

fn repository(context: &Context, endpoint: String) -> Option<Action> {
	fetch(api(context, &endpoint), move |reply, context| {
		let repo = reply.json_value()?;
		let mut md = format!("# {}\n\n", str_of(&repo, "full_name")?);
		if let Some(description) = str_of(&repo, "description") {
			let _ = write!(md, "{description}\n\n");
		}
		let count = |key| u64_of(&repo, key).unwrap_or(0);
		let _ = writeln!(
			md,
			"Stars: {} · Forks: {} · Issues: {}",
			count("stargazers_count"),
			count("forks_count"),
			count("open_issues_count"),
		);
		if let Some(language) = str_of(&repo, "language") {
			let _ = writeln!(md, "Language: {language}");
		}
		if let Some(license) = str_of(&repo["license"], "name") {
			let _ = writeln!(md, "License: {license}");
		}
		md.push_str("\n---\n\n");
		fetch(
			api(context, format_args!("{endpoint}/git/trees/HEAD?recursive=1")),
			move |reply, context| {
				if let Some(data) = reply.json_value()
					&& let Some(tree) = data["tree"].as_array()
				{
					md.push_str("## Files\n\n```\n");
					for item in tree.iter().take(100) {
						let prefix = if item["type"] == "tree" {
							"[dir] "
						} else {
							"      "
						};
						let _ = writeln!(md, "{prefix}{}", str_of(item, "path").unwrap_or_default());
					}
					if tree.len() > 100 {
						let _ = writeln!(md, "[…{} files elided…]", tree.len() - 100);
					}
					md.push_str("```\n\n");
				}
				fetch(api(context, format_args!("{endpoint}/readme")), move |reply, _| {
					if let Some(mut readme) = reply.json_value()
						&& readme["encoding"] == "base64"
						&& let Some(Value::String(mut content)) =
							readme.get_mut("content").map(Value::take)
					{
						// GitHub wraps base64 at 60 characters per line.
						content.retain(|c| !c.is_ascii_whitespace());
						if let Ok(decoded) = STANDARD.decode(content) {
							let _ = write!(md, "## README\n\n{}", String::from_utf8_lossy(&decoded));
						}
					}
					api_done(md, "github-repo").finish()
				})
			},
		)
	})
}

fn tree(
	context: &Context,
	repo: Repo<'_>,
	reference: Option<&str>,
	path: String,
) -> Option<Action> {
	let endpoint = repo.endpoint();
	let raw_root = repo.raw_root();
	let reference = reference.map(str::to_owned);
	fetch(api(context, &endpoint), move |reply, context| {
		let repo = reply.json_value()?;
		let name = str_of(&repo, "full_name")?.to_owned();
		let reference = reference.or_else(|| str_of(&repo, "default_branch").map(str::to_owned))?;
		Tree { endpoint, raw_root, name, reference, path, offset: 0 }.contents(context)
	})
}

struct Tree {
	endpoint:  String,
	raw_root:  String,
	name:      String,
	reference: String,
	path:      String,
	offset:    usize,
}

impl Tree {
	fn contents(mut self, context: &Context) -> Option<Action> {
		let path = &self.path[self.offset..];
		let request = api(
			context,
			format_args!("{}/contents/{path}?ref={}", self.endpoint, segment(&self.reference)),
		);
		fetch(request, move |reply, context| {
			let path = &self.path[self.offset..];
			if reply.status == 404 && !path.is_empty() {
				// In web URLs the slash in a branch name is indistinguishable from
				// a directory separator. Try moving one path component into the
				// ref.
				let end = path.find('/').unwrap_or(path.len());
				self.reference.push('/');
				self.reference.push_str(&path[..end]);
				self.offset += (end + 1).min(path.len());
				return self.contents(context);
			}
			let mut contents = reply.json_value()?;
			if contents.is_object() {
				// A tree URL naming a file serves that file instead of a listing.
				return fetch(
					Fetch::get(raw_url(&self.raw_root, &self.reference, path)),
					|reply, _| {
						let mut done = api_done(reply.body_text()?, "github-tree");
						done.truncated = reply.truncated;
						done.finish()
					},
				);
			}
			let items = contents.as_array_mut()?;
			items.sort_unstable_by(|a, b| {
				let a_dir = a["type"] == "dir";
				let b_dir = b["type"] == "dir";
				let a = str_of(a, "name").unwrap_or_default();
				let b = str_of(b, "name").unwrap_or_default();
				b_dir.cmp(&a_dir).then_with(|| {
					a.chars()
						.flat_map(char::to_lowercase)
						.cmp(b.chars().flat_map(char::to_lowercase))
						.then_with(|| b.cmp(a))
				})
			});
			let dir = if path.is_empty() { "(root)" } else { path };
			let mut md = format!(
				"# {}/{dir}\n\n**Branch:** {}\n\n## Contents\n\n```\n",
				self.name, self.reference
			);
			let mut readme = None;
			for item in items {
				let name = str_of(item, "name")?;
				let prefix = if item["type"] == "dir" {
					"[dir] "
				} else {
					"      "
				};
				let _ = write!(md, "{prefix}{name}");
				if item["type"] == "file" {
					if let Some(size) = u64_of(item, "size").filter(|size| *size > 0) {
						let _ = write!(md, " ({size} bytes)");
					}
					if readme.is_none() && name.eq_ignore_ascii_case("readme.md") {
						readme = Some(name);
					}
				}
				md.push('\n');
			}
			md.push_str("```\n\n");
			let Some(readme) = readme else {
				return api_done(md, "github-tree").finish();
			};
			let parent = if path.is_empty() { "" } else { "/" };
			let raw = format!("{}/{}/{path}{parent}{readme}", self.raw_root, self.reference);
			fetch(Fetch::get(raw), move |reply, _| {
				let text = reply.body_text();
				if let Some(text) = text.as_deref() {
					let _ = write!(md, "---\n\n## README\n\n{text}");
				}
				let mut done = api_done(md, "github-tree");
				done.truncated = text.is_some() && reply.truncated;
				done.finish()
			})
		})
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_tree_resolves_branch_slashes_but_declines_if_no_ref_can_list_it() {
		let url = "https://github.com/o/r/tree/feature/docs/guide";
		let done = run(url, |request| match request.url.as_str() {
			"https://api.github.com/repos/o/r" => {
				Fetched::json(&json!({"full_name": "o/r", "default_branch": "main"}))
			},
			"https://api.github.com/repos/o/r/contents/docs/guide?ref=feature" => Fetched::status(404),
			"https://api.github.com/repos/o/r/contents/guide?ref=feature%2Fdocs" => {
				Fetched::json(&json!([
					{"type": "file", "name": "README.md", "size": 20},
					{"type": "dir", "name": "samples", "size": 0},
				]))
			},
			"https://raw.githubusercontent.com/o/r/feature/docs/guide/README.md" => {
				assert!(
					request
						.headers
						.iter()
						.all(|(name, _)| name != "Authorization")
				);
				Fetched::text("text/plain", "# Guide\n\nThe directory README.")
			},
			url => panic!("unexpected request: {url}"),
		})
		.unwrap();
		assert_eq!(done.method, "github-tree");
		assert!(
			done
				.markdown
				.starts_with("# o/r/guide\n\n**Branch:** feature/docs")
		);
		assert!(
			done
				.markdown
				.contains("[dir] samples\n      README.md (20 bytes)")
		);
		assert!(done.markdown.contains("## README\n\n# Guide"));
		assert_eq!(
			run(url, |request| {
				if request.url.ends_with("/repos/o/r") {
					Fetched::json(&json!({"full_name": "o/r"}))
				} else {
					Fetched::status(404)
				}
			}),
			None,
		);
	}

	#[test]
	fn a_merged_pull_keeps_paginated_issue_comments_when_the_last_page_fails() {
		let mut pages = 0;
		let done = run("https://github.com/o/r/pull/7", |request| match request.url.as_str() {
			"https://api.github.com/repos/o/r/pulls/7" => {
				assert!(
					request
						.headers
						.iter()
						.any(|(name, value)| name == "Authorization" && value == "Bearer token")
				);
				Fetched::json(&json!({
					"title": "Improve docs", "number": 7, "state": "closed", "merged": true,
					"user": null, "body": "Fix links", "comments": 101,
					"labels": [{"name": "documentation"}], "created_at": "2025-01-01", "updated_at": "2025-01-02"
				}))
			},
			"https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=1" => {
				pages += 1;
				Fetched::json(&json!(vec![
					json!({"user": null, "created_at": "2025-01-02", "body": "Looks good"});
					100
				]))
			},
			"https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=2" => {
				pages += 1;
				Fetched::status(503)
			},
			url => panic!("unexpected request: {url}"),
		})
		.unwrap();
		assert_eq!(pages, 2);
		assert_eq!(done.method, "github-pr");
		assert!(done.markdown.contains("**#7** · merged · opened by @ghost"));
		assert!(done.markdown.contains("Labels: documentation"));
		assert!(
			done
				.markdown
				.contains("## Comments (100 of 101)\n\n### @ghost · 2025-01-02\n\nLooks good")
		);
	}

	#[test]
	fn a_workflow_job_uses_its_run_and_embeds_cleaned_logs_and_elapsed_steps() {
		let done = run("https://github.com/o/r/actions/runs/46/jobs/5", |request| match request.url.as_str() {
			"https://api.github.com/repos/o/r/actions/jobs/5" => Fetched::json(&json!({
				"id": 5, "run_id": 47, "name": "build | test", "status": "completed", "conclusion": "failure",
				"started_at": "2025-01-02T09:01:04Z", "completed_at": "2025-01-02T09:03:05Z",
				"steps": [{
					"number": 1, "name": "Run | lint", "status": "completed", "conclusion": "failure",
					"started_at": "2025-01-02T09:01:08Z", "completed_at": "2025-01-02T09:02:09Z"
				}]
			})),
			"https://api.github.com/repos/o/r/actions/runs/47" => Fetched::json(&json!({
				"run_number": 3, "run_attempt": 2, "name": "CI", "status": "completed", "conclusion": "failure",
				"created_at": "2025-01-02T09:00:00Z", "updated_at": "2025-01-02T09:03:05Z"
			})),
			"https://api.github.com/repos/o/r/actions/jobs/5/logs" => {
				let mut reply = Fetched::text("text/plain", "\u{feff}2025-01-02T09:02:09.146Z lint failed\nuntimed\n");
				reply.truncated = true;
				reply
			},
			url => panic!("unexpected request: {url}"),
		})
		.unwrap();
		assert_eq!(done.method, "github-actions-job");
		assert!(
			done
				.markdown
				.contains("**Run:** #3 (attempt 2) · completed (failure)")
		);
		assert!(
			done
				.markdown
				.contains("**Job:** build \\| test · completed (failure) · 02:01")
		);
		assert!(
			done
				.markdown
				.contains("| 1 | Run \\| lint | completed | failure | 01:01 |")
		);
		assert!(done.markdown.ends_with("## Logs\n\nlint failed\nuntimed\n"));
		assert!(done.truncated);
	}
}
