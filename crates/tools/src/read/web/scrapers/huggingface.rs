//! Anonymous Hugging Face repository renderer.

use omp_core::Str;
use serde::Deserialize;
use url::Url;

use crate::read::web::types::{HttpClient, HttpRequest, HttpResponse, RenderResult, WebError};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kind {
	Model,
	Dataset,
	Space,
	ModelOrUser,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Target {
	kind: Kind,
	id:   String,
}

/// Returns whether `url` names a Hugging Face model, dataset, space, or
/// profile.
pub(super) fn matches(url: &Url) -> bool {
	parse(url).is_some()
}

/// Renders Hugging Face metadata and its repository card through anonymous
/// APIs.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = parse(url) else {
		return Ok(None);
	};

	let rendered = match target.kind {
		Kind::Model => render_model(client, &target.id, false).await,
		Kind::Dataset => render_dataset(client, &target.id).await,
		Kind::Space => render_space(client, &target.id).await,
		Kind::ModelOrUser => render_model_or_user(client, &target.id).await,
	};

	// Transport failures produce no site-specific result; all other failures
	// also decline so the ordinary web reader can handle the request.
	// A site-specific outage must therefore fall through to the ordinary web
	// reader rather than turn the read into a tool error.
	Ok(rendered.unwrap_or(None))
}

async fn render_model<C: HttpClient + Sync>(
	client: &C,
	id: &str,
	abbreviated: bool,
) -> Result<Option<RenderResult>, WebError> {
	let api_url = format!("https://huggingface.co/api/models/{id}");
	let card_url = format!("https://huggingface.co/{id}/raw/main/README.md");
	let (api_response, card_response) =
		tokio::join!(biased; get(client, api_url), get(client, card_url));
	let Some(api_response) = api_response? else {
		return Ok(None);
	};
	let Some(model) = decode::<Model>(&api_response) else {
		return Ok(None);
	};

	let card_response = card_response.ok().flatten();
	Ok(Some(render_model_result(model, card_response.as_ref(), abbreviated)))
}

fn render_model_result(
	model: Model,
	card_response: Option<&HttpResponse>,
	abbreviated: bool,
) -> RenderResult {
	let mut markdown = format!("# {}\n\n", model.id);
	if let Some(task) = model.pipeline_tag.filter(|value| !value.is_empty()) {
		push_field(&mut markdown, "Task", &task);
	}
	if let Some(library) = model.library_name.filter(|value| !value.is_empty()) {
		push_field(&mut markdown, "Library", &library);
	}
	if let Some(downloads) = model.downloads {
		push_field(&mut markdown, "Downloads", &format_number(downloads));
	}
	if let Some(likes) = model.likes {
		push_field(&mut markdown, "Likes", &format_number(likes));
	}

	if !abbreviated {
		if model.private == Some(true) {
			push_field(&mut markdown, "Visibility", "Private");
		}
		if model.gated.as_ref().is_some_and(json_truthy) {
			push_field(&mut markdown, "Access", "Gated");
		}
		if let Some(card) = model.card_data {
			if let Some(license) = card.license.filter(|value| !value.is_empty()) {
				push_field(&mut markdown, "License", &license);
			}
			if let Some(language) = card.language.and_then(OneOrMany::render_truthy) {
				push_field(&mut markdown, "Language", &language);
			}
			if !card.datasets.is_empty() {
				push_field(&mut markdown, "Datasets", &card.datasets.join(", "));
			}
			if !card.metrics.is_empty() {
				push_field(&mut markdown, "Metrics", &card.metrics.join(", "));
			}
		}
	}

	if !model.tags.is_empty() {
		push_field(&mut markdown, "Tags", &model.tags.join(", "));
	}
	markdown.push('\n');

	if let Some(card_response) = card_response {
		append_card(&mut markdown, "Model Card", card_response);
	}

	RenderResult::markdown(&markdown, "huggingface")
}

async fn render_dataset<C: HttpClient + Sync>(
	client: &C,
	id: &str,
) -> Result<Option<RenderResult>, WebError> {
	let api_url = format!("https://huggingface.co/api/datasets/{id}");
	let card_url = format!("https://huggingface.co/datasets/{id}/raw/main/README.md");
	let (api_response, card_response) =
		tokio::join!(biased; get(client, api_url), get(client, card_url));
	let Some(api_response) = api_response? else {
		return Ok(None);
	};
	let Some(dataset) = decode::<Dataset>(&api_response) else {
		return Ok(None);
	};

	let mut markdown = format!("# {}\n\n", dataset.id);
	if let Some(description) = dataset.description.filter(|value| !value.is_empty()) {
		markdown.push_str(&description);
		markdown.push_str("\n\n");
	}
	if let Some(downloads) = dataset.downloads {
		push_field(&mut markdown, "Downloads", &format_number(downloads));
	}
	if let Some(likes) = dataset.likes {
		push_field(&mut markdown, "Likes", &format_number(likes));
	}
	if dataset.private == Some(true) {
		push_field(&mut markdown, "Visibility", "Private");
	}
	if dataset.gated.as_ref().is_some_and(json_truthy) {
		push_field(&mut markdown, "Access", "Gated");
	}
	if let Some(card) = dataset.card_data {
		if let Some(license) = card.license.filter(|value| !value.is_empty()) {
			push_field(&mut markdown, "License", &license);
		}
		if let Some(language) = card.language.and_then(OneOrMany::render_truthy) {
			push_field(&mut markdown, "Language", &language);
		}
		if !card.task_categories.is_empty() {
			push_field(&mut markdown, "Tasks", &card.task_categories.join(", "));
		}
		if !card.size_categories.is_empty() {
			push_field(&mut markdown, "Size", &card.size_categories.join(", "));
		}
	}
	if !dataset.tags.is_empty() {
		push_field(&mut markdown, "Tags", &dataset.tags.join(", "));
	}
	markdown.push('\n');

	if let Ok(Some(card_response)) = card_response {
		append_card(&mut markdown, "Dataset Card", &card_response);
	}

	Ok(Some(RenderResult::markdown(&markdown, "huggingface")))
}

async fn render_space<C: HttpClient + Sync>(
	client: &C,
	id: &str,
) -> Result<Option<RenderResult>, WebError> {
	let api_url = format!("https://huggingface.co/api/spaces/{id}");
	let card_url = format!("https://huggingface.co/spaces/{id}/raw/main/README.md");
	let (api_response, card_response) =
		tokio::join!(biased; get(client, api_url), get(client, card_url));
	let Some(api_response) = api_response? else {
		return Ok(None);
	};
	let Some(space) = decode::<Space>(&api_response) else {
		return Ok(None);
	};

	let mut markdown = format!("# {}\n\n", space.id);
	if let Some(title) = space.title.filter(|value| !value.is_empty()) {
		markdown.push_str(&title);
		markdown.push_str("\n\n");
	}
	if let Some(author) = space.author.filter(|value| !value.is_empty()) {
		push_field(&mut markdown, "Author", &author);
	}
	if let Some(sdk) = space.sdk.filter(|value| !value.is_empty()) {
		push_field(&mut markdown, "SDK", &sdk);
	}
	if let Some(likes) = space.likes {
		push_field(&mut markdown, "Likes", &format_number(likes));
	}
	if space.private == Some(true) {
		push_field(&mut markdown, "Visibility", "Private");
	}
	if let Some(card) = space.card_data {
		if let Some(license) = card.license.filter(|value| !value.is_empty()) {
			push_field(&mut markdown, "License", &license);
		}
		if let Some(app_file) = card.app_file.filter(|value| !value.is_empty()) {
			push_field(&mut markdown, "App File", &app_file);
		}
	}
	if !space.tags.is_empty() {
		push_field(&mut markdown, "Tags", &space.tags.join(", "));
	}
	markdown.push('\n');

	if let Ok(Some(card_response)) = card_response {
		append_card(&mut markdown, "Space Info", &card_response);
	}

	Ok(Some(RenderResult::markdown(&markdown, "huggingface")))
}

async fn render_model_or_user<C: HttpClient + Sync>(
	client: &C,
	id: &str,
) -> Result<Option<RenderResult>, WebError> {
	let model_url = format!("https://huggingface.co/api/models/{id}");
	if let Ok(Some(response)) = get(client, model_url).await
		&& let Some(model) = decode::<Model>(&response)
	{
		let card_url = format!("https://huggingface.co/{id}/raw/main/README.md");
		let card_response = get(client, card_url).await.ok().flatten();
		return Ok(Some(render_model_result(model, card_response.as_ref(), true)));
	}

	let user_url = format!("https://huggingface.co/api/users/{id}");
	let Some(response) = get(client, user_url).await? else {
		return Ok(None);
	};
	let Some(user) = decode::<User>(&response) else {
		return Ok(None);
	};

	let display_user = user
		.username
		.as_deref()
		.filter(|value| !value.is_empty())
		.unwrap_or(id);
	let mut markdown = format!("# {display_user}\n\n");
	if let Some(name) = user.name.filter(|value| !value.is_empty()) {
		push_field(&mut markdown, "Name", &name);
	}
	if let Some(models) = user.models {
		push_field(&mut markdown, "Models", &format_number(models));
	}
	if let Some(datasets) = user.datasets {
		push_field(&mut markdown, "Datasets", &format_number(datasets));
	}
	if let Some(spaces) = user.spaces {
		push_field(&mut markdown, "Spaces", &format_number(spaces));
	}
	if !user.orgs.is_empty() {
		let organizations = user
			.orgs
			.iter()
			.map(|organization| organization.name.as_str())
			.collect::<Vec<_>>()
			.join(", ");
		push_field(&mut markdown, "Organizations", &organizations);
	}

	Ok(Some(RenderResult::markdown(&markdown, "huggingface")))
}

async fn get<C: HttpClient + Sync>(
	client: &C,
	url: String,
) -> Result<Option<HttpResponse>, WebError> {
	let response = client.get(HttpRequest::new(url)).await?;
	Ok(response.is_success().then_some(response))
}

fn decode<T: for<'de> Deserialize<'de>>(response: &HttpResponse) -> Option<T> {
	serde_json::from_slice(&response.body).ok()
}

fn append_card(markdown: &mut String, heading: &str, response: &HttpResponse) {
	if !response.is_success() {
		return;
	}
	let card: Str = response.text();
	if card.trim().is_empty() {
		return;
	}
	markdown.push_str("## ");
	markdown.push_str(heading);
	markdown.push_str("\n\n");
	markdown.push_str(&card);
}

fn push_field(markdown: &mut String, name: &str, value: &str) {
	markdown.push_str("**");
	markdown.push_str(name);
	markdown.push_str(":** ");
	markdown.push_str(value);
	markdown.push('\n');
}

fn json_truthy(value: &serde_json::Value) -> bool {
	match value {
		serde_json::Value::Null => false,
		serde_json::Value::Bool(value) => *value,
		serde_json::Value::String(value) => !value.is_empty(),
		serde_json::Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
		serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
	}
}

fn format_number(value: u64) -> String {
	if value < 1_000 {
		value.to_string()
	} else if value < 10_000 {
		decimal_suffix(value, 1_000, "K")
	} else if value < 1_000_000 {
		rounded_suffix(value, 1_000, "K")
	} else if value < 10_000_000 {
		decimal_suffix(value, 1_000_000, "M")
	} else if value < 1_000_000_000 {
		rounded_suffix(value, 1_000_000, "M")
	} else if value < 10_000_000_000 {
		decimal_suffix(value, 1_000_000_000, "B")
	} else {
		rounded_suffix(value, 1_000_000_000, "B")
	}
}

fn decimal_suffix(value: u64, divisor: u64, suffix: &str) -> String {
	let unit = divisor / 10;
	let tenths = value.saturating_add(unit / 2) / unit;
	if tenths.is_multiple_of(10) {
		format!("{}{suffix}", tenths / 10)
	} else {
		format!("{}.{}{suffix}", tenths / 10, tenths % 10)
	}
}

fn rounded_suffix(value: u64, divisor: u64, suffix: &str) -> String {
	format!("{}{suffix}", value.saturating_add(divisor / 2) / divisor)
}

fn parse(url: &Url) -> Option<Target> {
	if url.host_str()? != "huggingface.co" {
		return None;
	}

	let parts = url
		.path_segments()?
		.filter(|part| !part.is_empty())
		.collect::<Vec<_>>();
	let first = *parts.first()?;

	if first == "datasets" && parts.len() >= 2 {
		return Some(Target { kind: Kind::Dataset, id: parts[1..].join("/") });
	}
	if first == "spaces" && parts.len() >= 3 {
		return Some(Target { kind: Kind::Space, id: format!("{}/{}", parts[1], parts[2]) });
	}
	if matches!(first, "docs" | "blog" | "pricing" | "enterprise" | "join" | "login" | "settings") {
		return None;
	}
	if parts.len() >= 2 {
		return Some(Target { kind: Kind::Model, id: format!("{}/{}", parts[0], parts[1]) });
	}
	Some(Target { kind: Kind::ModelOrUser, id: first.to_owned() })
}

#[derive(Deserialize)]
struct Model {
	#[serde(rename = "modelId")]
	id:           String,
	pipeline_tag: Option<String>,
	library_name: Option<String>,
	#[serde(default)]
	tags:         Vec<String>,
	downloads:    Option<u64>,
	likes:        Option<u64>,
	private:      Option<bool>,
	gated:        Option<serde_json::Value>,
	#[serde(rename = "cardData")]
	card_data:    Option<ModelCard>,
}

#[derive(Deserialize)]
struct ModelCard {
	license:  Option<String>,
	language: Option<OneOrMany>,
	#[serde(default)]
	datasets: Vec<String>,
	#[serde(default)]
	metrics:  Vec<String>,
}

#[derive(Deserialize)]
struct Dataset {
	id:          String,
	#[serde(default)]
	tags:        Vec<String>,
	downloads:   Option<u64>,
	likes:       Option<u64>,
	private:     Option<bool>,
	gated:       Option<serde_json::Value>,
	#[serde(rename = "cardData")]
	card_data:   Option<DatasetCard>,
	description: Option<String>,
}

#[derive(Deserialize)]
struct DatasetCard {
	license:         Option<String>,
	language:        Option<OneOrMany>,
	#[serde(default)]
	task_categories: Vec<String>,
	#[serde(default)]
	size_categories: Vec<String>,
}

#[derive(Deserialize)]
struct Space {
	id:        String,
	author:    Option<String>,
	title:     Option<String>,
	sdk:       Option<String>,
	#[serde(default)]
	tags:      Vec<String>,
	likes:     Option<u64>,
	private:   Option<bool>,
	#[serde(rename = "cardData")]
	card_data: Option<SpaceCard>,
}

#[derive(Deserialize)]
struct SpaceCard {
	license:  Option<String>,
	app_file: Option<String>,
}

#[derive(Deserialize)]
struct User {
	#[serde(rename = "fullname")]
	name:     Option<String>,
	#[serde(rename = "user")]
	username: Option<String>,
	#[serde(default)]
	orgs:     Vec<Organization>,
	#[serde(rename = "numModels")]
	models:   Option<u64>,
	#[serde(rename = "numDatasets")]
	datasets: Option<u64>,
	#[serde(rename = "numSpaces")]
	spaces:   Option<u64>,
}

#[derive(Deserialize)]
struct Organization {
	name: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany {
	One(String),
	Many(Vec<String>),
}

impl OneOrMany {
	fn render_truthy(self) -> Option<String> {
		match self {
			Self::One(value) if value.is_empty() => None,
			Self::One(value) => Some(value),
			Self::Many(values) => Some(values.join(", ")),
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		future::{Future, ready},
	};

	use bytes::Bytes;
	use parking_lot::Mutex;
	use smallvec::SmallVec;

	use super::*;

	struct FakeClient {
		responses: HashMap<String, Result<HttpResponse, WebError>>,
		requests:  Mutex<Vec<HttpRequest>>,
	}

	impl FakeClient {
		fn with(
			responses: impl IntoIterator<Item = (&'static str, Result<HttpResponse, WebError>)>,
		) -> Self {
			Self {
				responses: responses
					.into_iter()
					.map(|(url, response)| (url.to_owned(), response))
					.collect(),
				requests:  Mutex::new(Vec::new()),
			}
		}

		fn requested_urls(&self) -> Vec<String> {
			self
				.requests
				.lock()
				.iter()
				.map(|request| request.url.to_string())
				.collect()
		}
	}

	impl HttpClient for FakeClient {
		fn get(
			&self,
			request: HttpRequest,
		) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
			let response = self
				.responses
				.get(request.url.as_str())
				.cloned()
				.unwrap_or_else(|| Err(WebError::request("unmapped test URL")));
			self.requests.lock().push(request);
			ready(response)
		}
	}

	fn response(url: &'static str, status: u16, body: &'static str) -> HttpResponse {
		HttpResponse {
			final_url: url.into(),
			status,
			content_type: Some("application/json".into()),
			headers: SmallVec::new(),
			body: Bytes::from_static(body.as_bytes()),
		}
	}

	#[test]
	fn matches_pi_resource_and_nested_url_shapes() {
		for (input, kind, id) in [
			("https://huggingface.co/acme/model", Kind::Model, "acme/model"),
			(
				"https://huggingface.co/acme/model/blob/feature%2Fcards/docs/card.md?download=true#L2",
				Kind::Model,
				"acme/model",
			),
			("https://huggingface.co/datasets/squad", Kind::Dataset, "squad"),
			(
				"https://huggingface.co/datasets/acme/corpus/blob/v2/data/train.jsonl",
				Kind::Dataset,
				"acme/corpus/blob/v2/data/train.jsonl",
			),
			("https://huggingface.co/spaces/acme/demo", Kind::Space, "acme/demo"),
			("https://huggingface.co/spaces/acme/demo/blob/dev/app.py", Kind::Space, "acme/demo"),
			("https://huggingface.co/bert-base-uncased", Kind::ModelOrUser, "bert-base-uncased"),
		] {
			let url = Url::parse(input).unwrap();
			assert!(matches(&url), "{input}");
			assert_eq!(parse(&url), Some(Target { kind, id: id.to_owned() }), "{input}");
		}

		for input in [
			"https://example.com/acme/model",
			"https://huggingface.co/",
			"https://huggingface.co/docs/transformers",
			"https://huggingface.co/blog",
			"https://huggingface.co/settings/profile",
		] {
			assert!(!matches(&Url::parse(input).unwrap()), "{input}");
		}
	}

	#[test]
	fn optional_strings_follow_pi_javascript_truthiness() {
		let empty_string = render_model_result(
			Model {
				id:           "model".to_owned(),
				pipeline_tag: Some(String::new()),
				library_name: Some(String::new()),
				tags:         Vec::new(),
				downloads:    None,
				likes:        None,
				private:      None,
				gated:        None,
				card_data:    Some(ModelCard {
					license:  Some(String::new()),
					language: Some(OneOrMany::One(String::new())),
					datasets: Vec::new(),
					metrics:  Vec::new(),
				}),
			},
			None,
			false,
		);
		assert_eq!(empty_string.content.as_str(), "# model");

		let empty_array = render_model_result(
			Model {
				id:           "model".to_owned(),
				pipeline_tag: None,
				library_name: None,
				tags:         Vec::new(),
				downloads:    None,
				likes:        None,
				private:      None,
				gated:        None,
				card_data:    Some(ModelCard {
					license:  None,
					language: Some(OneOrMany::Many(Vec::new())),
					datasets: Vec::new(),
					metrics:  Vec::new(),
				}),
			},
			None,
			false,
		);
		assert_eq!(empty_array.content.as_str(), "# model\n\n**Language:**");
	}

	#[tokio::test]
	async fn model_file_page_uses_pi_model_endpoints_and_full_metadata() {
		const API: &str = "https://huggingface.co/api/models/acme/model";
		const README: &str = "https://huggingface.co/acme/model/raw/main/README.md";
		let client = FakeClient::with([
			(
				API,
				Ok(response(
					API,
					200,
					r#"{"modelId":"acme/model","pipeline_tag":"text-generation","library_name":"transformers","tags":["featured","safetensors"],"downloads":1500,"likes":25,"private":true,"gated":"auto","cardData":{"license":"apache-2.0","language":["en","fr"],"datasets":["acme/data"],"metrics":["accuracy"]}}"#,
				)),
			),
			(README, Ok(response(README, 200, "# Card\n\nModel details."))),
		]);
		let url =
			Url::parse("https://huggingface.co/acme/model/blob/release%2F2/src/config.json").unwrap();

		let rendered = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(client.requested_urls(), vec![API.to_owned(), README.to_owned()],);
		assert!(
			client
				.requests
				.lock()
				.iter()
				.all(|request| request.max_bytes == crate::read::web::types::MAX_BYTES)
		);
		assert_eq!(rendered.method.as_str(), "huggingface");
		assert_eq!(rendered.content_type.as_deref(), Some("text/markdown"));
		assert!(rendered.diags.is_empty());
		assert_eq!(
			rendered.content.as_str(),
			"# acme/model\n\n**Task:** text-generation\n**Library:** transformers\n**Downloads:** \
			 1.5K\n**Likes:** 25\n**Visibility:** Private\n**Access:** Gated\n**License:** \
			 apache-2.0\n**Language:** en, fr\n**Datasets:** acme/data\n**Metrics:** \
			 accuracy\n**Tags:** featured, safetensors\n\n## Model Card\n\n# Card\n\nModel details."
		);
	}

	#[tokio::test]
	async fn dataset_and_space_render_pi_card_fields() {
		const DATASET_API: &str = "https://huggingface.co/api/datasets/acme/corpus";
		const DATASET_README: &str = "https://huggingface.co/datasets/acme/corpus/raw/main/README.md";
		let dataset_client = FakeClient::with([
			(
				DATASET_API,
				Ok(response(
					DATASET_API,
					200,
					r#"{"id":"acme/corpus","description":"A corpus.","downloads":25000,"likes":4,"gated":true,"tags":["text"],"cardData":{"license":"mit","language":"en","task_categories":["text-classification"],"size_categories":["1K<n<10K"]}}"#,
				)),
			),
			(DATASET_README, Ok(response(DATASET_README, 200, "Dataset readme."))),
		]);
		let dataset = render(
			&dataset_client,
			&Url::parse("https://huggingface.co/datasets/acme/corpus").unwrap(),
		)
		.await
		.unwrap()
		.unwrap();
		assert_eq!(
			dataset.content.as_str(),
			"# acme/corpus\n\nA corpus.\n\n**Downloads:** 25K\n**Likes:** 4\n**Access:** \
			 Gated\n**License:** mit\n**Language:** en\n**Tasks:** text-classification\n**Size:** \
			 1K<n<10K\n**Tags:** text\n\n## Dataset Card\n\nDataset readme."
		);

		const SPACE_API: &str = "https://huggingface.co/api/spaces/acme/demo";
		const SPACE_README: &str = "https://huggingface.co/spaces/acme/demo/raw/main/README.md";
		let space_client = FakeClient::with([
			(
				SPACE_API,
				Ok(response(
					SPACE_API,
					200,
					r#"{"id":"acme/demo","author":"acme","title":"Demo App","sdk":"gradio","likes":1200,"private":true,"tags":["gradio"],"cardData":{"license":"apache-2.0","app_file":"app.py"}}"#,
				)),
			),
			(SPACE_README, Ok(response(SPACE_README, 200, "Space readme."))),
		]);
		let space = render(
			&space_client,
			&Url::parse("https://huggingface.co/spaces/acme/demo/tree/revision").unwrap(),
		)
		.await
		.unwrap()
		.unwrap();
		assert_eq!(
			space.content.as_str(),
			"# acme/demo\n\nDemo App\n\n**Author:** acme\n**SDK:** gradio\n**Likes:** \
			 1.2K\n**Visibility:** Private\n**License:** apache-2.0\n**App File:** app.py\n**Tags:** \
			 gradio\n\n## Space Info\n\nSpace readme."
		);
	}

	#[tokio::test]
	async fn single_segment_model_is_abbreviated_like_pi() {
		const API: &str = "https://huggingface.co/api/models/bert";
		const README: &str = "https://huggingface.co/bert/raw/main/README.md";
		let client = FakeClient::with([
			(
				API,
				Ok(response(
					API,
					200,
					r#"{"modelId":"bert","pipeline_tag":"fill-mask","private":true,"gated":true,"tags":["bert"],"cardData":{"license":"apache-2.0"}}"#,
				)),
			),
			(README, Ok(response(README, 200, "Card."))),
		]);

		let rendered = render(&client, &Url::parse("https://huggingface.co/bert").unwrap())
			.await
			.unwrap()
			.unwrap();

		assert_eq!(
			rendered.content.as_str(),
			"# bert\n\n**Task:** fill-mask\n**Tags:** bert\n\n## Model Card\n\nCard."
		);
		assert!(!rendered.content.contains("Visibility"));
		assert!(!rendered.content.contains("License"));
	}

	#[tokio::test]
	async fn malformed_model_falls_back_to_user_for_single_segment_url() {
		const MODEL: &str = "https://huggingface.co/api/models/alice";
		const USER: &str = "https://huggingface.co/api/users/alice";
		let client = FakeClient::with([
			(MODEL, Ok(response(MODEL, 200, "{not json"))),
			(
				USER,
				Ok(response(
					USER,
					200,
					r#"{"user":"alice","fullname":"Alice Example","numModels":1500,"numDatasets":2,"numSpaces":1,"orgs":[{"name":"research"},{"name":"tools"}]}"#,
				)),
			),
		]);

		let rendered = render(&client, &Url::parse("https://huggingface.co/alice").unwrap())
			.await
			.unwrap()
			.unwrap();

		assert_eq!(client.requested_urls(), vec![MODEL.to_owned(), USER.to_owned()]);
		assert_eq!(
			rendered.content.as_str(),
			"# alice\n\n**Name:** Alice Example\n**Models:** 1.5K\n**Datasets:** 2\n**Spaces:** \
			 1\n**Organizations:** research, tools"
		);
	}

	#[tokio::test]
	async fn malformed_json_or_failed_required_metadata_returns_none() {
		const API: &str = "https://huggingface.co/api/models/acme/broken";
		const README: &str = "https://huggingface.co/acme/broken/raw/main/README.md";
		let malformed = FakeClient::with([
			(API, Ok(response(API, 200, "{not json"))),
			(README, Ok(response(README, 200, "Ignored card."))),
		]);
		let url = Url::parse("https://huggingface.co/acme/broken").unwrap();
		assert!(render(&malformed, &url).await.unwrap().is_none());

		let failed = FakeClient::with([
			(API, Err(WebError::request("offline"))),
			(README, Err(WebError::request("offline"))),
		]);
		assert!(render(&failed, &url).await.unwrap().is_none());
	}

	#[tokio::test]
	async fn missing_or_empty_readme_keeps_metadata_result() {
		const API: &str = "https://huggingface.co/api/models/acme/model";
		const README: &str = "https://huggingface.co/acme/model/raw/main/README.md";
		for readme in [
			Ok(response(README, 404, "not found")),
			Ok(response(README, 200, " \n\t")),
			Err(WebError::request("timeout")),
		] {
			let client = FakeClient::with([
				(API, Ok(response(API, 200, r#"{"modelId":"acme/model"}"#))),
				(README, readme),
			]);
			let rendered = render(&client, &Url::parse("https://huggingface.co/acme/model").unwrap())
				.await
				.unwrap()
				.unwrap();
			assert_eq!(rendered.content.as_str(), "# acme/model");
			assert!(rendered.diags.is_empty());
		}
	}
}
