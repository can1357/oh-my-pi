use std::collections::HashMap;

const PLACEHOLDER_DIRS: &[&str] = &[
	"src", "lib", "bin", "crates", "benches", "examples", "internal", "pkg", "include", "tests",
	"test", "docs", "packages", "modules",
];
const SKIP_DIRS: &[&str] =
	&[".test", "tests", "benches", "examples", "target", "build", "node_modules", ".github"];

pub(super) fn infer_scope(diff: &str) -> Option<String> {
	let mut weights = HashMap::<String, usize>::new();
	let mut total = 0_usize;
	let mut current_path = None::<String>;
	let mut current_lines = 0_usize;
	let flush = |path: &mut Option<String>,
	             lines: &mut usize,
	             weights: &mut HashMap<String, usize>,
	             total: &mut usize| {
		let Some(path) = path.take() else { return };
		let changed = (*lines).max(1);
		*total = total.saturating_add(changed);
		for component in extract_components_from_path(&path) {
			*weights.entry(component).or_default() += changed;
		}
		*lines = 0;
	};
	for line in diff.lines() {
		if line.starts_with("diff --git ") {
			flush(&mut current_path, &mut current_lines, &mut weights, &mut total);
			current_path = line
				.split_whitespace()
				.nth(3)
				.map(|path| extract_path_from_rename(path.trim_start_matches("b/")));
		} else if (line.starts_with('+') && !line.starts_with("+++"))
			|| (line.starts_with('-') && !line.starts_with("---"))
		{
			current_lines = current_lines.saturating_add(1);
		}
	}
	flush(&mut current_path, &mut current_lines, &mut weights, &mut total);
	if total == 0 {
		return None;
	}
	let mut candidates = weights.into_iter().collect::<Vec<_>>();
	candidates.sort_by(|left, right| {
		let left_score = left
			.1
			.saturating_mul(if left.0.contains('/') { 6 } else { 5 });
		let right_score = right
			.1
			.saturating_mul(if right.0.contains('/') { 6 } else { 5 });
		right_score
			.cmp(&left_score)
			.then_with(|| left.0.cmp(&right.0))
	});
	let top_levels = candidates
		.iter()
		.filter_map(|(candidate, _)| candidate.split('/').next())
		.collect::<std::collections::HashSet<_>>();
	if top_levels.len() >= 3 {
		return None;
	}
	let (candidate, lines) = candidates.first()?;
	(lines.saturating_mul(100) >= total.saturating_mul(50)).then(|| candidate.clone())
}

pub(super) fn extract_path_from_rename(path: &str) -> String {
	let value = path.trim();
	if let Some(brace_start) = value.find('{') {
		if let Some(relative_arrow) = value[brace_start..].find(" => ") {
			let arrow = brace_start + relative_arrow;
			if let Some(relative_end) = value[arrow..].find('}') {
				let brace_end = arrow + relative_end;
				return format!(
					"{}{}{}",
					&value[..brace_start],
					value[arrow + 4..brace_end].trim(),
					&value[brace_end + 1..]
				)
				.trim()
				.to_owned();
			}
		}
		return value.to_owned();
	}
	value
		.split_once(" => ")
		.map_or_else(|| value.to_owned(), |(_, target)| target.trim().to_owned())
}

pub(super) fn extract_components_from_path(file: &str) -> Vec<String> {
	let normalized = file.replace('\\', "/");
	let segments = normalized
		.split('/')
		.filter(|segment| !segment.is_empty())
		.collect::<Vec<_>>();
	let mut meaningful = Vec::new();
	for segment in segments {
		if PLACEHOLDER_DIRS.contains(&segment) || SKIP_DIRS.contains(&segment) {
			continue;
		}
		if segment.starts_with('.') {
			continue;
		}
		if segment.contains('.') {
			continue;
		}
		meaningful.push(segment);
	}
	match meaningful.as_slice() {
		[] => Vec::new(),
		[first] => vec![(*first).to_owned()],
		[first, second, ..] => vec![(*first).to_owned(), format!("{first}/{second}")],
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn preserves_compact_rename_suffixes_and_meaningful_components() {
		assert_eq!(extract_path_from_rename("lib/{old => new}/file.rs"), "lib/new/file.rs");
		assert_eq!(extract_path_from_rename("old/file.rs => new/file.rs"), "new/file.rs");
		assert_eq!(extract_components_from_path("internal/config/parser/json.go"), [
			"config",
			"config/parser"
		]);
		assert_eq!(extract_components_from_path("lib/.git/config"), ["config"]);
	}

	#[test]
	fn omits_scope_for_cross_cutting_changes() {
		let diff = concat!(
			"diff --git a/packages/core/a.ts b/packages/core/a.ts\n+a\n",
			"diff --git a/packages/ui/b.ts b/packages/ui/b.ts\n+b\n",
			"diff --git a/packages/api/c.ts b/packages/api/c.ts\n+c",
		);
		assert_eq!(infer_scope(diff), None);
	}

	#[test]
	fn selects_a_dominant_component_scope() {
		let core = (0..90).map(|_| "+core").collect::<Vec<_>>().join("\n");
		let ui = (0..10).map(|_| "+ui").collect::<Vec<_>>().join("\n");
		let diff = format!(
			"diff --git a/packages/core/a.ts b/packages/core/a.ts\n{core}\ndiff --git \
			 a/packages/ui/b.ts b/packages/ui/b.ts\n{ui}"
		);
		assert_eq!(infer_scope(&diff).as_deref(), Some("core"));
	}
}
