use std::{collections::HashSet, sync::LazyLock};

fn get_keywords(sh_mode_only: bool) -> HashSet<&'static str> {
	let mut keywords = HashSet::new();
	keywords.insert("!");
	keywords.insert("{");
	keywords.insert("}");
	keywords.insert("case");
	keywords.insert("do");
	keywords.insert("done");
	keywords.insert("elif");
	keywords.insert("else");
	keywords.insert("esac");
	keywords.insert("fi");
	keywords.insert("for");
	keywords.insert("if");
	keywords.insert("in");
	keywords.insert("then");
	keywords.insert("until");
	keywords.insert("while");

	if !sh_mode_only {
		keywords.insert("[[");
		keywords.insert("]]");
		keywords.insert("coproc");
		keywords.insert("function");
		keywords.insert("select");
		keywords.insert("time");
	}

	keywords
}

pub(crate) static SH_MODE_KEYWORDS: LazyLock<HashSet<&'static str>> =
	LazyLock::new(|| get_keywords(true));
pub(crate) static KEYWORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| get_keywords(false));
