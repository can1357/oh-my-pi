//! MDN documentation renderer backed by MDN's per-page JSON endpoint.

use serde::Deserialize;
use url::Url;

use super::{
	super::types::{HttpClient, HttpRequest, RenderResult, WebError},
	utils::{build_result, html_to_basic_markdown},
};

/// Returns whether `url` is an MDN documentation page supported by this
/// scraper.
pub(super) fn matches(url: &Url) -> bool {
	url.host_str()
		.is_some_and(|host| host.contains("developer.mozilla.org"))
		&& url.path().contains("/docs/")
}

/// Renders an MDN documentation page through its sidebar-free JSON
/// representation.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	if !matches(url) {
		return Ok(None);
	}

	let base = url
		.as_str()
		.strip_suffix('/')
		.unwrap_or_else(|| url.as_str());
	let json_url = format!("{base}/index.json");
	let Ok(response) = client
		.get(HttpRequest::new(json_url).with_header("Accept", "application/json"))
		.await
	else {
		return Ok(None);
	};
	if !response.is_success() {
		return Ok(None);
	}

	Ok(render_response(&response.body).unwrap_or(None))
}

fn render_response(body: &[u8]) -> Result<Option<RenderResult>, WebError> {
	let data: MdnResponse = match serde_json::from_slice(body) {
		Ok(data) => data,
		Err(_) => return Ok(None),
	};
	Ok(render_document(&data)?.map(|content| build_result(&content, "mdn")))
}

fn render_document(data: &MdnResponse) -> Result<Option<String>, WebError> {
	if data.doc.title.is_empty() {
		return Ok(None);
	}

	let mut parts = vec![format!("# {}", data.doc.title)];
	if !data.doc.summary.is_empty() {
		parts.push(html_to_markdown(&data.doc.summary)?);
	}
	if !data.doc.body.is_empty() {
		parts.push(convert_body(&data.doc.body)?);
	}

	Ok(Some(parts.join("\n\n")))
}

fn convert_body(sections: &[Section]) -> Result<String, WebError> {
	let mut parts = Vec::new();
	for section in sections {
		let value = &section.value;
		match section.kind.as_str() {
			"prose" => {
				let Some(content) = value
					.content
					.as_deref()
					.filter(|content| !content.is_empty())
				else {
					continue;
				};
				let markdown = html_to_markdown(content)?;
				if let Some(title) = value.title.as_deref().filter(|title| !title.is_empty()) {
					let level = if value.is_h3 { "###" } else { "##" };
					parts.push(format!("{level} {title}\n\n{markdown}"));
				} else {
					parts.push(markdown);
				}
			},
			"browser_compatibility" => {
				if let Some(title) = value.title.as_deref().filter(|title| !title.is_empty()) {
					parts.push(format!("## {title}\n\n(See browser compatibility data at MDN)"));
				}
			},
			"specifications" => {
				if let Some(title) = value.title.as_deref().filter(|title| !title.is_empty()) {
					parts.push(format!("## {title}\n\n(See specifications at MDN)"));
				}
			},
			"code_example" => {
				if let Some(title) = value.title.as_deref().filter(|title| !title.is_empty()) {
					parts.push(format!("### {title}"));
				}
				if let Some(code) = value.code.as_deref().filter(|code| !code.is_empty()) {
					parts.push(format!(
						"```{}\n{}\n```",
						value.language.as_deref().unwrap_or_default(),
						code
					));
				}
			},
			"definition_list" => {
				for item in &value.items {
					parts.push(format!("**{}**", item.term));
					parts.push(html_to_markdown(&item.description)?);
				}
			},
			"table" if !value.rows.is_empty() => {
				let rows = value
					.rows
					.iter()
					.map(|row| {
						row.iter()
							.map(|cell| html_to_markdown(cell))
							.collect::<Result<Vec<_>, _>>()
					})
					.collect::<Result<Vec<_>, _>>()?;
				parts.push(format!("| {} |", rows[0].join(" | ")));
				parts.push(format!(
					"| {} |",
					rows[0]
						.iter()
						.map(|_| "---")
						.collect::<Vec<_>>()
						.join(" | ")
				));
				parts.extend(
					rows
						.iter()
						.skip(1)
						.map(|row| format!("| {} |", row.join(" | "))),
				);
			},
			_ => {},
		}
	}
	Ok(parts.join("\n\n"))
}

fn html_to_markdown(html: &str) -> Result<String, WebError> {
	html_to_basic_markdown(html).map(|markdown| markdown.to_string())
}

#[derive(Deserialize)]
struct MdnResponse {
	doc: Document,
}

#[derive(Deserialize)]
struct Document {
	title:   String,
	#[serde(default)]
	summary: String,
	#[allow(dead_code, reason = "MDN includes this required response field but rendering omits it")]
	#[serde(default)]
	mdn_url: String,
	#[serde(default)]
	body:    Vec<Section>,
}

#[derive(Deserialize)]
struct Section {
	#[serde(rename = "type")]
	kind:  String,
	value: SectionValue,
}

#[derive(Default, Deserialize)]
struct SectionValue {
	title:    Option<String>,
	content:  Option<String>,
	#[serde(default, rename = "isH3")]
	is_h3:    bool,
	code:     Option<String>,
	language: Option<String>,
	#[serde(default)]
	items:    Vec<DefinitionItem>,
	#[serde(default)]
	rows:     Vec<Vec<String>>,
}

#[derive(Deserialize)]
struct DefinitionItem {
	term:        String,
	description: String,
}

#[cfg(test)]
mod tests {
	use super::{MdnResponse, render_document, render_response};

	#[test]
	fn port_mdn_scraper_parity_representative_fixture() {
		let fixture = br#"{
			"doc": {
				"title": "Array.from()",
				"summary": "<p>Creates an array.</p>",
				"mdn_url": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/from",
				"body": [
					{"type":"prose","value":{"title":"Syntax","content":"<p>Use <code>Array.from()</code>.</p>"}},
					{"type":"definition_list","value":{"items":[{"term":"value","description":"<p>The input value.</p>"}]}},
					{"type":"table","value":{"rows":[["Name","Meaning"],["<code>mapFn</code>","Mapper"]]}},
					{"type":"code_example","value":{"title":"Example","language":"js","code":"Array.from([1, 2]);"}},
					{"type":"browser_compatibility","value":{"title":"Browser compatibility"}},
					{"type":"specifications","value":{"title":"Specifications"}}
				]
			}
		}"#;
		let rendered = render_response(fixture)
			.expect("fixture renders")
			.expect("fixture has a title");
		assert_eq!(rendered.method.as_str(), "mdn");
		assert!(rendered.diags.is_empty());
		assert_eq!(
			rendered.content.as_str(),
			"# Array.from()\n\nCreates an array.\n\n## Syntax\n\nUse \
			 `Array.from()`.\n\n**value**\n\nThe input value.\n\n| Name | Meaning |\n\n| --- | --- \
			 |\n\n| `mapFn` | Mapper |\n\n### Example\n\n```js\nArray.from([1, 2]);\n```\n\n## \
			 Browser compatibility\n\n(See browser compatibility data at MDN)\n\n## \
			 Specifications\n\n(See specifications at MDN)"
		);
	}

	#[test]
	fn port_mdn_scraper_parity_malformed_fixture_falls_back() {
		assert!(
			serde_json::from_slice::<MdnResponse>(br#"{"doc":{"summary":"missing title"}}"#).is_err()
		);
		assert!(
			render_response(br#"{"doc":{"summary":"missing title"}}"#)
				.expect("malformed input falls back")
				.is_none()
		);

		let empty_title: MdnResponse =
			serde_json::from_slice(br#"{"doc":{"title":"","summary":"","mdn_url":"","body":[]}}"#)
				.expect("shape is valid");
		assert_eq!(render_document(&empty_title).expect("rendering is infallible"), None);
	}
}
