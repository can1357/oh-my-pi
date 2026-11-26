//! Terraform Registry modules, provider overviews and individual provider docs.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, iso_date, segment,
	str_of,
};

pub const SITE: Site = Site { name: "terraform", open };

const REGISTRY: &str = "https://registry.terraform.io";
const METHOD: &str = "terraform";
const NOTE: &str = "Fetched via Terraform Registry API";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("registry.terraform.io") {
		return None;
	}
	let mut parts = url.path().strip_prefix('/')?.split_terminator('/');
	let kind = parts.next()?;
	let namespace = nonempty(parts.next()?)?;
	let name = nonempty(parts.next()?)?;
	match kind {
		"modules" => {
			let provider = nonempty(parts.next()?)?;
			let api = format!("{REGISTRY}/v1/modules/{namespace}/{name}/{provider}");
			fetch(Fetch::get(api).accept_json(), |reply, _| render_module(&reply.json_value()?))
		},
		"providers" => {
			let version = match parts.next() {
				Some("latest") | None => None,
				Some(version) => Some(nonempty(version)?),
			};
			let doc = match parts.next() {
				None => None,
				Some("docs") => match parts.next() {
					None => None,
					Some(category) => {
						let slug = nonempty(parts.next()?)?;
						if parts.next().is_some() {
							return None;
						}
						Some((nonempty(category)?.to_owned(), slug.to_owned()))
					},
				},
				Some(_) => return None,
			};
			let mut api = format!("{REGISTRY}/v1/providers/{namespace}/{name}");
			if let Some(version) = version {
				let _ = write!(api, "/{version}");
			}
			let request = Fetch::get(api).accept_json();
			if let Some((category, slug)) = doc {
				fetch(request, move |reply, _| provider_doc(&reply.json_value()?, &category, &slug))
			} else {
				let docs_base = format!(
					"{REGISTRY}/providers/{namespace}/{name}/{}/docs",
					version.unwrap_or("latest")
				);
				fetch(request, move |reply, _| render_provider(&reply.json_value()?, &docs_base))
			}
		},
		_ => None,
	}
}

fn nonempty(text: &str) -> Option<&str> {
	(!text.is_empty()).then_some(text)
}

fn preamble(title: &str, record: &Value) -> String {
	let mut md = format!("# {title}\n\n");
	if let Some(description) = str_of(record, "description") {
		let _ = write!(md, "{description}\n\n");
	}
	md
}

fn write_metadata(md: &mut String, record: &Value) {
	let _ = writeln!(
		md,
		"**Downloads:** {}",
		format_number(f64_of(record, "downloads").unwrap_or_default())
	);
	if let Some(published) = str_of(record, "published_at").and_then(iso_date) {
		let _ = writeln!(md, "**Published:** {published}");
	}
	if let Some(source) = str_of(record, "source") {
		let _ = writeln!(md, "**Source:** {source}");
	}
	md.push('\n');
}

fn elision(md: &mut String, count: usize, limit: usize, kind: &str) {
	if count > limit {
		let _ = writeln!(md, "\n[…{} {kind} elided…]", count - limit);
	}
}

fn write_excerpt(md: &mut String, text: &str, max_chars: usize, table: bool) {
	let mut remaining = max_chars;
	for ch in text.chars() {
		if remaining == 0 {
			break;
		}
		if table && ch == '|' {
			md.push('\\');
			remaining -= 1;
		}
		if remaining < ch.len_utf16() {
			break;
		}
		md.push(if ch == '\n' { ' ' } else { ch });
		remaining -= ch.len_utf16();
	}
}

fn render_module(module: &Value) -> Option<Action> {
	let namespace = str_of(module, "namespace")?;
	let name = str_of(module, "name")?;
	let provider = str_of(module, "provider")?;
	let version = str_of(module, "version")?;
	let title = format!("{namespace}/{name}/{provider}");
	let mut md = preamble(&title, module);
	let verified = if module["verified"].as_bool() == Some(true) {
		" ✓ Verified"
	} else {
		""
	};
	let _ = writeln!(md, "**Version:** {version}{verified}");
	write_metadata(&mut md, module);
	let _ = write!(
		md,
		"## Usage\n\n```hcl\nmodule \"{name}\" {{\n  source  = \"{title}\"\n  version = \
		 \"{version}\"\n}}\n```\n\n"
	);

	let root = &module["root"];
	let inputs = arr_of(root, "inputs");
	if !inputs.is_empty() {
		let _ = write!(
			md,
			"## Inputs ({})\n\n| Name | Type | Required | Description \
			 |\n|------|------|----------|-------------|\n",
			inputs.len()
		);
		for input in inputs.iter().take(30) {
			let name = str_of(input, "name")?;
			let kind = input["type"].as_str().unwrap_or("any");
			let required = input["required"]
				.as_bool()
				.unwrap_or_else(|| input.get("default").is_none());
			let _ = write!(md, "| {name} | `{kind}` | {} | ", if required { "Yes" } else { "No" });
			write_excerpt(&mut md, input["description"].as_str().unwrap_or_default(), 80, true);
			md.push_str(" |\n");
		}
		elision(&mut md, inputs.len(), 30, "inputs");
		md.push('\n');
	}
	let outputs = arr_of(root, "outputs");
	if !outputs.is_empty() {
		let _ = write!(md, "## Outputs ({})\n\n", outputs.len());
		for output in outputs.iter().take(20) {
			let _ = write!(md, "- **{}**", str_of(output, "name")?);
			if let Some(description) = str_of(output, "description") {
				md.push_str(": ");
				write_excerpt(&mut md, description, 100, false);
			}
			md.push('\n');
		}
		elision(&mut md, outputs.len(), 20, "outputs");
		md.push('\n');
	}
	let deps = arr_of(root, "dependencies");
	if !deps.is_empty() {
		let _ = write!(md, "## Dependencies ({})\n\n", deps.len());
		for dep in deps.iter().take(15) {
			let _ = write!(md, "- **{}**: {}", str_of(dep, "name")?, str_of(dep, "source")?);
			if let Some(version) = str_of(dep, "version") {
				let _ = write!(md, " ({version})");
			}
			md.push('\n');
		}
		elision(&mut md, deps.len(), 15, "dependencies");
		md.push('\n');
	}
	let resources = arr_of(root, "resources");
	if !resources.is_empty() {
		let _ = write!(md, "## Resources ({})\n\n", resources.len());
		for res in resources.iter().take(20) {
			let _ = writeln!(md, "- `{}` ({})", str_of(res, "type")?, str_of(res, "name")?);
		}
		elision(&mut md, resources.len(), 20, "resources");
		md.push('\n');
	}
	let submodules = arr_of(module, "submodules");
	if !submodules.is_empty() {
		let _ = write!(md, "## Submodules ({})\n\n", submodules.len());
		for sub in submodules.iter().take(10) {
			let _ = writeln!(md, "- **{}**: `{}`", str_of(sub, "name")?, str_of(sub, "path")?);
		}
		elision(&mut md, submodules.len(), 10, "submodules");
	}
	Done::new(md, METHOD).title(title).note(NOTE).finish()
}

fn render_provider(provider: &Value, docs_base: &str) -> Option<Action> {
	let namespace = str_of(provider, "namespace")?;
	let name = str_of(provider, "name")?;
	let version = str_of(provider, "version")?;
	let title = format!("{namespace}/{name}");
	let mut md = preamble(&title, provider);
	let _ = writeln!(md, "**Version:** {version}");
	if let Some(tier) = str_of(provider, "tier") {
		let _ = writeln!(md, "**Tier:** {tier}");
	}
	write_metadata(&mut md, provider);
	let _ = write!(
		md,
		"## Usage\n\n```hcl\nterraform {{\n  required_providers {{\n    {name} = {{\n      source  \
		 = \"{title}\"\n      version = \"~> {version}\"\n    }}\n  }}\n}}\n\nprovider \"{name}\" \
		 {{\n  # Configuration options\n}}\n```\n\n"
	);

	let docs = arr_of(provider, "docs");
	if !docs.is_empty() {
		struct Category<'a> {
			name:    &'a str,
			count:   usize,
			preview: Vec<&'a Value>,
		}
		let mut categories: Vec<Category<'_>> = Vec::new();
		for doc in docs {
			let name = str_of(doc, "category").unwrap_or("other");
			if let Some(category) = categories.iter_mut().find(|entry| entry.name == name) {
				category.count += 1;
				if category.preview.len() < 15 {
					category.preview.push(doc);
				}
			} else {
				categories.push(Category { name, count: 1, preview: vec![doc] });
			}
		}

		md.push_str("## Documentation\n\n");
		for category in categories {
			let mut chars = category.name.chars();
			let capital = chars.next()?.to_uppercase();
			let _ = write!(md, "### {capital}{} ({})\n\n", chars.as_str(), category.count);
			for doc in category.preview {
				let _ = writeln!(
					md,
					"- [{}]({docs_base}/{}/{})",
					str_of(doc, "title")?,
					doc["category"].as_str().unwrap_or_default(),
					str_of(doc, "slug")?,
				);
			}
			elision(&mut md, category.count, 15, "documents");
			md.push('\n');
		}
	}
	Done::new(md, METHOD).title(title).note(NOTE).finish()
}

fn provider_doc(provider: &Value, category: &str, slug: &str) -> Option<Action> {
	let doc = arr_of(provider, "docs").iter().find(|doc| {
		doc["category"].as_str() == Some(category) && doc["slug"].as_str() == Some(slug)
	})?;
	let id = match &doc["id"] {
		Value::String(id) => segment(nonempty(id)?),
		Value::Number(id) => id.to_string(),
		_ => return None,
	};
	let note = format!(
		"Fetched {}/{} {} docs via Terraform Registry API",
		str_of(provider, "namespace")?,
		str_of(provider, "name")?,
		str_of(provider, "version")?,
	);
	fetch(Fetch::get(format!("{REGISTRY}/v2/provider-docs/{id}")).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let content = nonempty(data["data"]["attributes"]["content"].as_str()?)?;
		Done::new(content.to_owned(), METHOD).note(note).finish()
	})
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn module_subpaths_render_usage_and_escape_the_inputs_table() {
		let done =
			run("https://registry.terraform.io/modules/acme/net/aws/3.0/submodules/foo", |request| {
				assert_eq!(request.url, "https://registry.terraform.io/v1/modules/acme/net/aws");
				Fetched::json(&json!({
					"namespace": "acme", "name": "net", "provider": "aws", "version": "3.0",
					"downloads": 1250, "verified": true, "root": {
						"inputs": [{"name": "region", "type": "string", "description": "one|two\nwords"},
							{"name": "name", "default": null}],
						"outputs": [{"name": "id", "description": "Network\nID"}],
						"dependencies": [{"name": "sub", "source": "acme/sub/aws", "version": "1.0"}],
						"resources": [{"name": "vpc", "type": "aws_vpc"}]
					}, "submodules": [{"name": "foo", "path": "modules/foo"}]
				}))
			})
			.unwrap();
		assert_eq!(done.method, "terraform");
		assert!(
			done
				.markdown
				.contains("source  = \"acme/net/aws\"\n  version = \"3.0\"")
		);
		assert!(
			done
				.markdown
				.contains("| region | `string` | Yes | one\\|two words |\n| name | `any` | No |  |")
		);
		assert!(
			done.markdown.contains("- **id**: Network ID")
				&& done.markdown.contains("- `aws_vpc` (vpc)")
		);
		assert!(
			done.markdown.contains("- **sub**: acme/sub/aws (1.0)")
				&& done.markdown.contains("- **foo**: `modules/foo`")
		);
	}

	#[test]
	fn provider_overview_links_docs_at_the_requested_version() {
		for (path, version) in [("", None), ("/latest/docs/", None), ("/4.0/docs", Some("4.0"))] {
			let done =
				run(&format!("https://registry.terraform.io/providers/acme/net{path}"), |request| {
					let suffix = if version.is_some() { "/4.0" } else { "" };
					assert_eq!(
						request.url,
						format!("https://registry.terraform.io/v1/providers/acme/net{suffix}")
					);
					Fetched::json(&json!({
						"namespace": "acme", "name": "net", "version": "4.0", "docs": [
							{"category": "resources", "title": "Network", "slug": "network"},
							{"category": "guides", "title": "Example", "slug": "example"}
						]
					}))
				})
				.unwrap();
			assert!(done.markdown.contains("required_providers"));
			assert!(done.markdown.contains(&format!(
				"### Resources (1)\n\n- [Network](https://registry.terraform.io/providers/acme/net/{}/docs/resources/network)",
				version.unwrap_or("latest"),
			)));
		}
	}

	#[test]
	fn a_provider_doc_requires_a_matching_index_entry_and_a_successful_content_fetch() {
		let url = "https://registry.terraform.io/providers/acme/net/4.0/docs/data-sources/network/";
		for status in [200, 404] {
			let done = run(url, |request| match request.url.as_str() {
				"https://registry.terraform.io/v1/providers/acme/net/4.0" => Fetched::json(&json!({
					"namespace": "acme", "name": "net", "version": "4.0", "docs": [
						{"id": 1, "category": "resources", "slug": "network"},
						{"id": 2, "category": "data-sources", "slug": "network"}
					]
				})),
				"https://registry.terraform.io/v2/provider-docs/2" if status == 200 => Fetched::json(
					&json!({"data": {"attributes": {"content": "# Network data source\n\nFind a network."}}}),
				),
				"https://registry.terraform.io/v2/provider-docs/2" => Fetched::status(status),
				url => panic!("unexpected fetch: {url}"),
			});
			if status == 200 {
				let done = done.unwrap();
				assert_eq!(done.markdown, "# Network data source\n\nFind a network.");
				assert_eq!(done.notes, ["Fetched acme/net 4.0 docs via Terraform Registry API"]);
			} else {
				assert_eq!(done, None);
			}
		}
		assert_eq!(
			run("https://registry.terraform.io/providers/acme/net/latest/docs/guides", |_| panic!(
				"no fetch expected"
			)),
			None
		);
	}
}
