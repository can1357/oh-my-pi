//! Hugging Face Hub repository cards and user profiles.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, str_of};

pub const SITE: Site = Site { name: "huggingface", open };

const ORIGIN: &str = "https://huggingface.co";
const METHOD: &str = "huggingface";

#[derive(Clone, Copy)]
enum Repo {
	Model { short: bool },
	Dataset,
	Space,
}

impl Repo {
	const fn route(self) -> (&'static str, &'static str, &'static str) {
		match self {
			Self::Model { .. } => ("models", "", "Model Card"),
			Self::Dataset => ("datasets", "datasets/", "Dataset Card"),
			Self::Space => ("spaces", "spaces/", "Space Info"),
		}
	}
}

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "huggingface.co" {
		return None;
	}
	let mut parts = url.path_segments()?.filter(|part| !part.is_empty());
	let first = parts.next()?;
	let second = parts.next();
	let third = parts.next();
	if parts.next().is_some() {
		return None;
	}
	let (kind, id) = match (first, second, third) {
		("datasets", Some(name), None) => (Repo::Dataset, name.to_owned()),
		("datasets", Some(owner), Some(name)) => (Repo::Dataset, format!("{owner}/{name}")),
		("spaces", Some(owner), Some(name)) => (Repo::Space, format!("{owner}/{name}")),
		(
			"datasets" | "spaces" | "docs" | "blog" | "pricing" | "enterprise" | "join" | "login"
			| "settings",
			..,
		) => {
			return None;
		},
		(owner, Some(name), None) => (Repo::Model { short: false }, format!("{owner}/{name}")),
		(name, None, None) => (Repo::Model { short: true }, name.to_owned()),
		_ => return None,
	};
	let (api, prefix, card_name) = kind.route();
	fetch(Fetch::get(format!("{ORIGIN}/api/{api}/{id}")).accept_json(), move |reply, _| {
		let data = reply.json_value();
		let summary = data.as_ref().and_then(|data| repo_summary(data, kind));
		match summary {
			Some((title, md)) => {
				let done = with_url(Done::new(md, METHOD).title(title), reply.url);
				fetch(
					Fetch::get(format!("{ORIGIN}/{prefix}{id}/raw/main/README.md")),
					move |readme, _| {
						let mut done = done;
						if let Some(text) = readme.body_text().filter(|text| !text.trim().is_empty()) {
							let _ = write!(done.markdown, "## {card_name}\n\n{text}");
							done.truncated = readme.truncated;
						}
						done.finish()
					},
				)
			},
			None if matches!(kind, Repo::Model { short: true }) => user(id),
			None => None,
		}
	})
}

fn with_url(mut done: Done, url: String) -> Done {
	if !url.is_empty() {
		done.url = Some(url);
	}
	done
}

fn repo_summary(data: &Value, kind: Repo) -> Option<(String, String)> {
	let title = str_of(
		data,
		if matches!(kind, Repo::Model { .. }) {
			"modelId"
		} else {
			"id"
		},
	)?;
	let mut md = format!("# {title}\n\n");
	match kind {
		Repo::Model { .. } => {
			field(&mut md, "Task", str_of(data, "pipeline_tag"));
			field(&mut md, "Library", str_of(data, "library_name"));
		},
		Repo::Dataset => paragraph(&mut md, str_of(data, "description")),
		Repo::Space => {
			paragraph(&mut md, str_of(data, "title"));
			field(&mut md, "Author", str_of(data, "author"));
			field(&mut md, "SDK", str_of(data, "sdk"));
		},
	}
	if !matches!(kind, Repo::Space) {
		count(&mut md, data, "downloads", "Downloads");
	}
	count(&mut md, data, "likes", "Likes");
	if !matches!(kind, Repo::Model { short: true }) {
		if data.get("private").and_then(Value::as_bool) == Some(true) {
			md.push_str("**Visibility:** Private\n");
		}
		if !matches!(kind, Repo::Space)
			&& (data.get("gated").and_then(Value::as_bool) == Some(true)
				|| str_of(data, "gated").is_some())
		{
			md.push_str("**Access:** Gated\n");
		}
		if let Some(card) = data.get("cardData") {
			field(&mut md, "License", str_of(card, "license"));
			if !matches!(kind, Repo::Space) {
				if let Some(language) = str_of(card, "language") {
					field(&mut md, "Language", Some(language));
				} else {
					list(&mut md, "Language", arr_of(card, "language").iter().filter_map(Value::as_str));
				}
			}
			for (key, label) in match kind {
				Repo::Model { .. } => &[("datasets", "Datasets"), ("metrics", "Metrics")][..],
				Repo::Dataset => &[("task_categories", "Tasks"), ("size_categories", "Size")],
				Repo::Space => &[],
			} {
				list(&mut md, label, arr_of(card, key).iter().filter_map(Value::as_str));
			}
			if matches!(kind, Repo::Space) {
				field(&mut md, "App File", str_of(card, "app_file"));
			}
		}
	}
	list(&mut md, "Tags", arr_of(data, "tags").iter().filter_map(Value::as_str));
	md.push('\n');
	Some((title.to_owned(), md))
}

fn user(id: String) -> Option<Action> {
	fetch(Fetch::get(format!("{ORIGIN}/api/users/{id}")).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		if !data.is_object() {
			return None;
		}
		let title = str_of(&data, "user").unwrap_or(&id);
		let mut md = format!("# {title}\n\n");
		field(&mut md, "Name", str_of(&data, "fullname"));
		for (key, label) in
			[("numModels", "Models"), ("numDatasets", "Datasets"), ("numSpaces", "Spaces")]
		{
			count(&mut md, &data, key, label);
		}
		list(
			&mut md,
			"Organizations",
			arr_of(&data, "orgs")
				.iter()
				.filter_map(|org| str_of(org, "name")),
		);
		with_url(Done::new(md, METHOD).title(title), reply.url).finish()
	})
}

fn paragraph(md: &mut String, value: Option<&str>) {
	if let Some(value) = value {
		let _ = write!(md, "{value}\n\n");
	}
}

fn field(md: &mut String, label: &str, value: Option<&str>) {
	if let Some(value) = value {
		let _ = writeln!(md, "**{label}:** {value}");
	}
}

fn count(md: &mut String, data: &Value, key: &str, label: &str) {
	if let Some(value) = f64_of(data, key) {
		let _ = writeln!(md, "**{label}:** {}", format_number(value));
	}
}

fn list<'a>(md: &mut String, label: &str, mut values: impl Iterator<Item = &'a str>) {
	if let Some(first) = values.next() {
		let _ = write!(md, "**{label}:** {first}");
		for other in values {
			let _ = write!(md, ", {other}");
		}
		md.push('\n');
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn each_repo_kind_reads_its_own_api_and_card() {
		for (path, api, data, metadata, heading) in [
			(
				"lab/model",
				"models/lab/model",
				json!({"modelId": "lab/model", "gated": "manual", "cardData": {"metrics": ["recall"]}}),
				"**Access:** Gated\n**Metrics:** recall",
				"Model Card",
			),
			(
				"datasets/sample",
				"datasets/sample",
				json!({"id": "sample", "description": "A sample dataset.", "cardData": {"language": ["en", "fr"], "task_categories": ["text-classification"]}}),
				"**Language:** en, fr\n**Tasks:** text-classification",
				"Dataset Card",
			),
			(
				"spaces/lab/demo",
				"spaces/lab/demo",
				json!({"id": "lab/demo", "sdk": "gradio", "cardData": {"app_file": "app.py"}}),
				"**SDK:** gradio\n**App File:** app.py",
				"Space Info",
			),
		] {
			let endpoint = format!("https://huggingface.co/api/{api}");
			let readme = format!("https://huggingface.co/{path}/raw/main/README.md");
			let done = run(&format!("https://huggingface.co/{path}"), |request| {
				if request.url == endpoint {
					Fetched::json(&data)
				} else {
					assert_eq!(request.url, readme);
					Fetched::text("text/plain", "Usage instructions.")
				}
			})
			.unwrap();
			assert_eq!(done.method, "huggingface");
			assert_eq!(done.url.as_deref(), Some(endpoint.as_str()));
			assert!(done.markdown.contains(metadata));
			assert!(
				done
					.markdown
					.contains(&format!("## {heading}\n\nUsage instructions."))
			);
		}
	}

	#[test]
	fn a_single_segment_tries_a_model_before_a_user() {
		for model_exists in [true, false] {
			let mut requests = Vec::new();
			let done = run("https://huggingface.co/alice", |request| {
				requests.push(request.url.clone());
				if request.url.ends_with("/api/models/alice") {
					if model_exists {
						Fetched::json(
							&json!({"modelId": "alice", "pipeline_tag": "translation", "likes": 1200}),
						)
					} else {
						Fetched::status(404)
					}
				} else if request.url.ends_with("/api/users/alice") {
					Fetched::json(&json!({"fullname": "Alice Doe", "orgs": [{"name": "lab"}]}))
				} else {
					Fetched::status(404)
				}
			})
			.unwrap();
			let (second, body) = if model_exists {
				("/alice/raw/main/README.md", "**Task:** translation\n**Likes:** 1.2K")
			} else {
				("/api/users/alice", "**Name:** Alice Doe\n**Organizations:** lab")
			};
			assert_eq!(requests, [
				"https://huggingface.co/api/models/alice".to_owned(),
				format!("https://huggingface.co{second}")
			]);
			assert!(done.markdown.starts_with("# alice\n\n"));
			assert!(done.markdown.contains(body));
		}
	}

	#[test]
	fn files_reserved_paths_and_failed_lookups_fall_through() {
		for path in
			["docs/transformers", "lab/model/blob/main/config.json", "datasets/lab/sample/discussions"]
		{
			assert_eq!(
				run(&format!("https://huggingface.co/{path}"), |_| panic!("no fetch expected")),
				None
			);
		}
		assert_eq!(run("https://huggingface.co/missing", |_| Fetched::status(404)), None);
	}
}
