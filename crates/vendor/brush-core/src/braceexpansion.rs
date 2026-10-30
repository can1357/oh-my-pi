use brush_parser::word;
use itertools::Itertools;

use crate::{ExecutionParameters, error, interp};

/// Generates every word the brace expression `pieces` stands for, in order.
///
/// A range sets the count here, not the script: `{1..3000000}` is 12 bytes in
/// and three million words out, and no step waits on anything. So the
/// generator spends a checkpoint on each word it makes, and a run cancelled
/// partway stops here instead of after the last word.
#[async_recursion::async_recursion]
pub(crate) async fn generate_and_combine_brace_expansions(
	pieces: Vec<word::BraceExpressionOrText>,
	params: &ExecutionParameters,
) -> Result<Vec<String>, error::Error> {
	let mut expansions = Vec::with_capacity(pieces.len());
	for piece in pieces {
		let words = match piece {
			word::BraceExpressionOrText::Expr(members) => {
				let mut words = vec![];
				for member in members {
					expand_brace_expr_member(member, params, &mut words).await?;
				}
				words
			},
			word::BraceExpressionOrText::Text(text) => vec![text],
		};
		expansions.push(words);
	}

	let mut words = vec![];
	let mut budget = interp::ElementBudget::new();
	for combination in expansions.into_iter().multi_cartesian_product() {
		// One word per combination, and concatenating it copies its parts, so
		// the budget is charged in bytes as well as steps. Counting is
		// synchronous: awaiting on every word kept the loop's state in the
		// future and cost more than the checkpoints did.
		let due = budget.charge(combination.iter().map(String::len).sum());
		if due > 0 {
			interp::loop_checkpoints(params, due).await?;
		}
		words.push(combination.concat());
	}

	Ok(words)
}

/// Appends the words that one member of a brace expression stands for to
/// `words`.
#[expect(clippy::cast_possible_truncation)]
async fn expand_brace_expr_member(
	bem: word::BraceExpressionMember,
	params: &ExecutionParameters,
	words: &mut Vec<String>,
) -> Result<(), error::Error> {
	let sequence: Box<dyn Iterator<Item = String> + Send> = match bem {
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
			// A nested expression spends its own checkpoint on each word.
			words.append(&mut generate_and_combine_brace_expansions(elements, params).await?);
			return Ok(());
		},
	};

	let mut budget = interp::ElementBudget::new();
	for generated in sequence {
		let due = budget.charge(generated.len());
		if due > 0 {
			interp::loop_checkpoints(params, due).await?;
		}
		words.push(generated);
	}

	Ok(())
}
