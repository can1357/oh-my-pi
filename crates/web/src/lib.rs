//! HTML selection and plain-text/Markdown rendering, plus a sans-I/O web
//! reader.

pub mod decode;
pub mod dom;
pub mod embedded;
pub mod facts;
pub mod feed;
pub mod reader;
pub mod remote;
pub mod render;
pub mod select;
pub mod sites;
pub mod sniff;
pub mod strategy;
pub mod wall;
pub mod write;

/// Policy for retaining content hidden by markup.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Hidden {
	/// Omit hidden content.
	#[default]
	Drop,
	/// Retain hidden content that the reader can reveal, such as a disclosure.
	Reachable,
	/// Keep content regardless of markup visibility.
	All,
}

impl Hidden {
	/// Parse a policy name used by the reader options.
	pub fn parse(name: &str) -> Option<Self> {
		match name {
			"drop" => Some(Self::Drop),
			"reachable" => Some(Self::Reachable),
			"all" => Some(Self::All),
			_ => None,
		}
	}
}
