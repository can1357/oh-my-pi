//! Real session-DOM fixtures for the typed tool-card gallery.

mod agents;
mod ask;
mod context_gauge;
mod custom;
mod debug;
mod exec;
mod files;
mod github;
mod memory;
mod report_issue;
mod resolve;
mod think;
mod utility;
mod web_search;
mod workpool;

/// One tool-card gallery fixture.
#[derive(Clone, Copy, Debug)]
pub struct CardFixture {
	/// Gallery section and tool identity.
	pub tool:   &'static str,
	/// Human-readable section title.
	pub title:  &'static str,
	/// Streaming, running, successful, and failed states, in that order.
	pub states: [FixtureState; 4],
}

/// Journal payloads used to materialize one lifecycle state.
#[derive(Clone, Copy, Debug)]
pub struct FixtureState {
	/// Tool argument JSON; streaming state may contain a partial JSON prefix.
	pub args:   &'static str,
	/// Optional typed update JSON.
	pub update: Option<&'static str>,
	/// Optional successful outcome JSON.
	pub result: Option<&'static str>,
	/// Optional terminal fault JSON.
	pub fault:  Option<&'static str>,
}

pub(crate) fn all() -> Vec<&'static CardFixture> {
	let mut fixtures = Vec::new();
	fixtures.extend(agents::FIXTURES);
	fixtures.extend(ask::FIXTURES);
	fixtures.extend(context_gauge::FIXTURES);
	fixtures.extend(custom::FIXTURES);
	fixtures.extend(debug::FIXTURES);
	fixtures.extend(exec::FIXTURES);
	fixtures.extend(files::FIXTURES);
	fixtures.extend(github::FIXTURES);
	fixtures.extend(memory::FIXTURES);
	fixtures.extend(report_issue::FIXTURES);
	fixtures.extend(resolve::FIXTURES);
	fixtures.extend(think::FIXTURES);
	fixtures.extend(utility::FIXTURES);
	fixtures.extend(web_search::FIXTURES);
	fixtures.extend(workpool::FIXTURES);
	fixtures
}
