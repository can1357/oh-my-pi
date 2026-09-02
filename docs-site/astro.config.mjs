// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
/** @import { Element, Root } from 'hast'; */

// https://astro.build/config

// GitHub Pages serves this site under the project path (/oh-my-pi/), so every
// internal URL needs the `base` prefix. Astro/Starlight auto-prefixes the
// links it generates (sidebar, pagination, processed assets). Authored
// markdown links must include the prefix explicitly because no rehype
// pipeline runs over Starlight's content collections with this configuration.

export default defineConfig({
	site: 'https://nibblebot.github.io',
	base: '/oh-my-pi/',
	integrations: [
		starlight({
			title: 'omp',
			description: 'Documentation for omp, the coding agent with the IDE wired in.',
			logo: {
				dark: './src/assets/logo.svg',
				light: './src/assets/logo-light.svg',
				alt: 'omp',
				replacesTitle: true,
			},
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/can1357/oh-my-pi' }],
			components: {
				PageTitle: './src/components/PageTitle.astro',
			},
			editLink: {
				baseUrl: 'https://github.com/nibblebot/oh-my-pi/edit/docs/docs-site/',
			},
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quickstart', slug: 'getting-started/quickstart' },
						{ label: 'Your First Session', slug: 'getting-started/first-session' },
					],
				},
				{
					label: 'Configuration',
					items: [
						{ label: 'Settings', slug: 'configuration/settings' },
						{ label: 'Environment Variables', slug: 'configuration/environment-variables' },
						{ label: 'Keybindings', slug: 'configuration/keybindings' },
						{ label: 'Themes', slug: 'configuration/themes' },
						{ label: 'Context Files & Rules', slug: 'configuration/context-files' },
						{ label: 'System Prompt', slug: 'configuration/system-prompt' },
						{ label: 'Approval Modes', slug: 'configuration/approvals' },
					],
				},
				{
					label: 'Models & Providers',
					items: [
						{ label: 'Providers', slug: 'models/providers' },
						{ label: 'Model Roles & Routing', slug: 'models/model-roles' },
						{ label: 'Local Models', slug: 'models/local-models' },
					],
				},
				{
					label: 'Essentials',
					items: [
						{ label: 'Sessions', slug: 'features/sessions' },
						{ label: 'Built-in Tools', slug: 'features/tools' },
						{ label: 'Subagents', slug: 'features/subagents' },
						{ label: 'Memory', slug: 'features/memory' },
					],
				},
				{
					label: 'Coding',
					items: [
						{ label: 'Code Intelligence', slug: 'features/code-intelligence' },
						{ label: 'Code Execution', slug: 'features/code-execution' },
						{ label: 'Debugging', slug: 'features/debugging' },
					],
				},
				{
					label: 'Workflow',
					items: [
						{ label: 'Compaction', slug: 'features/compaction' },
						{ label: 'Code Review', slug: 'features/code-review' },
						{ label: 'Atomic Commits', slug: 'features/atomic-commits' },
						{ label: 'Security Scanning', slug: 'features/security' },
						{ label: 'Cleanse', slug: 'features/cleanse' },
						{ label: 'Auto-research', slug: 'features/autoresearch' },
						{ label: 'Magic Keywords', slug: 'features/magic-keywords' },
						{ label: 'ultrathink', slug: 'features/magic-ultrathink' },
						{ label: 'orchestrate', slug: 'features/magic-orchestrate' },
						{ label: 'workflowz', slug: 'features/magic-workflowz' },
						{ label: 'Stream Rules', slug: 'features/stream-rules' },
					],
				},
				{
					label: 'Modes',
					items: [
						{ label: 'Plan Mode', slug: 'modes/plan-mode' },
						{ label: 'Goal Mode', slug: 'modes/goal-mode' },
						{ label: 'Vibe Mode', slug: 'features/vibe-mode' },
						{ label: 'Loop Mode', slug: 'modes/loop-mode' },
						{ label: 'Queue Mode', slug: 'modes/queue-mode' },
						{ label: 'Editor Integration', slug: 'features/editor-integration' },
						{ label: 'Merge Conflict Resolution', slug: 'features/merge-conflicts' },
						{ label: 'Live Collaboration', slug: 'features/collab' },
						{ label: 'GitHub Integration', slug: 'features/github' },
					],
				},
				{
					label: 'Integrations',
					items: [
						{ label: 'Web Search & Reading', slug: 'features/web-search' },
						{ label: 'Browser & App Automation', slug: 'features/browser' },
						{ label: 'Computer Use', slug: 'features/computer-use' },
						{ label: 'SSH Remote Hosts', slug: 'features/ssh' },
						{ label: 'Voice (STT/TTS)', slug: 'features/voice' },
						{ label: 'Live Voice', slug: 'features/live-voice' },
						{ label: 'Usage Statistics', slug: 'features/stats' },
						{ label: 'The Advisor', slug: 'features/advisor' },
					],
				},
				{
					label: 'Extending omp',
					items: [
						{ label: 'Skills', slug: 'extending/skills' },
						{ label: 'Extensions', slug: 'extending/extensions' },
						{ label: 'MCP Servers', slug: 'extending/mcp' },
						{ label: 'Hooks', slug: 'extending/hooks' },
						{ label: 'Custom Tools', slug: 'extending/custom-tools' },
						{ label: 'Plugins & Marketplaces', slug: 'extending/plugins' },
						{ label: 'SDK', slug: 'extending/sdk' },
						{ label: 'RPC', slug: 'extending/rpc' },
						{ label: 'RPC vs SDK', slug: 'extending/rpc-vs-sdk' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Steering the Agent', slug: 'guides/steering-the-agent' },
						{ label: 'Workflow Recipes', slug: 'guides/workflow-recipes' },
						{ label: 'Multi-Agent Workflows', slug: 'guides/multi-agent' },
						{ label: 'Automation & Headless', slug: 'guides/automation-headless' },
						{ label: 'Choosing Extension Points', slug: 'guides/choosing-extension-points' },
						{ label: 'Internal URLs', slug: 'guides/internal-urls' },
						{ label: 'Architecture', slug: 'guides/architecture' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'CLI Reference', slug: 'reference/cli' },
						{ label: 'Slash Commands', slug: 'reference/slash-commands' },
						{ label: 'Configuration Reference', slug: 'reference/configuration' },
						{ label: 'Session Logs', slug: 'reference/session-logs' },
						{ label: 'The ~/.omp Directory', slug: 'reference/data-directory' },
						{ label: 'Settings — Models', slug: 'reference/settings/models' },
						{ label: 'Settings — Generation', slug: 'reference/settings/generation' },
						{ label: 'Settings — Tools', slug: 'reference/settings/tools' },
						{ label: 'Settings — Context', slug: 'reference/settings/context' },
						{ label: 'Settings — Interface', slug: 'reference/settings/interface' },
						{ label: 'Settings — Interaction', slug: 'reference/settings/interaction' },
						{ label: 'Settings — Providers', slug: 'reference/settings/providers' },
						{ label: 'Settings — Tasks', slug: 'reference/settings/tasks' },
						{ label: 'Settings — General', slug: 'reference/settings/general' },
					],
				},
				{
					label: 'About',
					items: [{ label: 'Coverage Badges', slug: 'about/coverage' }],
				},
			],
		}),
	],
});
