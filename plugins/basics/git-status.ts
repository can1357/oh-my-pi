/**
 * Git Status Hook
 *
 * Injects git status at the start of conversations.
 * Controlled by the 'git-status' feature.
 */

import type { HookAPI } from '@mariozechner/pi-coding-agent'
import runtime from './runtime.json'

export default function (pi: HookAPI) {
   console.log('[git-status] registering hook')
   pi.on('before_agent_start', async (_event, _ctx) => {
      console.log('[git-status] before_agent_start fired')
      // Check if feature is enabled (runtime.features is patched by omp loader)
      const features = (runtime as { features?: string[] }).features ?? []
      console.log('[git-status] features:', features)
      if (!features.includes('git-status')) return

      // Check if we're in a git repo
      const { code: gitCheck } = await pi.exec('git', ['rev-parse', '--is-inside-work-tree'])
      if (gitCheck !== 0) return

      // Get current branch
      const { stdout: currentBranch, code: branchCode } = await pi.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (branchCode !== 0) return

      // Determine main branch (check for 'main' or 'master')
      let mainBranch = 'main'
      const { code: mainExists } = await pi.exec('git', ['rev-parse', '--verify', 'main'], { timeout: 5000 })
      if (mainExists !== 0) {
         const { code: masterExists } = await pi.exec('git', ['rev-parse', '--verify', 'master'], { timeout: 5000 })
         if (masterExists === 0) {
            mainBranch = 'master'
         }
      }

      // Get git status
      const { stdout: gitStatus } = await pi.exec('git', ['status', '--porcelain'])
      const statusText = gitStatus.trim() || '(clean)'

      // Get recent commits
      const { stdout: recentCommits } = await pi.exec('git', ['log', '--oneline', '-5'])

      const content = `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.
Current branch: ${currentBranch.trim()}

Main branch (you will usually use this for PRs): ${mainBranch}

Status:
${statusText}

Recent commits:
${recentCommits.trim() || '(no commits)'}`

      return {
         message: {
            customType: 'git-status',
            content,
            display: true,
            details: {
               currentBranch: currentBranch.trim(),
               mainBranch,
               status: statusText,
               recentCommits: recentCommits.trim(),
            },
         },
      }
   })
}
