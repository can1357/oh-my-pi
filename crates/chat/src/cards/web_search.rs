//! Typed card for web-search answers and citations.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_core::{Str, sf};
use omp_proto::inference::v1::{self as pb, search_response};
use omp_tui::{Border, IntoComponent as _, UiContext, dom};

use super::{Card, CardStatus, CardView, Component, elapsed_badge, typed_fault};

/// Renders a web-search answer, source list, provider metadata, or fault.
pub struct WebSearchCard;

impl Card for WebSearchCard {
	fn tool(&self) -> &'static str {
		"web_search"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		let args = view.input::<omp_tools::web_search::Params>();
		let query = args.as_ref().map_or("", |params| params.query.as_str());
		if view.status == CardStatus::Failed {
			let fault = view.fault::<omp_tools::web_search::Fault>();
			let provider = match fault.as_ref() {
				Some(omp_tools::web_search::Fault::Search { provider: Some(provider), .. }) => {
					let name: &'static str = (*provider).into();
					Some(provider_name(name))
				},
				_ => None,
			};
			let error = match fault.as_ref() {
				Some(omp_tools::web_search::Fault::Search { category, code, status, .. }) => {
					match status {
						Some(status) => sf!("{category}: {code} (HTTP {status})"),
						None => sf!("{category}: {code}"),
					}
				},
				None => typed_fault::<omp_tools::web_search::Fault>(view)
					.unwrap_or_else(|| omp_core::Str::new_static("search failed")),
			};
			return dom! {
				<box border=round bc=err bg=error_surface bleed title_pad=3 pad="0 1">
					<row kind=title gap=0><i:error fg=err/><text>{" "}</text><text fg=accent>{"Web Search"}</text>
						if let Some(provider) = provider { <text>{":"}</text><text fg=output wrap=pre>{format!(" {provider}")}</text> }
						<text>{" "}</text>
					</row>
					<text fg=err>{format!("Error: {error}")}</text>
				</box>
			}.into_component();
		}
		let Some(payload) = view.result::<omp_tools::web_search::Payload>() else {
			return dom! {
				<row gap=0><i:pending fg=output/><text>{" "}</text><text fg=accent>{"Web Search"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {query}")}</text>
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
			}
			.into_component();
		};
		let result = payload.response;
		let provider = provider_name(if result.engine.is_empty() {
			"web"
		} else {
			result.engine.as_str()
		});
		let sources = &result.sources;
		let source_count = format!("{} sources", sources.len());
		let answer = result.answer.replace("<br>\n", "\n");
		let usage = result.usage.as_ref();
		let usage_text = format!(
			"Usage: in {} · out {} · total {} · search {}",
			usage.map_or(0, |usage| usage.input_tokens),
			usage.map_or(0, |usage| usage.output_tokens),
			usage
				.and_then(|usage| usage.total_tokens)
				.unwrap_or_default(),
			usage
				.and_then(|usage| usage.server_tools.as_ref())
				.and_then(|tools| tools.web_search_requests)
				.unwrap_or_default(),
		);
		let (branch, last, _) = ui.charset.guides(Border::Square);
		// A collapsed card lists the first eight sources and a
		// `… N more sources` tail row; expanded
		// lists them all.
		let shown = if expanded {
			sources.len()
		} else {
			sources.len().min(COLLAPSED_SOURCES)
		};
		let hidden = sources.len() - shown;
		let mut source_rows = Vec::with_capacity(shown + usize::from(hidden > 0));
		for (index, source) in sources.iter().take(shown).enumerate() {
			let prefix = if index + 1 == shown && hidden == 0 {
				last
			} else {
				branch
			};
			let name = if source.title.trim().is_empty() {
				if source.url.is_empty() {
					"Untitled"
				} else {
					source.url.as_str()
				}
			} else {
				source.title.as_str()
			};
			let domain = (!source.url.is_empty())
				.then(|| domain_of(&source.url))
				.filter(|domain| !domain.is_empty());
			let href = source.url.as_str();
			let age = source_age(source).map(|age| match age {
				SourceAge::Relative(ms) => {
					dom! { <row gap=1 fg=muted><text>{"·"}</text><time kind="relative" ms={ms}/></row> }
						.into_component()
				},
				SourceAge::Literal(date) => {
					dom! { <row gap=1 fg=muted><text>{"·"}</text><text>{date}</text></row> }
						.into_component()
				},
			});
			source_rows.push(
				dom! {
					<col>
						<row gap=0>
							<text fg=muted wrap=pre>{format!("{prefix} ")}</text><text fg=accent href={href} wrap=pre>{name}</text>
							if let Some(domain) = domain { <text fg=muted wrap=pre>{format!(" ({domain})")}</text> }
							if let Some(age) = age { <text>{" "}</text>{age} }
						</row>
						if expanded && !source.snippet.is_empty() { <text fg=muted>{source.snippet.as_str()}</text> }
					</col>
				}
				.into_component(),
			);
		}
		if hidden > 0 {
			let more = sf!("{last} … {hidden} more source{}", if hidden == 1 { "" } else { "s" });
			source_rows.push(dom! { <text fg=muted>{more}</text> }.into_component());
		}
		if source_rows.is_empty() {
			source_rows.push(dom! { <text fg=muted>{"No sources returned"}</text> }.into_component());
		}
		let answer = if answer.trim().is_empty() {
			Str::new_static("No answer text returned")
		} else {
			Str::new(answer)
		};
		let shown_citations = if expanded {
			result.citations.len()
		} else {
			result.citations.len().min(COLLAPSED_SOURCES)
		};
		let hidden_citations = result.citations.len() - shown_citations;
		let mut citation_rows =
			Vec::with_capacity(shown_citations + usize::from(hidden_citations > 0));
		for (index, citation) in result.citations.iter().take(shown_citations).enumerate() {
			let title = if citation.title.trim().is_empty() {
				citation.url.as_str()
			} else {
				citation.title.as_str()
			};
			citation_rows.push(
				dom! {
					<col>
						<row gap=1><text fg=muted>{format!("[{}]", index + 1)}</text><text fg=accent href={citation.url.as_str()}>{title}</text></row>
						if expanded && !citation.cited_text.is_empty() { <text fg=muted>{citation.cited_text.as_str()}</text> }
					</col>
				}
				.into_component(),
			);
		}
		if hidden_citations > 0 {
			citation_rows.push(
				dom! { <text fg=muted>{format!("… {hidden_citations} more citations")}</text> }
					.into_component(),
			);
		}
		let mut warning_rows = Vec::with_capacity(result.warnings.len() + result.failures.len());
		for warning in &result.warnings {
			warning_rows
				.push(dom! { <callout kind="warn">{warning.as_str()}</callout> }.into_component());
		}
		for failure in &result.failures {
			let kind = search_response::failure::Kind::try_from(failure.kind)
				.unwrap_or(search_response::failure::Kind::Unspecified)
				.as_str_name();
			let detail = match (failure.status, failure.code.is_empty()) {
				(Some(status), false) => {
					sf!("{}: {kind} [{}] (HTTP {status})", failure.provider, failure.code)
				},
				(Some(status), true) => sf!("{}: {kind} (HTTP {status})", failure.provider),
				(None, false) => sf!("{}: {kind} [{}]", failure.provider, failure.code),
				(None, true) => sf!("{}: {kind}", failure.provider),
			};
			warning_rows.push(dom! { <callout kind="warn">{detail}</callout> }.into_component());
		}
		let query = Str::new(query);
		let provider_line = if result.auth_mode.is_empty() {
			sf!("Provider: {provider}")
		} else {
			sf!("Provider: {provider} ({})", result.auth_mode)
		};
		dom! {
			<box border=round bc=muted bg=panel bleed title_pad=3 pad="0 1">
				<row kind=title gap=0><i:web-search fg=accent/><text>{" "}</text><text fg=accent>{"Web Search"}</text><text>{":"}</text>
					<text fg=output wrap=pre>{format!(" {provider}")}</text><text fg=muted wrap=pre>{format!(" {source_count}")}</text><text>{" "}</text>
				</row>
				<col>
					<row gap=0><text fg=output>{"Query:"}</text><text wrap=pre>{format!(" {query}")}</text></row>
					<hr title="Answer" title_pad=3 bc=muted/>
					<md>{answer}</md>
					<hr title="Sources" title_pad=3 bc=muted/>
					{source_rows}
					if !citation_rows.is_empty() {
						<hr title="Citations" title_pad=3 bc=muted/>
						{citation_rows}
					}
					{warning_rows}
					<hr title="Metadata" title_pad=3 bc=muted/>
					<text fg=output>{provider_line}</text>
					<text fg=output>{usage_text}</text>
				</col>
			</box>
		}
		.into_component()
	}
}

/// Sources listed before the collapsed card folds the rest into a
/// `… N more sources` row.
const COLLAPSED_SOURCES: usize = 8;

/// How a source's publication time is painted.
enum SourceAge {
	/// Age in milliseconds for a live `<time kind=relative>` badge.
	Relative(u64),
	/// The engine's own date text, shown verbatim.
	Literal(Str),
}

/// The source's age: a relative badge when the engine reported an
/// `age_seconds` or the facade encoded `published_at` as Unix seconds
/// (`omp_serve::inference`), the date text verbatim when it is an ISO date,
/// nothing when unknown. Never invented.
fn source_age(source: &pb::search_response::Source) -> Option<SourceAge> {
	if source.age_seconds > 0 {
		return Some(SourceAge::Relative(source.age_seconds.saturating_mul(1000)));
	}
	let published = source.published_at.trim();
	if published.is_empty() {
		return None;
	}
	match published.parse::<u64>() {
		Ok(secs) if secs > 0 => {
			let now = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.map_or(0, |elapsed| elapsed.as_secs());
			Some(SourceAge::Relative(now.saturating_sub(secs).saturating_mul(1000)))
		},
		Ok(_) => None,
		Err(_) => Some(SourceAge::Literal(Str::new(published))),
	}
}

fn provider_name(value: &str) -> String {
	let mut chars = value.chars();
	chars
		.next()
		.map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}
fn domain_of(url: &str) -> String {
	url.split_once("://")
		.map_or(url, |(_, rest)| rest)
		.split('/')
		.next()
		.unwrap_or_default()
		.trim_start_matches("www.")
		.to_owned()
}
