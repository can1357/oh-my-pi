//! Issues, pull requests, and the web lists' search filters.

use std::fmt::Write as _;

use url::{Url, form_urlencoded};

use super::{Action, Context, Repo, Value, api, api_done, arr_of, fetch, login, str_of, u64_of};

pub(super) fn read(context: &Context, repo: Repo<'_>, number: u64, pull: bool) -> Option<Action> {
	let endpoint = repo.endpoint();
	let (section, method) = if pull {
		("pulls", "github-pr")
	} else {
		("issues", "github-issue")
	};
	fetch(api(context, format_args!("{endpoint}/{section}/{number}")), move |reply, context| {
		let issue = reply.json_value()?;
		let number = u64_of(&issue, "number")?;
		let title = str_of(&issue, "title")?;
		let state = if pull && issue["merged"] == true {
			"merged"
		} else {
			str_of(&issue, "state")?
		};
		let created = str_of(&issue, "created_at").unwrap_or_default();
		let updated = str_of(&issue, "updated_at").unwrap_or_default();
		let mut md = format!(
			"# {title}\n\n**#{number}** · {state} · opened by @{}\nCreated: {created} · Updated: \
			 {updated}\n",
			login(&issue),
		);
		write_labels(&mut md, &issue, "Labels: ", "\n");
		let body = issue["body"]
			.as_str()
			.filter(|s| !s.is_empty())
			.unwrap_or("*No description provided.*");
		let _ = write!(md, "\n---\n\n{body}\n\n---\n\n");
		let expected = u64_of(&issue, "comments").unwrap_or(0);
		if expected == 0 {
			return api_done(md, method).finish();
		}
		let heading_at = md.len();
		Comments { md, heading_at, endpoint, number, method, expected, rendered: 0, page: 1 }
			.read(context)
	})
}

struct Comments {
	md:         String,
	heading_at: usize,
	endpoint:   String,
	number:     u64,
	method:     &'static str,
	expected:   u64,
	rendered:   u64,
	page:       u64,
}

impl Comments {
	fn read(mut self, context: &Context) -> Option<Action> {
		const PER_PAGE: usize = 100;
		let request = api(
			context,
			format_args!(
				"{}/issues/{}/comments?per_page={PER_PAGE}&page={}",
				self.endpoint, self.number, self.page
			),
		);
		fetch(request, move |reply, context| {
			let comments = reply.json_value();
			let comments = comments
				.as_ref()
				.and_then(Value::as_array)
				.map_or(&[][..], Vec::as_slice);
			for comment in comments {
				let _ = write!(
					self.md,
					"### @{} · {}\n\n{}\n\n---\n\n",
					login(comment),
					str_of(comment, "created_at").unwrap_or_default(),
					comment["body"].as_str().unwrap_or_default(),
				);
			}
			self.rendered += comments.len() as u64;
			if comments.len() >= PER_PAGE && self.rendered < self.expected {
				self.page += 1;
				return self.read(context);
			}
			if self.rendered != 0 {
				let heading = if self.rendered < self.expected {
					format!("## Comments ({} of {})\n\n", self.rendered, self.expected)
				} else {
					format!("## Comments ({})\n\n", self.rendered)
				};
				self.md.insert_str(self.heading_at, &heading);
			}
			api_done(self.md, self.method).finish()
		})
	}
}

fn write_labels(md: &mut String, data: &Value, prefix: &str, suffix: &str) {
	let mut labels = arr_of(data, "labels")
		.iter()
		.filter_map(|label| str_of(label, "name"));
	if let Some(first) = labels.next() {
		md.push_str(prefix);
		md.push_str(first);
		for label in labels {
			md.push_str(", ");
			md.push_str(label);
		}
		md.push_str(suffix);
	}
}

pub(super) fn list(context: &Context, repo: Repo<'_>, url: &Url, pull: bool) -> Option<Action> {
	let mut raw = None;
	let mut page = None;
	for (key, value) in url.query_pairs() {
		match key.as_ref() {
			"q" if raw.is_none() => raw = Some(value),
			"page" if page.is_none() => page = Some(value),
			_ => {},
		}
		if raw.is_some() && page.is_some() {
			break;
		}
	}
	let raw = raw
		.as_deref()
		.map(str::trim)
		.filter(|q| !q.is_empty())
		.unwrap_or("is:open");
	let page = page.as_deref().and_then(page_number).unwrap_or(1);
	let (query, sort) = search(&repo, raw, pull);
	let mut params = form_urlencoded::Serializer::new(String::new());
	params
		.append_pair("q", &query)
		.append_pair("per_page", "30")
		.append_pair("page", &page.to_string());
	if let Some((field, order)) = sort {
		params
			.append_pair("sort", &field.to_ascii_lowercase())
			.append_pair("order", order);
	}
	let name = if pull { "Pull requests" } else { "Issues" };
	let mut md = format!("# {}/{} - {name}: {query}\n\n", repo.owner, repo.name);
	fetch(api(context, format_args!("/search/issues?{}", params.finish())), move |reply, _| {
		let data = reply.json_value()?;
		let items = data["items"].as_array()?;
		if let Some(total) = data["total_count"].as_u64() {
			let plural = if total == 1 { "" } else { "s" };
			let _ = write!(md, "{total} result{plural}; page {page}\n\n");
		}
		for item in items {
			let number = u64_of(item, "number")?;
			let title = str_of(item, "title")?;
			let state = str_of(item, "state")?;
			let _ = write!(md, "- **#{number}** ({state}) {title}");
			write_labels(&mut md, item, " [", "]");
			let _ = write!(
				md,
				"\n  by @{} · {} comments · {}\n\n",
				login(item),
				u64_of(item, "comments").unwrap_or(0),
				str_of(item, "created_at").unwrap_or_default(),
			);
		}
		api_done(md, "github-issues").finish()
	})
}

fn page_number(raw: &str) -> Option<u64> {
	let raw = raw.trim_start();
	let raw = raw.strip_prefix('+').unwrap_or(raw);
	let count = raw.bytes().take_while(u8::is_ascii_digit).count();
	raw[..count].parse::<u64>().ok().filter(|page| *page > 0)
}

fn search<'a>(
	repo: &Repo<'_>,
	raw: &'a str,
	pull: bool,
) -> (String, Option<(&'a str, &'static str)>) {
	let mut sort = None;
	let mut filtered = String::new();
	let mut offset = 0;
	let mut consumed = 0;
	for part in raw.split_inclusive(char::is_whitespace) {
		let word = part.trim_end();
		if let Some(qualifier) = sort_qualifier(word) {
			sort = Some(qualifier);
			filtered.push_str(&raw[consumed..offset]);
			consumed = offset + word.len();
		}
		offset += part.len();
	}
	let filter = if sort.is_some() {
		filtered.push_str(&raw[consumed..]);
		filtered.trim()
	} else {
		raw
	};
	let mut has_repo = false;
	let mut has_kind = false;
	for word in filter.split_whitespace() {
		has_repo |= strip_prefix(word, "repo:").is_some();
		has_kind |= strip_prefix(word, "is:").is_some_and(|kind| {
			["issue", "pr", "pull-request"]
				.iter()
				.any(|qualifier| kind.eq_ignore_ascii_case(qualifier))
		});
	}
	let mut query = String::new();
	if !has_repo {
		let _ = write!(query, "repo:{}/{} ", repo.owner, repo.name);
	}
	if !has_kind {
		query.push_str(if pull { "is:pr" } else { "is:issue" });
		if !filter.is_empty() {
			query.push(' ');
		}
	}
	query.push_str(filter);
	(query, sort)
}

fn strip_prefix<'a>(word: &'a str, prefix: &str) -> Option<&'a str> {
	let (head, tail) = word.split_at_checked(prefix.len())?;
	head.eq_ignore_ascii_case(prefix).then_some(tail)
}

fn sort_qualifier(word: &str) -> Option<(&str, &'static str)> {
	let (field, order) = strip_prefix(word, "sort:")?.rsplit_once('-')?;
	if field.is_empty()
		|| !field
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-'))
	{
		return None;
	}
	let order = if order.eq_ignore_ascii_case("asc") {
		"asc"
	} else if order.eq_ignore_ascii_case("desc") {
		"desc"
	} else {
		return None;
	};
	Some((field, order))
}
