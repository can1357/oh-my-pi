//! GitHub's commit endpoint includes the message, statistics, and per-file
//! diff.

use std::fmt::Write as _;

use super::{Action, Context, Repo, api, api_done, arr_of, fetch, str_of, u64_of};

pub(super) fn read(context: &Context, repo: Repo<'_>, reference: &str) -> Option<Action> {
	let request =
		api(context, format_args!("/repos/{}/{}/commits/{reference}", repo.owner, repo.name));
	fetch(request, |reply, _| {
		let data = reply.json_value()?;
		let sha = str_of(&data, "sha")?;
		let commit = data.get("commit")?.as_object()?;
		let message = commit
			.get("message")
			.and_then(|v| v.as_str())
			.unwrap_or_default();
		let (subject, body) = message.split_once('\n').unwrap_or((message, ""));
		let subject = if subject.is_empty() {
			short(sha, 7)
		} else {
			subject
		};
		let mut md = format!("# {subject}\n\n**{}** · authored by ", short(sha, 12));
		let author = commit.get("author");
		if let Some(login) = str_of(&data["author"], "login") {
			let _ = write!(md, "@{login}");
		} else {
			md.push_str(
				author
					.and_then(|author| str_of(author, "name"))
					.unwrap_or("unknown"),
			);
		}
		if let Some(date) = author.and_then(|author| str_of(author, "date")) {
			let _ = write!(md, " · {date}");
		}
		md.push('\n');
		let files = arr_of(&data, "files");
		if let Some(stats) = data.get("stats").filter(|stats| stats.is_object()) {
			let plural = if files.len() == 1 { "" } else { "s" };
			let _ = writeln!(
				md,
				"{} file{plural} changed · +{} −{}",
				files.len(),
				u64_of(stats, "additions").unwrap_or(0),
				u64_of(stats, "deletions").unwrap_or(0),
			);
		}
		let mut parents = arr_of(&data, "parents")
			.iter()
			.filter_map(|v| str_of(v, "sha"));
		if let Some(first) = parents.next() {
			let _ = write!(md, "Parents: {}", short(first, 12));
			for parent in parents {
				let _ = write!(md, ", {}", short(parent, 12));
			}
			md.push('\n');
		}
		let body = body.trim();
		if !body.is_empty() {
			let _ = write!(md, "\n{body}\n");
		}
		if !files.is_empty() {
			let _ = write!(md, "\n---\n\n## Files ({})\n\n", files.len());
			for file in files {
				md.push_str("### ");
				if let Some(previous) = str_of(file, "previous_filename") {
					let _ = write!(md, "{previous} → ");
				}
				let _ = write!(
					md,
					"{}\n\n{} · +{} −{}\n\n",
					str_of(file, "filename")?,
					str_of(file, "status")?,
					u64_of(file, "additions").unwrap_or(0),
					u64_of(file, "deletions").unwrap_or(0),
				);
				if let Some(patch) = file["patch"].as_str().filter(|s| !s.is_empty()) {
					let _ = write!(md, "```diff\n{patch}\n```\n\n");
				} else {
					md.push_str("*No textual diff (binary or too large).*\n\n");
				}
			}
		}
		api_done(md, "github-commit").finish()
	})
}

/// GitHub prefixes are ASCII hexadecimal; the fallback avoids splitting an
/// unexpected multibyte API value.
pub(super) fn short(sha: &str, len: usize) -> &str {
	sha.get(..len).unwrap_or(sha)
}
