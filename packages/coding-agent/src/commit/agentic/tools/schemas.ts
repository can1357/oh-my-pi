import { type } from "@oh-my-pi/omptype";

export const commitTypeSchema = type(
	"'feat' | 'fix' | 'refactor' | 'perf' | 'docs' | 'test' | 'build' | 'ci' | 'chore' | 'style' | 'revert'",
);

export const detailSchema = type({
	text: "string",
	"changelog_category?": "'Added' | 'Changed' | 'Fixed' | 'Deprecated' | 'Removed' | 'Security' | 'Breaking Changes'",
	"user_visible?": "boolean",
});
