//! Open Library (`openlibrary.org`): work, edition and ISBN lookups from the
//! Open Library JSON API. Works and editions also fetch up to five author
//! records for their names; an ISBN falls back from the books API to the
//! search API when the books API has no entry for the key.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Fetched, Next, Site, arr_of, fetch, segment, str_of, strs_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "openlibrary", open };

const METHOD: &str = "openlibrary";
/// Author records fetched for one work or edition.
const MAX_AUTHORS: usize = 5;
/// Subjects listed.
const MAX_SUBJECTS: usize = 20;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("openlibrary.org") {
		return None;
	}
	let path = url.path();
	if let Some(work) = identifier(path, "/works/", 'W') {
		return work_record(work);
	}
	if let Some(edition) = identifier(path, "/books/", 'M') {
		return edition_record(edition);
	}
	if let Some(isbn) = isbn_of(path) {
		return by_isbn(isbn);
	}
	None
}

/// `OL<digits><tail>` after `prefix`, matched case-insensitively like the TS
/// regex.
fn identifier(path: &str, prefix: &str, tail: char) -> Option<String> {
	if !path.get(..prefix.len())?.eq_ignore_ascii_case(prefix) {
		return None;
	}
	let rest = &path[prefix.len()..];
	let bytes = rest.as_bytes();
	if bytes.len() < 3 || !rest.get(..2)?.eq_ignore_ascii_case("OL") {
		return None;
	}
	let mut end = 2;
	while bytes.get(end).is_some_and(u8::is_ascii_digit) {
		end += 1;
	}
	if end == 2
		|| !bytes
			.get(end)
			.is_some_and(|byte| byte.eq_ignore_ascii_case(&(tail as u8)))
	{
		return None;
	}
	Some(rest.get(..=end)?.to_owned())
}

/// 10- or 13-digit ISBN after `/isbn/`.
fn isbn_of(path: &str) -> Option<String> {
	if !path.get(..6)?.eq_ignore_ascii_case("/isbn/") {
		return None;
	}
	let digits: String = path[6..].chars().take_while(char::is_ascii_digit).collect();
	matches!(digits.len(), 10 | 13).then_some(digits)
}

fn work_record(work_id: String) -> Option<Action> {
	fetch(
		Fetch::get(format!("https://openlibrary.org/works/{work_id}.json")).accept_json(),
		move |reply, _| {
			let work = reply.json_value()?;
			let mut keys: Vec<String> = arr_of(&work, "authors")
				.iter()
				.filter_map(|entry| entry.get("author")?.get("key")?.as_str().map(str::to_owned))
				.collect();
			keys.truncate(MAX_AUTHORS);
			author_names(keys, Vec::new(), move |names| {
				let title = str_of(&work, "title").unwrap_or_default();
				let mut md = format!("# {title}\n\n");
				if !names.is_empty() {
					let _ = writeln!(md, "**Authors:** {}", names.join(", "));
				}
				if let Some(date) = str_of(&work, "first_publish_date") {
					let _ = writeln!(md, "**First Published:** {date}");
				}
				if let Some(cover) = arr_of(&work, "covers").first().and_then(Value::as_i64) {
					let _ = writeln!(md, "**Cover:** https://covers.openlibrary.org/b/id/{cover}-L.jpg");
				}
				let _ = writeln!(md, "**Open Library:** https://openlibrary.org/works/{work_id}");
				md.push('\n');
				if let Some(description) = description(&work) {
					let _ = write!(md, "## Description\n\n{description}\n\n");
				}
				if let Some(subjects) = listed(&work, "subjects") {
					let _ = write!(md, "## Subjects\n\n{subjects}\n");
				}
				Done::new(md, METHOD)
					.title(title)
					.note("Fetched via Open Library API")
					.finish()
			})
		},
	)
}

fn edition_record(edition_id: String) -> Option<Action> {
	fetch(
		Fetch::get(format!("https://openlibrary.org/books/{edition_id}.json")).accept_json(),
		move |reply, _| {
			let edition = reply.json_value()?;
			let mut keys: Vec<String> = arr_of(&edition, "authors")
				.iter()
				.filter_map(|entry| entry.get("key")?.as_str().map(str::to_owned))
				.collect();
			keys.truncate(MAX_AUTHORS);
			author_names(keys, Vec::new(), move |names| {
				let title = str_of(&edition, "title").unwrap_or_default();
				let mut md = format!("# {title}\n\n");
				if !names.is_empty() {
					let _ = writeln!(md, "**Authors:** {}", names.join(", "));
				}
				let publishers = strs_of(&edition, "publishers");
				if !publishers.is_empty() {
					let _ = writeln!(md, "**Publishers:** {}", publishers.join(", "));
				}
				if let Some(date) = str_of(&edition, "publish_date") {
					let _ = writeln!(md, "**Published:** {date}");
				}
				if let Some(pages) =
					super::u64_of(&edition, "number_of_pages").filter(|pages| *pages > 0)
				{
					let _ = writeln!(md, "**Pages:** {pages}");
				}
				let isbns: Vec<&str> = strs_of(&edition, "isbn_13")
					.into_iter()
					.chain(strs_of(&edition, "isbn_10"))
					.collect();
				if let Some(isbn) = isbns.first() {
					let _ = writeln!(md, "**ISBN:** {isbn}");
				}
				if let Some(cover) = arr_of(&edition, "covers").first().and_then(Value::as_i64) {
					let _ = writeln!(md, "**Cover:** https://covers.openlibrary.org/b/id/{cover}-L.jpg");
				}
				let _ = writeln!(md, "**Open Library:** https://openlibrary.org/books/{edition_id}");
				if let Some(work) = arr_of(&edition, "works")
					.first()
					.and_then(|entry| str_of(entry, "key"))
				{
					let _ = writeln!(
						md,
						"**Work:** https://openlibrary.org/works/{}",
						work.replace("/works/", "")
					);
				}
				md.push('\n');
				if let Some(description) = description(&edition) {
					let _ = write!(md, "## Description\n\n{description}\n\n");
				}
				if let Some(subjects) = listed(&edition, "subjects") {
					let _ = write!(md, "## Subjects\n\n{subjects}\n");
				}
				Done::new(md, METHOD)
					.title(title)
					.note("Fetched via Open Library API")
					.finish()
			})
		},
	)
}

fn by_isbn(isbn: String) -> Option<Action> {
	let api =
		format!("https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data");
	fetch_retry(
		Fetch::get(api).accept_json(),
		Box::new(move |reply: Fetched, _: &Context| {
			let data = reply.json_value()?;
			let bibkey = format!("ISBN:{isbn}");
			if let Some(book) = data.get(&bibkey) {
				return book_page(&isbn, book).finish();
			}
			// Fall back to the search endpoint, which still returns a doc when
			// `api/books` misses the key.
			let search =
				format!("https://openlibrary.org/search.json?isbn={}&limit=1", segment(&isbn));
			fetch(Fetch::get(search).accept_json(), move |reply, _| {
				let data = reply.json_value()?;
				let doc = arr_of(&data, "docs").first()?;
				let title = str_of(doc, "title")?;
				let mut md = format!("# {title}\n\n");
				let authors = strs_of(doc, "author_name");
				if !authors.is_empty() {
					let _ = writeln!(md, "**Authors:** {}", authors.join(", "));
				}
				if let Some(year) = super::u64_of(doc, "first_publish_year").filter(|year| *year > 0) {
					let _ = writeln!(md, "**First Published:** {year}");
				}
				let _ = writeln!(md, "**ISBN:** {isbn}");
				if let Some(key) = str_of(doc, "key") {
					let _ = writeln!(md, "**Open Library:** https://openlibrary.org{key}");
				}
				Done::new(md, METHOD)
					.title(title)
					.note("Fetched via Open Library API")
					.finish()
			})
		}),
	)
}

/// Markdown of an `api/books` entry keyed by ISBN.
fn book_page(isbn: &str, book: &Value) -> Done {
	let title = str_of(book, "title").unwrap_or_default();
	let mut md = format!("# {title}\n\n");
	let authors = named(book, "authors");
	if !authors.is_empty() {
		let _ = writeln!(md, "**Authors:** {}", authors.join(", "));
	}
	let publishers = named(book, "publishers");
	if !publishers.is_empty() {
		let _ = writeln!(md, "**Publishers:** {}", publishers.join(", "));
	}
	if let Some(date) = str_of(book, "publish_date") {
		let _ = writeln!(md, "**Published:** {date}");
	}
	if let Some(pages) = super::u64_of(book, "number_of_pages").filter(|pages| *pages > 0) {
		let _ = writeln!(md, "**Pages:** {pages}");
	}
	let _ = writeln!(md, "**ISBN:** {isbn}");
	if let Some(cover) = book
		.get("cover")
		.and_then(|cover| str_of(cover, "large").or_else(|| str_of(cover, "medium")))
	{
		let _ = writeln!(md, "**Cover:** {cover}");
	}
	if let Some(url) = str_of(book, "url") {
		let _ = writeln!(md, "**Open Library:** {url}");
	}
	md.push('\n');
	let subjects = arr_of(book, "subjects");
	if !subjects.is_empty() {
		let names: Vec<&str> = subjects
			.iter()
			.take(MAX_SUBJECTS)
			.filter_map(|entry| str_of(entry, "name"))
			.collect();
		let _ = write!(md, "## Subjects\n\n{}\n", names.join(", "));
	}
	Done::new(md, METHOD)
		.title(title)
		.note("Fetched via Open Library API")
}

/// `description` as a plain string, whether the API returned one or a
/// `{value}`.
fn description(value: &Value) -> Option<String> {
	let text = match value.get("description")? {
		Value::String(text) => text.clone(),
		other => other.get("value")?.as_str()?.to_owned(),
	};
	(!text.is_empty()).then_some(text)
}

/// Comma-joined first `MAX_SUBJECTS` strings of the array at `key`.
fn listed(value: &Value, key: &str) -> Option<String> {
	let names = strs_of(value, key);
	if names.is_empty() {
		return None;
	}
	Some(
		names
			.iter()
			.take(MAX_SUBJECTS)
			.copied()
			.collect::<Vec<_>>()
			.join(", "),
	)
}

/// Non-empty `name` fields of the array of objects at `key`.
fn named<'a>(value: &'a Value, key: &str) -> Vec<&'a str> {
	arr_of(value, key)
		.iter()
		.filter_map(|entry| str_of(entry, "name"))
		.collect()
}

/// Fetch author names one request at a time, then hand the ordered names to
/// `done`.
fn author_names(
	keys: Vec<String>,
	names: Vec<String>,
	done: impl FnOnce(Vec<String>) -> Option<Action> + Send + 'static,
) -> Option<Action> {
	let Some((key, rest)) = keys.split_first() else {
		return done(names);
	};
	let key = author_key(key);
	let rest = rest.to_vec();
	fetch(Fetch::get(format!("https://openlibrary.org{key}.json")).accept_json(), move |reply, _| {
		let mut names = names;
		if let Some(name) = reply
			.json_value()
			.as_ref()
			.and_then(|value| str_of(value, "name"))
		{
			names.push(name.to_owned());
		}
		author_names(rest, names, done)
	})
}

/// `/authors/<key>` path for an author key, with or without its prefix.
fn author_key(key: &str) -> String {
	if key.starts_with("/authors/") {
		key.to_owned()
	} else {
		format!("/authors/{key}")
	}
}

/// One retry on a non-2xx reply, then hand the last reply to `next`.
fn fetch_retry(request: Fetch, next: Next) -> Option<Action> {
	fetch(request.clone(), move |reply, context| {
		if reply.ok() {
			return next(reply, context);
		}
		fetch(request, move |reply, context| next(reply, context))
	})
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_work_page_reads_the_api_and_its_authors() {
		let mut requests = Vec::new();
		let done = run("https://www.openlibrary.org/works/OL45804W", |request| {
			requests.push(request.url.clone());
			assert!(request.headers.iter().any(|(name, value)| name == "Accept" && value == "application/json"));
			if request.url.starts_with("https://openlibrary.org/works/") {
				Fetched::json(&json!({
					"title": "The Lord of the Rings",
					"authors": [{ "author": { "key": "/authors/OL1A" } }, { "author": { "key": "/authors/OL2A" } }],
					"first_publish_date": "1954",
					"covers": [-1],
					"description": { "value": "An epic." },
					"subjects": ["Fantasy", "Adventure"]
				}))
			} else {
				let name = if request.url.ends_with("/authors/OL1A.json") { "J. R. R. Tolkien" } else { "Christopher Tolkien" };
				Fetched::json(&json!({ "name": name }))
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://openlibrary.org/works/OL45804W.json",
			"https://openlibrary.org/authors/OL1A.json",
			"https://openlibrary.org/authors/OL2A.json"
		]);
		assert_eq!(done.method, "openlibrary");
		assert_eq!(done.title.as_deref(), Some("The Lord of the Rings"));
		assert_eq!(done.notes, ["Fetched via Open Library API"]);
		assert!(done.markdown.starts_with(
			"# The Lord of the Rings\n\n**Authors:** J. R. R. Tolkien, Christopher Tolkien\n**First Published:** 1954\n\
			 **Cover:** https://covers.openlibrary.org/b/id/-1-L.jpg\n\
			 **Open Library:** https://openlibrary.org/works/OL45804W\n\n## Description\n\nAn epic.\n\n## Subjects\n\nFantasy, Adventure\n"
		));
	}

	#[test]
	fn an_edition_page_links_back_to_its_work() {
		let done = run("https://openlibrary.org/books/OL7353617M", |request| {
			if request.url.starts_with("https://openlibrary.org/books/") {
				Fetched::json(&json!({
					"title": "Fantastic Mr Fox",
					"publishers": ["Puffin"],
					"publish_date": "2007",
					"number_of_pages": 96,
					"isbn_13": ["9780140328721"],
					"isbn_10": ["0140328726"],
					"works": [{ "key": "/works/OL45804W" }]
				}))
			} else {
				panic!("no author fetch expected: {}", request.url)
			}
		})
		.unwrap();
		assert!(done.markdown.starts_with(
			"# Fantastic Mr Fox\n\n**Publishers:** Puffin\n**Published:** 2007\n**Pages:** 96\n**ISBN:** 9780140328721\n\
			 **Open Library:** https://openlibrary.org/books/OL7353617M\n\
			 **Work:** https://openlibrary.org/works/OL45804W\n\n"
		));
	}

	#[test]
	fn an_isbn_falls_back_to_search_when_the_books_api_misses() {
		let mut requests = Vec::new();
		let done = run("https://openlibrary.org/isbn/9780140328721", |request| {
			requests.push(request.url.clone());
			if request.url.starts_with("https://openlibrary.org/api/books") {
				Fetched::json(&json!({}))
			} else {
				Fetched::json(&json!({
					"docs": [{ "title": "Fantastic Mr Fox", "author_name": ["Roald Dahl"], "first_publish_year": 1970, "key": "/works/OL1W" }]
				}))
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://openlibrary.org/api/books?bibkeys=ISBN:9780140328721&format=json&jscmd=data",
			"https://openlibrary.org/search.json?isbn=9780140328721&limit=1"
		]);
		assert_eq!(
			done.markdown,
			"# Fantastic Mr Fox\n\n**Authors:** Roald Dahl\n**First Published:** 1970\n**ISBN:** 9780140328721\n\
			 **Open Library:** https://openlibrary.org/works/OL1W\n"
		);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://openlibrary.org/subjects/fantasy", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://openlibrary.org/works/OL45804W", |_| Fetched::status(500)), None);
		assert_eq!(run("https://openlibrary.org/isbn/12345", |_| panic!("no fetch expected")), None);
	}
}
