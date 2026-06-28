use brush_parser::word;
use itertools::Itertools;

pub(crate) fn generate_and_combine_brace_expansions(
	pieces: Vec<brush_parser::word::BraceExpressionOrText>,
) -> impl IntoIterator<Item = String> {
	let expansions: Vec<Vec<String>> = pieces
		.into_iter()
		.map(|piece| expand_brace_expr_or_text(piece).collect())
		.collect();

	expansions
		.into_iter()
		.multi_cartesian_product()
		.map(|v| v.join(""))
}

fn expand_brace_expr_or_text(
	beot: word::BraceExpressionOrText,
) -> Box<dyn Iterator<Item = String>> {
	match beot {
		word::BraceExpressionOrText::Expr(members) => {
			// Chain all member iterators together
			Box::new(members.into_iter().flat_map(expand_brace_expr_member))
		},
		word::BraceExpressionOrText::Text(text) => Box::new(std::iter::once(text)),
	}
}

#[expect(clippy::cast_possible_truncation)]
fn expand_brace_expr_member(bem: word::BraceExpressionMember) -> Box<dyn Iterator<Item = String>> {
	match bem {
		word::BraceExpressionMember::NumberSequence { start, end, increment } => {
			let mut increment = increment.unsigned_abs() as usize;
			if increment == 0 {
				increment = 1;
			}

			if start <= end {
				Box::new((start..=end).step_by(increment).map(|n| n.to_string()))
			} else {
				// Iterate from start down to end by decrementing.
				#[allow(clippy::cast_possible_wrap)]
				let increment = increment as i64;
				Box::new(
					std::iter::successors(Some(start), move |&n| {
						let next = n - increment;
						(next >= end).then_some(next)
					})
					.map(|n| n.to_string()),
				)
			}
		},

		word::BraceExpressionMember::CharSequence { start, end, increment } => {
			let mut increment = increment.unsigned_abs() as usize;
			if increment == 0 {
				increment = 1;
			}

			if start <= end {
				Box::new((start..=end).step_by(increment).map(|c| c.to_string()))
			} else {
				// Iterate from start down to end by decrementing.
				let increment = increment as u32;
				Box::new(
					std::iter::successors(Some(start), move |&c| {
						let next = char::from_u32(c as u32 - increment)?;
						(next >= end).then_some(next)
					})
					.map(|c| c.to_string()),
				)
			}
		},

		word::BraceExpressionMember::Child(elements) => {
			// Chain all element iterators together
			Box::new(generate_and_combine_brace_expansions(elements).into_iter())
		},
	}
}
