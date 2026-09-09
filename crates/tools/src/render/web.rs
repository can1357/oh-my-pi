//! Native web search renderer.

use omp_core::{Str, sf};
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};

use super::{live_view, view::El};
use crate::{
	gallery::RendererGalleryFixture,
	view,
	web_search::{Fault as WebSearchFault, Payload as WebSearchPayload, Update as WebSearchUpdate},
};

pub(super) struct WebSearchRenderer;

impl RenderFold for WebSearchRenderer {
	type Outcome = CallOutcome<WebSearchPayload, WebSearchFault>;
	type State = Option<Str>;
	type Update = WebSearchUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		if let Some(query) = args.get("query").and_then(|value| value.as_str()) {
			*state = Some(Str::new(query));
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_web_search_live(state.as_deref()).into()),
			Some(CallOutcome::Ok(payload)) => {
				Some(render_web_search_payload(state.as_deref(), payload).into())
			},
			Some(CallOutcome::Faulted(fault)) => Some(render_web_search_fault(fault).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

fn render_web_search_live(query: Option<&str>) -> El {
	let Some(query) = query else {
		return live_view("web_search", "searching providers");
	};
	view! {
		<row gap=1>
			<spinner color=accent/>
			<text fg=muted>{"Searching for"}</text>
			<text>{query}</text>
		</row>
	}
}

fn render_web_search_payload(query: Option<&str>, payload: &WebSearchPayload) -> El {
	let response = &payload.response;
	let query = query.or_else(|| response.search_queries.first().map(String::as_str));
	view! {
		<col gap=1>
			if let Some(query) = query.filter(|query| !query.is_empty()) {
				<fact label="Query">{query}</fact>
			}
			<text bold>{"Answer"}</text>
			if response.answer.is_empty() {
				<text fg=muted>{"No answer text returned"}</text>
			} else {
				<md>{response.answer.as_str()}</md>
			}
			<text bold>{"Sources"}</text>
			if response.sources.is_empty() {
				<text fg=muted>{"No sources returned"}</text>
			} else {
				<col max-rows=8 overflow="sources">
					for source in &response.sources {
						<row sep=" · ">
							<text>
								if source.title.is_empty() {
									{source.url.as_str()}
								} else {
									{source.title.as_str()}
								}
							</text>
							if let Some(domain) = source_domain(&source.url) {
								<text fg=muted>{domain}</text>
							}
							if !source.published_at.is_empty() {
								<text fg=muted>{source.published_at.as_str()}</text>
							}
						</row>
					}
				</col>
			}
			if !response.citations.is_empty() {
				<text bold>{"Citations"}</text>
				<col max-rows=8 overflow="citations">
					for citation in &response.citations {
						<col>
							<text>{if citation.title.is_empty() { citation.url.as_str() } else { citation.title.as_str() }}</text>
							<text fg=muted>{citation.url.as_str()}</text>
							if !citation.cited_text.is_empty() {
								<text fg=muted>{citation.cited_text.as_str()}</text>
							}
						</col>
					}
				</col>
			}
			<text bold>{"Metadata"}</text>
			if !response.engine.is_empty() {
				<fact label="Provider">{response.engine.as_str()}</fact>
			}
			if !response.auth_mode.is_empty() {
				<fact label="Auth">{response.auth_mode.as_str()}</fact>
			}
			if let Some(usage) = response.usage.as_ref() {
				<fact label="Usage">
					<row sep=" · ">
						<row gap=1><text fg=muted>{"in"}</text><num value={usage.input_tokens}/></row>
						<row gap=1><text fg=muted>{"out"}</text><num value={usage.output_tokens}/></row>
						<row gap=1>
							<text fg=muted>{"total"}</text>
							<num value={usage.total_tokens.unwrap_or_else(|| usage.input_tokens.saturating_add(usage.output_tokens))}/>
						</row>
						<row gap=1>
							<text fg=muted>{"search"}</text>
							<num value={usage.server_tools.as_ref().and_then(|tools| tools.web_search_requests).unwrap_or(0)}/>
						</row>
					</row>
				</fact>
			}
			for warning in &response.warnings {
				<callout kind="warn">{warning.as_str()}</callout>
			}
			for failure in &response.failures {
				<callout kind="warn">
					{failure.provider.as_str()}{": "}{failure.code.as_str()}
					if let Some(status) = failure.status { {sf!(" (HTTP {status})")} }
				</callout>
			}
		</col>
	}
}

fn source_domain(url: &str) -> Option<&str> {
	let remainder = url
		.strip_prefix("https://")
		.or_else(|| url.strip_prefix("http://"))?;
	let authority = remainder.split(['/', '?', '#']).next()?;
	let host = authority.rsplit('@').next()?.split(':').next()?;
	(!host.is_empty()).then_some(host)
}

fn render_web_search_fault(fault: &WebSearchFault) -> El {
	let WebSearchFault::Search { category, code, status, .. } = fault;
	let category: &'static str = (*category).into();
	view! {
		<callout kind="error">
			{"Provider error ("}{category}{": "}{code}{")"}
			if let Some(status) = status { {sf!(" HTTP {status}")} }
		</callout>
	}
}

/// Native web search renderer lifecycle fixtures for the visual QA gallery.
pub fn gallery_fixtures(web_search: ToolIdentity) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity: web_search,
			streaming_args: r#"{"query":"Bun vs Node.js performance bench"#,
			args: r#"{"query":"Bun vs Node.js performance benchmarks 2026","recency":"month","limit":4}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"response":{"engine":"sonar-pro @ Perplexity","answer":"Bun continues to outperform Node.js on raw HTTP throughput and cold-start time thanks to its JavaScriptCore engine and native-Zig runtime, while Node.js retains an edge in ecosystem maturity and long-term stability.\n\nFor script-heavy workflows, Bun's faster startup is the decisive factor.","sources":[{"title":"Bun 1.2 Benchmarks: HTTP, SQLite, and Startup Time","url":"https://bun.sh/blog/bun-v1.2-benchmarks","snippet":"Bun serves roughly 2.5x the requests per second of Node.js on a simple HTTP server and starts in under 10ms.","published_at":"12d ago","author":"The Bun Team"},{"title":"Node.js vs Bun: A 2026 Performance Deep Dive","url":"https://blog.platformatic.dev/nodejs-vs-bun-2026","snippet":"Across CPU-bound workloads the gap narrows, but Bun's faster module resolution keeps cold starts ahead.","published_at":"3d ago","author":"Matteo Collina"},{"title":"Real-world API latency: Bun, Deno, and Node compared","url":"https://www.theregister.com/2026/05/18/js_runtime_latency/","snippet":"Under sustained load p99 latencies converge, suggesting runtime choice matters less for steady-state services.","published_at":"19d ago"},{"title":"Why we migrated our CLI tooling from Node to Bun","url":"https://engineering.example.com/posts/bun-cli-migration","snippet":"Startup dropped from 180ms to 22ms, shaving seconds off every developer command invocation.","published_at":"27d ago","author":"Dana Whitfield"}],"citations":[{"url":"https://bun.sh/blog/bun-v1.2-benchmarks","title":"Bun 1.2 Benchmarks","cited_text":"Bun serves roughly 2.5x the requests per second of Node.js"}],"search_queries":["bun vs node.js performance benchmarks 2026","bun http throughput vs node"],"usage":{"input_tokens":312,"output_tokens":248,"total_tokens":560,"server_tools":{"web_search_requests":2}},"auth_mode":"api_key"}}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"search","provider":"perplexity","category":"rate_limited","code":"resource_exhausted","status":429}}"#,
		},
	]
}
#[cfg(test)]
mod tests {
	use omp_proto::inference::v1::search_response::{Failure, failure::Kind};
	use omp_tool::Rev;

	use super::*;

	fn identity(name: &'static str) -> ToolIdentity {
		ToolIdentity { name: Str::new_static(name), rev: Rev { family: Default::default(), n: 2 } }
	}

	#[test]
	fn fixtures_decode_and_render_the_rich_sections() {
		let fixtures = gallery_fixtures(identity("web_search"));
		let web = &fixtures[0];
		assert!(web.progress_update.is_none());
		let success: CallOutcome<WebSearchPayload, WebSearchFault> =
			serde_json::from_slice(web.success_outcome).expect("web search success decodes");
		let error: CallOutcome<WebSearchPayload, WebSearchFault> =
			serde_json::from_slice(web.error_outcome).expect("web search fault decodes");
		let renderer = WebSearchRenderer;
		let mut state = None;
		renderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(web.streaming_args),
			false,
		);
		assert!(
			renderer
				.view(&state, None)
				.expect("streaming query renders")
				.contains("Bun vs Node.js performance bench"),
		);
		renderer.fold_args(&mut state, &omp_core::slopjson::parse_streaming(web.args), true);
		let view = renderer
			.view(&state, Some(&success))
			.expect("success renders");
		assert!(view.contains("<fact label=Query>"));
		assert!(view.contains("Answer"));
		assert!(view.contains("Sources"));
		assert!(view.contains("<col max-rows=8 overflow=sources>"));
		assert!(view.contains("<row sep=\" · \"><text>Bun 1.2 Benchmarks"));
		assert!(view.contains("<text fg=muted>bun.sh</text>"));
		assert!(view.contains("<text fg=muted>12d ago</text>"));
		assert!(view.contains("<text bold>Citations</text>"));
		assert!(view.contains("Bun 1.2 Benchmarks"));
		assert!(view.contains("<fact label=Provider>sonar-pro @ Perplexity</fact>"));
		assert!(view.contains("<fact label=Usage><row sep=\" · \">"));
		assert!(view.contains("<num value=560/>"));
		assert!(!view.contains("ctrl+o"));
		assert!(
			renderer
				.view(&state, Some(&error))
				.expect("fault renders")
				.contains(
					"<callout kind=error>Provider error (rate_limited: resource_exhausted) HTTP 429"
				),
		);

		let mut empty = match &success {
			CallOutcome::Ok(payload) => payload.clone(),
			_ => unreachable!("success fixture decoded as ok"),
		};
		let source = empty.response.sources[0].clone();
		empty.response.warnings.push("<warning&>".to_owned());
		empty.response.failures.push(Failure {
			provider: "fallback<&".to_owned(),
			kind:     Kind::Quota.into(),
			status:   Some(429),
			code:     "rate<&".to_owned(),
		});
		empty.response.sources = vec![source; 9];
		let bounded_view = render_web_search_payload(None, &empty).to_tml();
		assert_eq!(bounded_view.matches("<row sep=\" · \">").count(), 10);
		assert!(!bounded_view.contains("more sources"));
		assert!(bounded_view.contains("<callout kind=warn>&lt;warning&amp;&gt;</callout>"));
		assert!(
			bounded_view
				.contains("<callout kind=warn>fallback&lt;&amp;: rate&lt;&amp; (HTTP 429)</callout>",)
		);
		let escaped_view = render_web_search_payload(Some("<query&>"), &empty).to_tml();
		assert!(escaped_view.contains("<fact label=Query>&lt;query&amp;&gt;</fact>"));

		empty.response.answer.clear();
		empty.response.sources.clear();
		let empty_view = render_web_search_payload(None, &empty).to_tml();
		assert!(empty_view.contains("No answer text returned"));
		assert!(empty_view.contains("No sources returned"));
	}
}
