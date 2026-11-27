export type GitlabOp =
	| "repo_view"
	| "file_read"
	| "issue_view"
	| "mr_create"
	| "mr_update"
	| "mr_checkout"
	| "mr_push"
	| "mr_discussions"
	| "mr_note"
	| "mr_discussion_resolve"
	| "search_mrs"
	| "search_issues"
	| "search_code"
	| "search_commits"
	| "search_projects"
	| "pipeline_list"
	| "pipeline_view"
	| "pipeline_watch"
	| "job_log"
	| "job_retry"
	| "ci_lint";

export interface GitlabInput {
	op: GitlabOp;
	repo?: string;
	group?: string;
	ref?: string;
	path?: string;
	mr?: string | string[];
	issue?: string;
	force?: boolean;
	forceWithLease?: boolean;
	title?: string;
	body?: string;
	sourceBranch?: string;
	targetBranch?: string;
	draft?: boolean;
	fill?: boolean;
	removeSourceBranch?: boolean;
	squash?: boolean;
	reviewer?: string[];
	assignee?: string[];
	label?: string[];
	discussionId?: string;
	resolved?: boolean;
	line?: number;
	oldLine?: number;
	resolvable?: boolean;
	internal?: boolean;
	state?: string;
	noteType?: "diff" | "general" | "system" | "all";
	author?: string;
	query?: string;
	since?: string;
	until?: string;
	dateField?: "created" | "updated";
	limit?: number;
	pipeline?: string;
	job?: string;
	tail?: number;
	dryRun?: boolean;
	includeJobs?: boolean;
}

export interface GlUserApi {
	id?: number;
	username?: string;
	name?: string;
	web_url?: string;
}

export interface GlProjectApi {
	id?: number;
	name?: string;
	path_with_namespace?: string;
	description?: string | null;
	visibility?: string;
	default_branch?: string | null;
	web_url?: string;
	http_url_to_repo?: string;
	ssh_url_to_repo?: string;
	star_count?: number;
	forks_count?: number;
	open_issues_count?: number;
	archived?: boolean;
	topics?: string[];
	tag_list?: string[];
	readme_url?: string | null;
	last_activity_at?: string;
}

export interface GlMilestoneApi {
	id?: number;
	iid?: number;
	title?: string;
	state?: string;
	web_url?: string;
}

export interface GlDiffRefsApi {
	base_sha?: string | null;
	head_sha?: string | null;
	start_sha?: string | null;
}

export interface GlPipelineSummaryApi {
	id?: number;
	iid?: number;
	project_id?: number;
	sha?: string;
	ref?: string;
	status?: string;
	source?: string;
	created_at?: string;
	updated_at?: string;
	web_url?: string;
}

export interface GlPipelineApi extends GlPipelineSummaryApi {
	started_at?: string | null;
	finished_at?: string | null;
	duration?: number | null;
	detailed_status?: { text?: string; label?: string } | null;
	user?: GlUserApi | null;
}

export interface GlJobApi {
	id?: number;
	name?: string;
	stage?: string;
	status?: string;
	allow_failure?: boolean;
	failure_reason?: string | null;
	duration?: number | null;
	queued_duration?: number | null;
	started_at?: string | null;
	finished_at?: string | null;
	created_at?: string;
	web_url?: string;
	ref?: string;
	pipeline?: GlPipelineSummaryApi | null;
	runner?: { description?: string } | null;
}

export interface GlBridgeApi {
	id?: number;
	name?: string;
	stage?: string;
	status?: string;
	allow_failure?: boolean;
	duration?: number | null;
	started_at?: string | null;
	finished_at?: string | null;
	web_url?: string;
	downstream_pipeline?: GlPipelineSummaryApi | null;
}

export interface GlMrApi {
	id?: number;
	iid?: number;
	project_id?: number;
	source_project_id?: number;
	target_project_id?: number;
	title?: string;
	description?: string | null;
	state?: string;
	draft?: boolean;
	work_in_progress?: boolean;
	source_branch?: string;
	target_branch?: string;
	sha?: string;
	merge_status?: string;
	detailed_merge_status?: string;
	has_conflicts?: boolean;
	blocking_discussions_resolved?: boolean;
	author?: GlUserApi | null;
	assignees?: GlUserApi[];
	reviewers?: GlUserApi[];
	labels?: string[];
	milestone?: GlMilestoneApi | null;
	diff_refs?: GlDiffRefsApi | null;
	head_pipeline?: GlPipelineSummaryApi | null;
	pipeline?: GlPipelineSummaryApi | null;
	web_url?: string;
	created_at?: string;
	updated_at?: string;
	merged_at?: string | null;
	closed_at?: string | null;
	remove_source_branch?: boolean;
	squash?: boolean;
	allow_collaboration?: boolean;
}

export interface GlApprovalsApi {
	approvals_required?: number;
	approvals_left?: number;
	approved?: boolean;
	approved_by?: Array<{ user?: GlUserApi | null }>;
}

export interface GlNotePositionApi {
	base_sha?: string;
	start_sha?: string;
	head_sha?: string;
	old_path?: string | null;
	new_path?: string | null;
	position_type?: string;
	old_line?: number | null;
	new_line?: number | null;
}

export interface GlNoteApi {
	id?: number;
	type?: string | null;
	body?: string;
	author?: GlUserApi | null;
	created_at?: string;
	updated_at?: string;
	system?: boolean;
	resolvable?: boolean;
	resolved?: boolean;
	resolved_by?: GlUserApi | null;
	internal?: boolean;
	confidential?: boolean;
	position?: GlNotePositionApi | null;
}

export interface GlDiscussionApi {
	id?: string;
	individual_note?: boolean;
	notes?: GlNoteApi[];
}

export interface GlIssueApi {
	id?: number;
	iid?: number;
	project_id?: number;
	title?: string;
	description?: string | null;
	state?: string;
	author?: GlUserApi | null;
	assignees?: GlUserApi[];
	labels?: string[];
	milestone?: GlMilestoneApi | null;
	confidential?: boolean;
	issue_type?: string;
	web_url?: string;
	created_at?: string;
	updated_at?: string;
	closed_at?: string | null;
}

export interface GlTreeEntryApi {
	id?: string;
	name?: string;
	type?: "tree" | "blob" | "commit" | string;
	path?: string;
	mode?: string;
}

export interface GlFileApi {
	file_name?: string;
	file_path?: string;
	size?: number;
	encoding?: string;
	content?: string;
	content_sha256?: string;
	ref?: string;
	blob_id?: string;
	commit_id?: string;
}

export interface GlSearchCodeItemApi {
	basename?: string;
	data?: string;
	path?: string;
	filename?: string;
	id?: string | null;
	ref?: string;
	startline?: number;
	project_id?: number;
}

export interface GlSearchCommitItemApi {
	id?: string;
	short_id?: string;
	title?: string;
	message?: string;
	author_name?: string;
	author_email?: string;
	authored_date?: string;
	committed_date?: string;
	web_url?: string;
	project_id?: number;
}
