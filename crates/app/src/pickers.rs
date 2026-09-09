//! Small terminal pickers shared by CLI startup flows.

use std::io::{self, IsTerminal as _, Write as _};

use omp_catalog::{PriceUnit, settings::ModelSettings, snapshot::Catalog};
use omp_chat::ModelRow;
use omp_core::Str;
use omp_driver::{
	cleanse::{Checker, TargetChoice},
	discovery::roles::model_selector_allowed,
};
use thiserror::Error;

/// Projects the admitted catalog models into chat model-picker rows: every
/// model that passes the configured provider/model admission, in catalog
/// order, with its first route's provider, context window, per-Mtok prices,
/// and thinking efforts.
pub fn model_rows(catalog: &Catalog, settings: &ModelSettings) -> Vec<ModelRow> {
	let rows = |admitted: bool| {
		catalog
			.models()
			.iter()
			.filter(|model| !admitted || model_selector_allowed(catalog, settings, model.key.as_str()))
			.map(|model| {
				let (provider_id, provider) = model
					.routes
					.first()
					.and_then(|route| catalog.route(route))
					.map(|route| {
						let name = catalog.provider(&route.provider).map_or_else(
							|| Str::new(route.provider.as_str()),
							|provider| Str::new(provider.name.as_str()),
						);
						(Str::new(route.provider.as_str()), name)
					})
					.unwrap_or_default();
				let price = |unit: PriceUnit| {
					model
						.pricing
						.components
						.iter()
						.find(|price| price.unit == unit)
						.map(|price| price.nanos_usd as f64 / 1_000_000_000.0)
				};
				ModelRow {
					key: Str::new(model.key.as_str()),
					name: model.display_name.clone(),
					provider_id,
					provider,
					context: model.limits.context_window,
					input_mtok: price(PriceUnit::MtokInput),
					output_mtok: price(PriceUnit::MtokOutput),
					efforts: model
						.thinking
						.as_ref()
						.and_then(|policy| catalog.thinking_policy(policy))
						.map(|policy| {
							policy
								.efforts
								.iter()
								.map(|effort| Str::new_static(<&'static str>::from(*effort)))
								.collect()
						})
						.unwrap_or_default(),
				}
			})
			.collect::<Vec<_>>()
	};
	match rows(true) {
		// Nothing admitted means nothing is configured yet; an empty picker
		// would hide every route, so fall open to the full catalog.
		admitted if admitted.is_empty() => rows(false),
		admitted => admitted,
	}
}

/// One selectable text row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ListRow {
	pub(crate) key:    Str,
	pub(crate) label:  Str,
	pub(crate) detail: Str,
}

/// Failure to render a standalone picker.
#[derive(Debug, Error)]
pub(crate) enum PickerError {
	/// Terminal input or output failed.
	#[error(transparent)]
	Terminal(#[from] io::Error),
}

/// Chooses all checkers, one checker, or a free-form discovery request.
pub(crate) async fn pick_cleanse_target(checkers: &[Checker]) -> Result<TargetChoice, PickerError> {
	if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
		return Ok(TargetChoice::All);
	}
	let mut rows = Vec::with_capacity(checkers.len() + 2);
	rows.push(ListRow {
		key:    "all".into(),
		label:  Str::from(format!("Run all {} discovered checkers", checkers.len())),
		detail: Str::default(),
	});
	rows.extend(checkers.iter().map(|checker| ListRow {
		key:    checker.id.clone(),
		label:  checker.label.clone(),
		detail: Str::from(format!("{} — {}", checker.language, checker.binary.display())),
	}));
	rows.push(ListRow {
		key:    "request".into(),
		label:  "Describe what to fix…".into(),
		detail: "A discovery agent determines the checker command".into(),
	});
	let Some(index) = run_list("Select what to cleanse", &rows).await? else {
		return Ok(TargetChoice::Cancel);
	};
	if index == 0 {
		Ok(TargetChoice::All)
	} else if index == rows.len() - 1 {
		Ok(prompt_cleanse_request()?.map_or(TargetChoice::Cancel, TargetChoice::Request))
	} else {
		Ok(TargetChoice::Checker(checkers[index - 1].id.clone()))
	}
}

/// Reads a cleanse discovery request only when both standard streams are TTYs.
pub(crate) fn prompt_cleanse_request() -> Result<Option<Str>, PickerError> {
	if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
		return Ok(None);
	}
	print!("Describe what to detect and fix: ");
	io::stdout().flush()?;
	let mut request = String::new();
	io::stdin().read_line(&mut request)?;
	let request = request.trim();
	Ok((!request.is_empty()).then(|| Str::from(request)))
}

/// Runs a numbered terminal picker. Non-interactive callers select the first
/// row.
pub(crate) async fn run_list(title: &str, rows: &[ListRow]) -> Result<Option<usize>, PickerError> {
	if rows.is_empty() {
		return Ok(None);
	}
	if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
		return Ok(Some(0));
	}
	println!("{title}");
	for (index, row) in rows.iter().enumerate() {
		println!("  {}. {}  {}", index + 1, row.label, row.detail);
	}
	print!("Selection (empty to cancel): ");
	io::stdout().flush()?;
	let mut input = String::new();
	io::stdin().read_line(&mut input)?;
	let input = input.trim();
	if input.is_empty() {
		return Ok(None);
	}
	Ok(input
		.parse::<usize>()
		.ok()
		.filter(|value| (1..=rows.len()).contains(value))
		.map(|value| value - 1))
}
