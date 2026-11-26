//! MDN (`developer.mozilla.org/docs/...`): the documentation page rendered
//! from its `index.json`, whose prose, code, definition lists and tables
//! become Markdown.

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, html_to_markdown, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "mdn", open };

const METHOD: &str = "mdn";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("developer.mozilla.org") || !url.path().contains("/docs/") {
		return None;
	}
	let target = url.as_str();
	let index_url = if target.ends_with('/') {
		format!("{target}index.json")
	} else {
		format!("{target}/index.json")
	};
	fetch(Fetch::get(index_url).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let doc = data.get("doc")?;
		let title = str_of(doc, "title")?;

		let mut parts = vec![format!("# {title}")];
		if let Some(summary) = str_of(doc, "summary") {
			parts.push(html_to_markdown(summary, None).trim().to_owned());
		}
		let body = arr_of(doc, "body");
		if !body.is_empty() {
			parts.push(body_markdown(body));
		}

		Done::new(parts.join("\n\n"), METHOD).title(title).finish()
	})
}

fn body_markdown(sections: &[Value]) -> String {
	let mut parts: Vec<String> = Vec::new();
	for section in sections {
		let Some(kind) = str_of(section, "type") else {
			continue;
		};
		let value = section.get("value").unwrap_or(&Value::Null);
		match kind {
			"prose" => prose(value, &mut parts),
			"browser_compatibility" => {
				if let Some(title) = str_of(value, "title") {
					parts.push(format!("## {title}\n\n(See browser compatibility data at MDN)"));
				}
			},
			"specifications" => {
				if let Some(title) = str_of(value, "title") {
					parts.push(format!("## {title}\n\n(See specifications at MDN)"));
				}
			},
			"code_example" => {
				if let Some(title) = str_of(value, "title") {
					parts.push(format!("### {title}"));
				}
				if let Some(code) = str_of(value, "code") {
					let language = str_of(value, "language").unwrap_or_default();
					parts.push(format!("```{language}\n{code}\n```"));
				}
			},
			"definition_list" => {
				for item in arr_of(value, "items") {
					parts.push(format!("**{}**", str_of(item, "term").unwrap_or_default()));
					let description = str_of(item, "description").unwrap_or_default();
					parts.push(html_to_markdown(description, None).trim().to_owned());
				}
			},
			"table" => table(value, &mut parts),
			_ => {},
		}
	}
	parts.join("\n\n")
}

fn prose(value: &Value, parts: &mut Vec<String>) {
	let Some(content) = str_of(value, "content") else {
		return;
	};
	let markdown = html_to_markdown(content, None).trim().to_owned();
	match str_of(value, "title") {
		Some(title) => {
			let level = if value.get("isH3").and_then(Value::as_bool).unwrap_or(false) {
				"###"
			} else {
				"##"
			};
			parts.push(format!("{level} {title}\n\n{markdown}"));
		},
		None => parts.push(markdown),
	}
}

fn table(value: &Value, parts: &mut Vec<String>) {
	let rows = arr_of(value, "rows");
	let Some(header) = rows.first() else { return };
	let cells = |row: &Value| -> Vec<String> {
		row.as_array().map_or_else(Vec::new, |cells| {
			cells
				.iter()
				.map(|cell| {
					html_to_markdown(cell.as_str().unwrap_or_default(), None)
						.trim()
						.to_owned()
				})
				.collect()
		})
	};
	let header = cells(header);
	parts.push(format!("| {} |", header.join(" | ")));
	parts.push(format!("| {} |", vec!["---"; header.len()].join(" | ")));
	for row in &rows[1..] {
		parts.push(format!("| {} |", cells(row).join(" | ")));
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_docs_page_renders_its_sections() {
		let mut requests = Vec::new();
		let done = run(
			"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
			|request| {
				requests.push(request.url.clone());
				Fetched::json(&json!({ "doc": {
					"title": "Array.prototype.map()",
					"summary": "Creates a new array.",
					"mdn_url": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
					"body": [
						{ "type": "prose", "value": { "title": "Syntax", "content": "<p>map(callback)</p>" } },
						{ "type": "code_example", "value": { "title": "Example", "code": "[1,2].map(n => n * 2)", "language": "js" } },
						{ "type": "browser_compatibility", "value": { "title": "Browser compatibility" } },
						{ "type": "specifications", "value": { "title": "Specifications" } },
						{ "type": "definition_list", "value": { "items": [{ "term": "callback", "description": "A function" }] } },
						{ "type": "table", "value": { "rows": [["a", "b"], ["1", "2"]] } },
						{ "type": "unknown", "value": {} }
					]
				} }))
			},
		)
		.unwrap();
		assert_eq!(requests, [
			"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map/index.json"
		]);
		assert_eq!(done.method, "mdn");
		assert_eq!(done.title.as_deref(), Some("Array.prototype.map()"));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Array.prototype.map()\n\nCreates a new array.\n\n## Syntax\n\nmap(callback)\n\n### \
			 Example\n\n```js\n[1,2].map(n => n * 2)\n```"
		));
		assert!(md.contains("## Browser compatibility\n\n(See browser compatibility data at MDN)"));
		assert!(md.contains("## Specifications\n\n(See specifications at MDN)"));
		assert!(md.contains("**callback**\n\nA function"));
		assert!(md.contains("| a | b |\n\n| --- | --- |\n\n| 1 | 2 |"));
		assert!(done.notes.is_empty());
	}

	#[test]
	fn a_trailing_slash_and_a_missing_mdn_url_are_handled() {
		let done = run("https://developer.mozilla.org/en-US/docs/Web/CSS/color/", |_| {
			Fetched::json(&json!({ "doc": { "title": "color", "body": [] } }))
		})
		.unwrap();
		assert_eq!(done.markdown, "# color");
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://example.test/en-US/docs/x", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://developer.mozilla.org/en-US/", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://developer.mozilla.org/en-US/docs/Web/CSS/color", |_| Fetched::status(404)),
			None
		);
	}
}
