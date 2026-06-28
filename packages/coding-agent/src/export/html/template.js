    (function() {
      'use strict';

      // ============================================================
      // BOOT
      // ============================================================
      //
      // Two boot paths share this template:
      //  - Static export: session JSON rides base64-embedded in #session-data.
      //  - Share viewer: share-loader.js sets `window.__OMP_SESSION_DATA__` to
      //    a promise resolving to the session JSON (fetched + decrypted).
      // The entire app lives in bootSession(); its body keeps the original
      // one-level indentation to avoid a whole-file reindent.
      function bootSession(data) {
      const { header, entries, leafId: defaultLeafId, systemPrompt, tools, subSessions } = data;

      // Session render context: scopes entry lookups and tool-view host
      // wiring to one transcript (main session or an embedded subagent).
      const mainSctx = { entries, prefix: '', idPrefix: 'entry-' };

      // ============================================================
      // URL PARAMETER HANDLING
      // ============================================================

      // Parse URL parameters for deep linking: leafId and targetId
      // Check for injected params (when loaded in iframe via srcdoc) or use window.location
      const injectedParams = document.querySelector('meta[name="pi-url-params"]');
      const searchString = injectedParams ? injectedParams.content : window.location.search.substring(1);
      const urlParams = new URLSearchParams(searchString);
      const urlLeafId = urlParams.get('leafId');
      const urlTargetId = urlParams.get('targetId');
      // Use URL leafId if provided, otherwise fall back to session default
      const leafId = urlLeafId || defaultLeafId;

      // ============================================================
      // DATA STRUCTURES
      // ============================================================

      // Entry lookup by ID
      const byId = new Map();
      for (const entry of entries) {
        byId.set(entry.id, entry);
      }

      // Tool call lookup (toolCallId -> {name, arguments})
      const toolCallMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'message' && entry.message.role === 'assistant') {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'toolCall') {
                toolCallMap.set(block.id, { name: block.name, arguments: block.arguments });
              }
            }
          }
        }
      }

      // Label lookup (entryId -> label string)
      // Labels are stored in 'label' entries that reference their target via targetId
      const labelMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'label' && entry.targetId && entry.label) {
          labelMap.set(entry.targetId, entry.label);
        }
      }

      // ============================================================
      // TREE DATA PREPARATION (no DOM, pure data)
      // ============================================================

      /**
       * Build tree structure from flat entries.
       * Returns array of root nodes, each with { entry, children, label }.
       */
      function buildTree() {
        const nodeMap = new Map();
        const roots = [];

        // Create nodes
        for (const entry of entries) {
          nodeMap.set(entry.id, { 
            entry, 
            children: [],
            label: labelMap.get(entry.id)
          });
        }

        // Build parent-child relationships
        for (const entry of entries) {
          const node = nodeMap.get(entry.id);
          if (entry.parentId === null || entry.parentId === undefined || entry.parentId === entry.id) {
            roots.push(node);
          } else {
            const parent = nodeMap.get(entry.parentId);
            if (parent) {
              parent.children.push(node);
            } else {
              roots.push(node);
            }
          }
        }

        // Sort children by timestamp
        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }
        roots.forEach(sortChildren);

        return roots;
      }

      /**
       * Build set of entry IDs on path from root to target.
       */
      function buildActivePathIds(targetId) {
        const ids = new Set();
        let current = byId.get(targetId);
        while (current) {
          ids.add(current.id);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return ids;
      }

      /**
       * Get array of entries from root to target (the conversation path).
       */
      function getPath(targetId) {
        const path = [];
        let current = byId.get(targetId);
        while (current) {
          path.unshift(current);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return path;
      }

      /**
       * Flatten tree into list with indentation and connector info.
       * Returns array of { node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots }.
       * Matches tree-selector.ts logic exactly.
       */
      function flattenTree(roots, activePathIds) {
        const result = [];
        const multipleRoots = roots.length > 1;

        // Mark which subtrees contain the active leaf
        const containsActive = new Map();
        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }
        roots.forEach(markActive);

        // Stack: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
        const stack = [];

        // Add roots (prioritize branch containing active leaf)
        const orderedRoots = [...roots].sort((a, b) => 
          Number(containsActive.get(b)) - Number(containsActive.get(a))
        );
        for (let i = orderedRoots.length - 1; i >= 0; i--) {
          const isLast = i === orderedRoots.length - 1;
          stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
        }

        while (stack.length > 0) {
          const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();

          result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots });

          const children = node.children;
          const multipleChildren = children.length > 1;

          // Order children (active branch first)
          const orderedChildren = [...children].sort((a, b) => 
            Number(containsActive.get(b)) - Number(containsActive.get(a))
          );

          // Calculate child indent (matches tree-selector.ts)
          let childIndent;
          if (multipleChildren) {
            // Parent branches: children get +1
            childIndent = indent + 1;
          } else if (justBranched && indent > 0) {
            // First generation after a branch: +1 for visual grouping
            childIndent = indent + 1;
          } else {
            // Single-child chain: stay flat
            childIndent = indent;
          }

          // Build gutters for children
          const connectorDisplayed = showConnector && !isVirtualRootChild;
          const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
          const connectorPosition = Math.max(0, currentDisplayIndent - 1);
          const childGutters = connectorDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

          // Add children in reverse order for stack
          for (let i = orderedChildren.length - 1; i >= 0; i--) {
            const childIsLast = i === orderedChildren.length - 1;
            stack.push([orderedChildren[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false]);
          }
        }

        return result;
      }

      /**
       * Build ASCII prefix string for tree node.
       */
      function buildTreePrefix(flatNode) {
        const { indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots } = flatNode;
        const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connector = showConnector && !isVirtualRootChild ? (isLast ? '└─ ' : '├─ ') : '';
        const connectorPosition = connector ? displayIndent - 1 : -1;
        // Chain rows (no connector of their own) under a last-sibling (`└─`)
        // branch stay anchored by a vertical drawn one level right of the
        // suppressed gutter — below the branch head's content — never in the
        // `└─` corner column itself (#2298, #2325). Chains under `├─` heads
        // are already anchored by the sibling line (`show: true` gutter).
        const nearestGutter = !connector ? gutters[gutters.length - 1] : undefined;
        const chainAnchorLevel = nearestGutter && !nearestGutter.show ? nearestGutter.position + 1 : -1;

        const totalChars = displayIndent * 3;
        const prefixChars = [];
        for (let i = 0; i < totalChars; i++) {
          const level = Math.floor(i / 3);
          const posInLevel = i % 3;

          const gutter = gutters.find(g => g.position === level);
          if (gutter) {
            // Standard tree semantics: `│` only while more siblings continue
            // below (`show`), space below a `└─`.
            prefixChars.push(posInLevel === 0 && gutter.show ? '│' : ' ');
          } else if (level === chainAnchorLevel) {
            // Chain anchor for rows under a `└─` branch head.
            prefixChars.push(posInLevel === 0 ? '│' : ' ');
          } else if (connector && level === connectorPosition) {
            if (posInLevel === 0) {
              prefixChars.push(isLast ? '└' : '├');
            } else if (posInLevel === 1) {
              prefixChars.push('─');
            } else {
              prefixChars.push(' ');
            }
          } else {
            prefixChars.push(' ');
          }
        }
        return prefixChars.join('');
      }

      // ============================================================
      // FILTERING (pure data)
      // ============================================================

      let filterMode = 'default';
      let searchQuery = '';

      function hasTextContent(content) {
        if (typeof content === 'string') return Boolean(canonicalizeMessage(content));
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text) {
              if (canonicalizeMessage(c.text)) return true;
            }
          }
        }
        return false;
      }

      function extractContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('');
        }
        return '';
      }

      function getSearchableText(entry, label) {
        const parts = [];
        if (label) parts.push(label);

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            parts.push(msg.role);
            if (msg.content) parts.push(extractContent(msg.content));
            if (msg.role === 'bashExecution' && msg.command) parts.push(msg.command);
            if (msg.role === 'jsExecution' && msg.code) parts.push(msg.code);
            break;
          }
          case 'custom_message':
            parts.push(entry.customType);
            parts.push(typeof entry.content === 'string' ? entry.content : extractContent(entry.content));
            break;
          case 'compaction':
            parts.push('compaction');
            break;
          case 'branch_summary':
            parts.push('branch summary', entry.summary);
            break;
          case 'model_change':
            parts.push('model', entry.model);
            break;
          case 'thinking_level_change':
            parts.push('thinking', entry.thinkingLevel);
            break;
          case 'mode_change':
            parts.push('mode', entry.mode);
            break;
        }

        return parts.join(' ').toLowerCase();
      }

      /**
       * Filter flat nodes based on current filterMode and searchQuery.
       */
      function filterNodes(flatNodes, currentLeafId) {
        const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

        return flatNodes.filter(flatNode => {
          const entry = flatNode.node.entry;
          const label = flatNode.node.label;
          const isCurrentLeaf = entry.id === currentLeafId;

          // Always show current leaf
          if (isCurrentLeaf) return true;

          // Hide assistant messages with only tool calls (no text) unless error/aborted
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            const msg = entry.message;
            const hasText = hasTextContent(msg.content);
            const isErrorOrAborted = msg.stopReason && msg.stopReason !== 'stop' && msg.stopReason !== 'toolUse';
            if (!hasText && !isErrorOrAborted) return false;
          }

          // Apply filter mode
          const isSettingsEntry = ['label', 'custom', 'model_change', 'thinking_level_change', 'mode_change', 'ttsr_injection', 'session_init'].includes(entry.type);
          let passesFilter = true;

          switch (filterMode) {
            case 'user-only':
              passesFilter = entry.type === 'message' && entry.message.role === 'user';
              break;
            case 'no-tools':
              passesFilter = !isSettingsEntry && !(entry.type === 'message' && entry.message.role === 'toolResult');
              break;
            case 'labeled-only':
              passesFilter = label !== undefined;
              break;
            case 'all':
              passesFilter = true;
              break;
            default: // 'default'
              passesFilter = !isSettingsEntry;
              break;
          }

          if (!passesFilter) return false;

          // Apply search filter
          if (searchTokens.length > 0) {
            const nodeText = getSearchableText(entry, label);
            if (!searchTokens.every(t => nodeText.includes(t))) return false;
          }

          return true;
        });
      }

      // ============================================================
      // TREE DISPLAY TEXT (pure data -> string)
      // ============================================================

      function shortenPath(p) {
        if (typeof p !== 'string') return '';
        if (p.startsWith('/Users/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/Users/' + parts[2]).length);
        }
        if (p.startsWith('/home/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/home/' + parts[2]).length);
        }
        return p;
      }

      function formatToolCall(name, args) {
        switch (name) {
          case 'read': {
            const path = shortenPath(String(args.path || args.file_path || ''));
            const offset = args.offset;
            const limit = args.limit;
            let display = path;
            if (offset !== undefined || limit !== undefined) {
              const start = offset ?? 1;
              const end = limit !== undefined ? start + limit - 1 : '';
              display += `:${start}${end ? `-${end}` : ''}`;
            }
            return `[read: ${display}]`;
          }
          case 'write':
            return `[write: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'edit':
            return `[edit: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'bash': {
            const rawCmd = String(args.command || '');
            const cmd = rawCmd.replace(/[\n\t]/g, ' ').trim().slice(0, 50);
            return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`;
          }
          case 'search':
          case 'grep':
            return `[grep: /${args.pattern || ''}/ in ${shortenPath(String((args.paths || [args.path || '.']).join(', ')))}]`;
          case 'find':
          case 'glob':
            return `[glob: ${shortenPath(String((args.paths || [args.pattern || '.']).join(', ')))}]`;
          case 'ls':
            return `[ls: ${shortenPath(String(args.path || '.'))}]`;
          default: {
            const argsStr = JSON.stringify(args).slice(0, 40);
            return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? '...' : ''}]`;
          }
        }
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      function canonicalizeMessage(text) {
        if (!text) return '';
        const trimmed = text.trim();
        for (let i = 0; i < trimmed.length; i++) {
          const code = trimmed.charCodeAt(i);
          if (code !== 0x2e && code !== 0x2026 && code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
            return trimmed;
          }
        }
        return '';
      }

      /**
       * Truncate string to maxLen chars, append "..." if truncated.
       */
      function truncate(s, maxLen = 100) {
        if (s.length <= maxLen) return s;
        return s.slice(0, maxLen) + '...';
      }

      /**
       * Get display text for tree node (returns HTML string).
       */
      function getTreeNodeDisplayHtml(entry, label) {
        const normalize = s => s.replace(/[\n\t]/g, ' ').trim();
        const labelHtml = label ? `<span class="tree-label">[${escapeHtml(label)}]</span> ` : '';

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            if (msg.role === 'user') {
              const content = truncate(normalize(extractContent(msg.content)));
              return labelHtml + `<span class="tree-role-user">user:</span> ${escapeHtml(content)}`;
            }
            if (msg.role === 'developer') {
              const content = truncate(normalize(extractContent(msg.content)));
              return labelHtml + `<span class="tree-role-developer">developer:</span> ${escapeHtml(content)}`;
            }
            if (msg.role === 'assistant') {
              const textContent = truncate(normalize(extractContent(msg.content)));
              if (textContent) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> ${escapeHtml(textContent)}`;
              }
              if (msg.stopReason === 'aborted') {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(aborted)</span>`;
              }
              if (msg.errorMessage) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-error">${escapeHtml(truncate(msg.errorMessage))}</span>`;
              }
              return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(no text)</span>`;
            }
            if (msg.role === 'toolResult') {
              const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : null;
              if (toolCall) {
                return labelHtml + `<span class="tree-role-tool">${escapeHtml(formatToolCall(toolCall.name, toolCall.arguments))}</span>`;
              }
              return labelHtml + `<span class="tree-role-tool">[${msg.toolName || 'tool'}]</span>`;
            }
            if (msg.role === 'bashExecution') {
              const cmd = truncate(normalize(msg.command || ''));
              return labelHtml + `<span class="tree-role-tool">[bash]:</span> ${escapeHtml(cmd)}`;
            }
            if (msg.role === 'jsExecution') {
              const code = truncate(normalize(msg.code || ''));
              return labelHtml + `<span class="tree-role-tool">[js]:</span> ${escapeHtml(code)}`;
            }
            return labelHtml + `<span class="tree-muted">[${msg.role}]</span>`;
          }
          case 'compaction':
            return labelHtml + `<span class="tree-compaction">[compaction: ${Math.round(entry.tokensBefore/1000)}k tokens]</span>`;
          case 'branch_summary': {
            const summary = truncate(normalize(entry.summary || ''));
            return labelHtml + `<span class="tree-branch-summary">[branch summary]:</span> ${escapeHtml(summary)}`;
          }
          case 'custom_message': {
            const content = typeof entry.content === 'string' ? entry.content : extractContent(entry.content);
            return labelHtml + `<span class="tree-custom">[${escapeHtml(entry.customType)}]:</span> ${escapeHtml(truncate(normalize(content)))}`;
          }
          case 'model_change':
            return labelHtml + `<span class="tree-muted">[model: ${escapeHtml(entry.model)}]</span>`;
          case 'thinking_level_change':
            return labelHtml + `<span class="tree-muted">[thinking: ${entry.thinkingLevel}]</span>`;
          case 'mode_change':
            return labelHtml + `<span class="tree-muted">[mode: ${escapeHtml(entry.mode)}]</span>`;
          default:
            return labelHtml + `<span class="tree-muted">[${entry.type}]</span>`;
        }
      }

      // ============================================================
      // TREE RENDERING (DOM manipulation)
      // ============================================================

      let currentLeafId = leafId;
      let currentTargetId = urlTargetId || leafId;
      let treeRendered = false;

      function renderTree() {
        const tree = buildTree();
        const activePathIds = buildActivePathIds(currentLeafId);
        const flatNodes = flattenTree(tree, activePathIds);
        const filtered = filterNodes(flatNodes, currentLeafId);
        const container = document.getElementById('tree-container');

        // Full render only on first call or when filter/search changes
        if (!treeRendered) {
          container.innerHTML = '';

          for (const flatNode of filtered) {
            const entry = flatNode.node.entry;
            const isOnPath = activePathIds.has(entry.id);
            const isTarget = entry.id === currentTargetId;

            const div = document.createElement('div');
            div.className = 'tree-node';
            if (isOnPath) div.classList.add('in-path');
            if (isTarget) div.classList.add('active');
            div.dataset.id = entry.id;

            const prefix = buildTreePrefix(flatNode);
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'tree-prefix';
            prefixSpan.textContent = prefix;

            const marker = document.createElement('span');
            marker.className = 'tree-marker';
            marker.textContent = isOnPath ? '•' : ' ';

            const content = document.createElement('span');
            content.className = 'tree-content';
            content.innerHTML = getTreeNodeDisplayHtml(entry, flatNode.node.label);

            div.appendChild(prefixSpan);
            div.appendChild(marker);
            div.appendChild(content);
            div.addEventListener('click', () => navigateTo(entry.id));

            container.appendChild(div);
          }

          treeRendered = true;
        } else {
          // Just update markers and classes
          const nodes = container.querySelectorAll('.tree-node');
          for (const node of nodes) {
            const id = node.dataset.id;
            const isOnPath = activePathIds.has(id);
            const isTarget = id === currentTargetId;

            node.classList.toggle('in-path', isOnPath);
            node.classList.toggle('active', isTarget);

            const marker = node.querySelector('.tree-marker');
            if (marker) {
              marker.textContent = isOnPath ? '•' : ' ';
            }
          }
        }

        document.getElementById('tree-status').textContent = `${filtered.length} / ${flatNodes.length} entries`;

        // Scroll active node into view after layout
        setTimeout(() => {
          const activeNode = container.querySelector('.tree-node.active');
          if (activeNode) {
            activeNode.scrollIntoView({ block: 'nearest' });
          }
        }, 0);
      }

      function forceTreeRerender() {
        treeRendered = false;
        renderTree();
      }

      // ============================================================
      // MESSAGE RENDERING
      // ============================================================

      function formatTokens(count) {
        if (count < 1000) return count.toString();
        if (count < 10000) return (count / 1000).toFixed(1) + 'k';
        if (count < 1000000) return Math.round(count / 1000) + 'k';
        return (count / 1000000).toFixed(1) + 'M';
      }

      function formatTimestamp(ts) {
        if (!ts) return '';
        const date = new Date(ts);
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      function replaceTabs(text) {
        return text.replace(/\t/g, '   ');
      }

      function findToolResult(toolCallId, entryList) {
        for (const entry of entryList) {
          if (entry.type === 'message' && entry.message.role === 'toolResult') {
            if (entry.message.toolCallId === toolCallId) {
              return entry.message;
            }
          }
        }
        return null;
      }

      function formatExpandableOutput(text, maxLines, lang) {
        text = replaceTabs(text);
        const lines = text.split('\n');
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;

        if (lang) {
          let highlighted;
          try {
            highlighted = hljs.highlight(text, { language: lang }).value;
          } catch {
            highlighted = escapeHtml(text);
          }

          if (remaining > 0) {
            const previewCode = displayLines.join('\n');
            let previewHighlighted;
            try {
              previewHighlighted = hljs.highlight(previewCode, { language: lang }).value;
            } catch {
              previewHighlighted = escapeHtml(previewCode);
            }

            return `<div class="tool-output expandable" onclick="this.classList.toggle('expanded')">
              <div class="output-preview"><pre><code class="hljs">${previewHighlighted}</code></pre>
              <div class="expand-hint">... (${remaining} more lines)</div></div>
              <div class="output-full"><pre><code class="hljs">${highlighted}</code></pre></div></div>`;
          }

          return `<div class="tool-output"><pre><code class="hljs">${highlighted}</code></pre></div>`;
        }

        // Plain text output
        if (remaining > 0) {
          let out = '<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
          out += '<div class="output-preview">';
          for (const line of displayLines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += `<div class="expand-hint">... (${remaining} more lines)</div></div>`;
          out += '<div class="output-full">';
          for (const line of lines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += '</div></div>';
          return out;
        }

        let out = '<div class="tool-output">';
        for (const line of displayLines) {
          out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
        }
        out += '</div>';
        return out;
      }

      // ============================================================
      // TOOL CALL RENDERING
      // ============================================================
      //
      // Tool calls render through the bundled <omp-tool-view> web component
      // (tool-views.generated.js — the same React renderers collab-web uses).
      // Payloads are handed over via a global store keyed by data-key, which
      // survives innerHTML serialization and cloneNode round trips.

      const TOOL_VIEW_DATA = new Map();
      globalThis.__OMP_TOOL_VIEW_DATA = TOOL_VIEW_DATA;
      let toolViewSeq = 0;

      function renderToolCall(call, sctx) {
        const result = findToolResult(call.id, sctx.entries);
        const statusClass = result ? (result.isError ? 'error' : 'success') : 'pending';
        const key = 'tv' + (++toolViewSeq);
        TOOL_VIEW_DATA.set(key, {
          name: call.name,
          args: call.arguments || {},
          result: result || undefined,
          host: {
            hasAgent: (id) => !!lookupSubSession(sctx.prefix, id),
            openAgent: (id) => openSubSession(joinKey(sctx.prefix, id)),
          },
        });
        return '<omp-tool-view class="tool-execution ' + statusClass + '" data-key="' + key + '" open></omp-tool-view>';
      }

      // ============================================================
      // SUB-SESSION OVERLAY
      // ============================================================
      //
      // Task tool cards expose agent chips (wired through the payload `host`
      // above); clicking one opens that subagent's transcript in a stacked
      // overlay. Keys are slash-joined agent ids relative to the main
      // session: top-level agent 'ToolAsk', its child 'ToolAsk/Helper'.

      function joinKey(prefix, id) {
        return prefix ? prefix + '/' + id : id;
      }

      function lookupSubSession(prefix, id) {
        return subSessions ? subSessions[joinKey(prefix, id)] : undefined;
      }

      // Render context per sub-session (entries scoped to that transcript).
      const subSctxCache = new Map();
      function getSubSctx(key) {
        let sctx = subSctxCache.get(key);
        if (!sctx) {
          sctx = {
            entries: subSessions[key].entries,
            prefix: key,
            idPrefix: 'sub-' + key.replace(/[^A-Za-z0-9_-]/g, '_') + '-entry-',
          };
          subSctxCache.set(key, sctx);
        }
        return sctx;
      }

      /**
       * Root-to-leaf path through an arbitrary entry list (subagent
       * transcripts are linear chains; same parent-walk as getPath).
       */
      function getPathIn(entryList, targetId) {
        const map = new Map();
        for (const e of entryList) map.set(e.id, e);
        let current = targetId ? map.get(targetId) : undefined;
        if (!current && entryList.length > 0) current = entryList[entryList.length - 1];
        const path = [];
        while (current) {
          path.unshift(current);
          if (!current.parentId || current.parentId === current.id) break;
          current = map.get(current.parentId);
        }
        return path;
      }

      const overlayStack = [];               // slash-joined keys, root-first chain
      const subSessionBodyCache = new Map(); // key -> rendered body element
      let subOverlayEl = null;
      let subOverlayLastFocus = null;

      function ensureSubOverlay() {
        if (subOverlayEl) return subOverlayEl;
        subOverlayEl = document.createElement('div');
        subOverlayEl.id = 'subsession-overlay';
        subOverlayEl.innerHTML = `
          <div class="subsession-backdrop"></div>
          <div class="subsession-panel" role="dialog" aria-modal="true" aria-label="Subagent session" tabindex="-1">
            <div class="subsession-header">
              <nav class="subsession-breadcrumb" aria-label="Subagent breadcrumb"></nav>
              <button type="button" class="subsession-close" title="Close (Esc)" aria-label="Close subagent view">&times;</button>
            </div>
            <div class="subsession-meta"></div>
            <div class="subsession-body"></div>
          </div>`;
        subOverlayEl.querySelector('.subsession-backdrop').addEventListener('click', popSubSession);
        subOverlayEl.querySelector('.subsession-close').addEventListener('click', closeAllSubSessions);
        document.body.appendChild(subOverlayEl);
        return subOverlayEl;
      }

      function buildSubSessionBody(key) {
        let body = subSessionBodyCache.get(key);
        if (body) return body;
        const sub = subSessions[key];
        const sctx = getSubSctx(key);
        body = document.createElement('div');
        body.className = 'subsession-messages';
        for (const entry of getPathIn(sub.entries, sub.leafId)) {
          const node = renderEntryToNode(entry, sctx);
          if (node) body.appendChild(node);
        }
        if (!body.firstChild) {
          const empty = document.createElement('div');
          empty.className = 'subsession-empty';
          empty.textContent = '(no renderable entries)';
          body.appendChild(empty);
        }
        subSessionBodyCache.set(key, body);
        return body;
      }

      function subSessionMetaText(key) {
        const sub = subSessions[key];
        const stats = computeStats(sub.entries);
        const parts = [];
        if (stats.models.length > 0) parts.push(stats.models.join(', '));
        parts.push(sub.entries.length + (sub.entries.length === 1 ? ' entry' : ' entries'));
        return parts.join(' · ');
      }

      function renderSubOverlay() {
        const key = overlayStack[overlayStack.length - 1];
        const el = ensureSubOverlay();

        const crumbs = el.querySelector('.subsession-breadcrumb');
        crumbs.innerHTML = '';
        const segments = key.split('/');
        for (let i = 0; i < segments.length; i++) {
          if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'subsession-crumb-sep';
            sep.textContent = '›';
            crumbs.appendChild(sep);
          }
          if (i === segments.length - 1) {
            const span = document.createElement('span');
            span.className = 'subsession-crumb current';
            span.textContent = segments[i];
            crumbs.appendChild(span);
          } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'subsession-crumb';
            btn.textContent = segments[i];
            const ancestorKey = segments.slice(0, i + 1).join('/');
            btn.addEventListener('click', () => popSubSessionTo(ancestorKey));
            crumbs.appendChild(btn);
          }
        }

        el.querySelector('.subsession-meta').textContent = subSessionMetaText(key);

        const bodyHost = el.querySelector('.subsession-body');
        bodyHost.innerHTML = '';
        bodyHost.appendChild(buildSubSessionBody(key));
        bodyHost.scrollTop = 0;

        el.classList.add('open');
        el.querySelector('.subsession-panel').focus();
      }

      function openSubSession(key) {
        if (!subSessions || !subSessions[key]) return;
        if (overlayStack.length === 0) {
          subOverlayLastFocus = document.activeElement;
        }
        overlayStack.push(key);
        renderSubOverlay();
      }

      function popSubSession() {
        if (overlayStack.length === 0) return;
        overlayStack.pop();
        if (overlayStack.length === 0) {
          hideSubOverlay();
        } else {
          renderSubOverlay();
        }
      }

      function popSubSessionTo(key) {
        // Rebuild the chain root..key (the stack is always a prefix chain).
        const segments = key.split('/');
        overlayStack.length = 0;
        for (let i = 1; i <= segments.length; i++) {
          overlayStack.push(segments.slice(0, i).join('/'));
        }
        renderSubOverlay();
      }

      function closeAllSubSessions() {
        if (overlayStack.length === 0) return;
        overlayStack.length = 0;
        hideSubOverlay();
      }

      function hideSubOverlay() {
        if (subOverlayEl) {
          subOverlayEl.classList.remove('open');
          subOverlayEl.querySelector('.subsession-body').innerHTML = '';
        }
        if (subOverlayLastFocus && typeof subOverlayLastFocus.focus === 'function') {
          subOverlayLastFocus.focus();
        }
        subOverlayLastFocus = null;
      }


      /**
       * Build a shareable URL for a specific message.
       * URL format: base?gistId&leafId=<leafId>&targetId=<entryId>
       */
      function buildShareUrl(entryId) {
        // Check for injected base URL (used when loaded in iframe via srcdoc)
        const baseUrlMeta = document.querySelector('meta[name="pi-share-base-url"]');
        const baseUrl = baseUrlMeta ? baseUrlMeta.content : window.location.href.split('?')[0];

        const url = new URL(window.location.href);
        // Find the gist ID (first query param without value, e.g., ?abc123)
        const gistId = Array.from(url.searchParams.keys()).find(k => !url.searchParams.get(k));

        // Build the share URL
        const params = new URLSearchParams();
        params.set('leafId', currentLeafId);
        params.set('targetId', entryId);

        // If we have an injected base URL (iframe context), use it directly
        if (baseUrlMeta) {
          return `${baseUrl}&${params.toString()}`;
        }

        // Otherwise build from current location (direct file access)
        url.search = gistId ? `?${gistId}&${params.toString()}` : `?${params.toString()}`;
        return url.toString();
      }

      /**
       * Copy text to clipboard with visual feedback.
       * Uses navigator.clipboard with fallback to execCommand for HTTP contexts.
       */
      async function copyToClipboard(text, button) {
        let success = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            success = true;
          }
        } catch {
          // Clipboard API failed, try fallback
        }

        // Fallback for HTTP or when Clipboard API is unavailable
        if (!success) {
          try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            success = document.execCommand('copy');
            document.body.removeChild(textarea);
          } catch {
          }
        }

        if (success && button) {
          const originalHtml = button.innerHTML;
          button.innerHTML = '✓';
          button.classList.add('copied');
          setTimeout(() => {
            button.innerHTML = originalHtml;
            button.classList.remove('copied');
          }, 1500);
        }
      }

      /**
       * Render the copy-link button HTML for a message.
       */
      function renderCopyLinkButton(entryId) {
        return `<button class="copy-link-btn" data-entry-id="${entryId}" title="Copy link to this message">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </button>`;
      }

      function renderEntry(entry, sctx) {
        const ts = formatTimestamp(entry.timestamp);
        const tsHtml = ts ? `<div class="message-timestamp">${ts}</div>` : '';
        const entryId = `${sctx.idPrefix}${entry.id}`;
        // Share links target main-session entries only; overlays skip them.
        const copyBtnHtml = sctx.prefix === '' ? renderCopyLinkButton(entry.id) : '';

        if (entry.type === 'message') {
          const msg = entry.message;

          if (msg.role === 'user') {
            let html = `<div class="user-message" id="${entryId}">${copyBtnHtml}${tsHtml}`;
            const content = msg.content;

            if (Array.isArray(content)) {
              const images = content.filter(c => c.type === 'image');
              if (images.length > 0) {
                html += '<div class="message-images">';
                for (const img of images) {
                  html += `<img src="data:${img.mimeType};base64,${img.data}" class="message-image" />`;
                }
                html += '</div>';
              }
            }

            const text = typeof content === 'string' ? content : 
              content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            if (text.trim()) {
              html += `<div class="markdown-content">${safeMarkedParse(text)}</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'developer') {
            let html = `<div class="user-message developer-message" id="${entryId}">${copyBtnHtml}${tsHtml}`;
            const content = msg.content;
            const text = typeof content === 'string' ? content :
              content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            if (text.trim()) {
              html += `<div class="markdown-content">${safeMarkedParse(text)}</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'assistant') {
            let html = `<div class="assistant-message" id="${entryId}">${copyBtnHtml}${tsHtml}`;

            for (const block of msg.content) {
              if (block.type === 'text') {
                const canon = canonicalizeMessage(block.text);
                if (canon) {
                  html += `<div class="assistant-text markdown-content">${safeMarkedParse(block.text)}</div>`;
                }
              } else if (block.type === 'thinking') {
                const thinking = canonicalizeMessage(block.thinking);
                if (!thinking) continue;
                html += `<div class="thinking-block">
                  <div class="thinking-text">${escapeHtml(thinking)}</div>
                  <div class="thinking-collapsed">Thinking ...</div>
                </div>`;
              }
            }
            for (const block of msg.content) {
              if (block.type === 'toolCall') {
                html += renderToolCall(block, sctx);
              }
            }

            if (msg.stopReason === 'aborted') {
              html += '<div class="error-text">Aborted</div>';
            } else if (msg.stopReason === 'error') {
              html += `<div class="error-text">Error: ${escapeHtml(msg.errorMessage || 'Unknown error')}</div>`;
            }

            html += '</div>';
            return html;
          }

          if (msg.role === 'bashExecution') {
            const isError = msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null);
            let html = `<div class="tool-execution ${isError ? 'error' : 'success'}" id="${entryId}">${tsHtml}`;
            html += `<div class="tool-command">$ ${escapeHtml(msg.command)}</div>`;
            if (msg.output) html += formatExpandableOutput(msg.output, 10);
            if (msg.cancelled) {
              html += '<div style="color: var(--warning)">(cancelled)</div>';
            } else if (msg.exitCode !== 0 && msg.exitCode !== null) {
              html += `<div style="color: var(--error)">(exit ${msg.exitCode})</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'jsExecution') {
            const isError = msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null);
            let html = `<div class="tool-execution ${isError ? 'error' : 'success'}" id="${entryId}">${tsHtml}`;
            html += `<div class="tool-command">$ ${escapeHtml(msg.code)}</div>`;
            if (msg.output) html += formatExpandableOutput(msg.output, 10);
            if (msg.cancelled) {
              html += '<div style="color: var(--warning)">(cancelled)</div>';
            } else if (msg.exitCode !== 0 && msg.exitCode !== null) {
              html += `<div style="color: var(--error)">(exit ${msg.exitCode})</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'toolResult') return '';
        }

        if (entry.type === 'model_change') {
          const html = `<div class="model-change" id="${entryId}">${tsHtml}Switched to model: <span class="model-name">${escapeHtml(entry.model)}</span></div>`;
          return html;
        }

        if (entry.type === 'thinking_level_change') {
          const html = `<div class="thinking-change" id="${entryId}">${tsHtml}Thinking level: <span class="thinking-level">${escapeHtml(entry.thinkingLevel)}</span></div>`;
          return html;
        }


        if (entry.type === 'compaction') {
          return `<div class="compaction" id="${entryId}" onclick="this.classList.toggle('expanded')">
            <div class="compaction-label">[compaction]</div>
            <div class="compaction-collapsed">Compacted from ${entry.tokensBefore.toLocaleString()} tokens</div>
            <div class="compaction-content"><strong>Compacted from ${entry.tokensBefore.toLocaleString()} tokens</strong>\n\n${escapeHtml(entry.summary)}</div>
          </div>`;
        }

        if (entry.type === 'branch_summary') {
          return `<div class="branch-summary" id="${entryId}">${tsHtml}
            <div class="branch-summary-header">Branch Summary</div>
            <div class="markdown-content">${safeMarkedParse(entry.summary)}</div>
          </div>`;
        }

        if (entry.type === 'custom_message' && entry.display) {
          return `<div class="hook-message" id="${entryId}">${tsHtml}
            <div class="hook-type">[${escapeHtml(entry.customType)}]</div>
            <div class="markdown-content">${safeMarkedParse(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))}</div>
          </div>`;
        }

        return '';
      }

      // ============================================================
      // HEADER / STATS
      // ============================================================

      function computeStats(entryList) {
        let userMessages = 0, developerMessages = 0, assistantMessages = 0, toolResults = 0;
        let customMessages = 0, compactions = 0, branchSummaries = 0, toolCalls = 0;
        const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const models = new Set();

        for (const entry of entryList) {
          if (entry.type === 'message') {
            const msg = entry.message;
            if (msg.role === 'user') userMessages++;
            if (msg.role === 'developer') developerMessages++;
            if (msg.role === 'assistant') {
              assistantMessages++;
              if (msg.model) models.add(msg.provider ? `${msg.provider}/${msg.model}` : msg.model);
              if (msg.usage) {
                tokens.input += msg.usage.input || 0;
                tokens.output += msg.usage.output || 0;
                tokens.cacheRead += msg.usage.cacheRead || 0;
                tokens.cacheWrite += msg.usage.cacheWrite || 0;
                if (msg.usage.cost) {
                  cost.input += msg.usage.cost.input || 0;
                  cost.output += msg.usage.cost.output || 0;
                  cost.cacheRead += msg.usage.cost.cacheRead || 0;
                  cost.cacheWrite += msg.usage.cost.cacheWrite || 0;
                }
              }
              toolCalls += msg.content.filter(c => c.type === 'toolCall').length;
            }
            if (msg.role === 'toolResult') toolResults++;
          } else if (entry.type === 'compaction') {
            compactions++;
          } else if (entry.type === 'branch_summary') {
            branchSummaries++;
          } else if (entry.type === 'custom_message') {
            customMessages++;
          }
        }

        return { userMessages, developerMessages, assistantMessages, toolResults, customMessages, compactions, branchSummaries, toolCalls, tokens, cost, models: Array.from(models) };
      }

      const globalStats = computeStats(entries);

      function renderHeader() {
        const totalCost = globalStats.cost.input + globalStats.cost.output + globalStats.cost.cacheRead + globalStats.cost.cacheWrite;

        const tokenParts = [];
        if (globalStats.tokens.input) tokenParts.push(`↑${formatTokens(globalStats.tokens.input)}`);
        if (globalStats.tokens.output) tokenParts.push(`↓${formatTokens(globalStats.tokens.output)}`);
        if (globalStats.tokens.cacheRead) tokenParts.push(`R${formatTokens(globalStats.tokens.cacheRead)}`);
        if (globalStats.tokens.cacheWrite) tokenParts.push(`W${formatTokens(globalStats.tokens.cacheWrite)}`);

        const msgParts = [];
        if (globalStats.userMessages) msgParts.push(`${globalStats.userMessages} user`);
        if (globalStats.developerMessages) msgParts.push(`${globalStats.developerMessages} developer`);
        if (globalStats.assistantMessages) msgParts.push(`${globalStats.assistantMessages} assistant`);
        if (globalStats.toolResults) msgParts.push(`${globalStats.toolResults} tool results`);
        if (globalStats.customMessages) msgParts.push(`${globalStats.customMessages} custom`);
        if (globalStats.compactions) msgParts.push(`${globalStats.compactions} compactions`);
        if (globalStats.branchSummaries) msgParts.push(`${globalStats.branchSummaries} branch summaries`);

        let html = `
          <div class="header">
            <h1>Session: ${escapeHtml(header?.id || 'unknown')}</h1>
            <div class="help-bar">Ctrl+T toggle thinking · Ctrl+O toggle tools</div>
            <div class="header-info">
              <div class="info-item"><span class="info-label">Date:</span><span class="info-value">${header?.timestamp ? new Date(header.timestamp).toLocaleString() : 'unknown'}</span></div>
              <div class="info-item"><span class="info-label">Models:</span><span class="info-value">${globalStats.models.join(', ') || 'unknown'}</span></div>
              <div class="info-item"><span class="info-label">Messages:</span><span class="info-value">${msgParts.join(', ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Tool Calls:</span><span class="info-value">${globalStats.toolCalls}</span></div>
              <div class="info-item"><span class="info-label">Tokens:</span><span class="info-value">${tokenParts.join(' ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Cost:</span><span class="info-value">$${totalCost.toFixed(3)}</span></div>
            </div>
          </div>`;

        if (systemPrompt) {
          html += `<div class="system-prompt">
            <div class="system-prompt-header">System Prompt</div>
            <div class="system-prompt-content">${escapeHtml(systemPrompt)}</div>
          </div>`;
        }

        if (tools && tools.length > 0) {
          const namesHtml = tools.map(t => `<span class="tool-name-chip">${escapeHtml(t.name)}</span>`).join('');
          const fullHtml = tools.map(t => `<div class="tool-item"><span class="tool-item-name">${escapeHtml(t.name)}</span> - <span class="tool-item-desc">${escapeHtml(t.description)}</span></div>`).join('');
          html += `<div class="tools-list collapsed" onclick="this.classList.toggle('collapsed')">
            <div class="tools-header">Available Tools (${tools.length})</div>
            <div class="tools-collapsed">${namesHtml}</div>
            <div class="tools-content">${fullHtml}</div>
          </div>`;
        }

        return html;
      }

      // ============================================================
      // NAVIGATION
      // ============================================================

      // Cache for rendered entry DOM nodes
      const entryCache = new Map();

      function renderEntryToNode(entry, sctx) {
        // Cache main-session nodes only; sub-session bodies are cached whole
        // per key in subSessionBodyCache, so each entry renders once anyway.
        const cacheable = sctx.prefix === '';
        if (cacheable && entryCache.has(entry.id)) {
          return entryCache.get(entry.id).cloneNode(true);
        }

        // Render to HTML string, then parse to node
        const html = renderEntry(entry, sctx);
        if (!html) return null;

        const template = document.createElement('template');
        template.innerHTML = html;
        const node = template.content.firstElementChild;

        // Cache the node
        if (cacheable && node) {
          entryCache.set(entry.id, node.cloneNode(true));
        }
        return node;
      }

      function navigateTo(targetId, scrollMode = 'target', scrollToEntryId = null) {
        currentLeafId = targetId;
        currentTargetId = scrollToEntryId || targetId;
        const path = getPath(targetId);

        renderTree();

        document.getElementById('header-container').innerHTML = renderHeader();

        // Build messages using cached DOM nodes
        const messagesEl = document.getElementById('messages');
        const fragment = document.createDocumentFragment();

        for (const entry of path) {
          const node = renderEntryToNode(entry, mainSctx);
          if (node) {
            fragment.appendChild(node);
          }
        }

        messagesEl.innerHTML = '';
        messagesEl.appendChild(fragment);

        // Attach click handlers for copy-link buttons
        messagesEl.querySelectorAll('.copy-link-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entryId = btn.dataset.entryId;
            const shareUrl = buildShareUrl(entryId);
            copyToClipboard(shareUrl, btn);
          });
        });

        // Use setTimeout(0) to ensure DOM is fully laid out before scrolling
        setTimeout(() => {
          const content = document.getElementById('content');
          if (scrollMode === 'bottom') {
            content.scrollTop = content.scrollHeight;
          } else if (scrollMode === 'target') {
            const scrollTargetId = scrollToEntryId || targetId;
            const targetEl = document.getElementById(`entry-${scrollTargetId}`);
            if (targetEl) {
              targetEl.scrollIntoView({ block: 'center' });
              if (scrollToEntryId) {
                targetEl.classList.add('highlight');
                setTimeout(() => targetEl.classList.remove('highlight'), 2000);
              }
            }
          }
        }, 0);
      }

      // ============================================================
      // INITIALIZATION
      // ============================================================

      // Escape HTML tags in text (but not code blocks)
      function escapeHtmlTags(text) {
        return text.replace(/<(?=[a-zA-Z\/])/g, '&lt;');
      }

      // Configure marked with syntax highlighting and HTML escaping for text
      marked.use({
        breaks: true,
        gfm: true,
        renderer: {
          // Code blocks: syntax highlight, no HTML escaping
          code(token) {
            const code = token.text;
            const lang = token.lang;
            let highlighted;
            if (lang && hljs.getLanguage(lang)) {
              try {
                highlighted = hljs.highlight(code, { language: lang }).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            } else {
              // Auto-detect language if not specified
              try {
                highlighted = hljs.highlightAuto(code).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            }
            return `<pre><code class="hljs">${highlighted}</code></pre>`;
          },
          // Text content: escape HTML tags
          text(token) {
            return escapeHtmlTags(escapeHtml(token.text));
          },
          // Inline code: escape HTML
          codespan(token) {
            return `<code>${escapeHtml(token.text)}</code>`;
          }
        }
      });

      // Simple marked parse (escaping handled in renderers)
      function safeMarkedParse(text) {
        return marked.parse(text);
      }

      // Search input
      const searchInput = document.getElementById('tree-search');
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        forceTreeRerender();
      });

      // Filter buttons
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          filterMode = btn.dataset.filter;
          forceTreeRerender();
        });
      });

      // Sidebar toggle
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      const hamburger = document.getElementById('hamburger');
      const sidebarResizer = document.getElementById('sidebar-resizer');
      const SIDEBAR_WIDTH_STORAGE_KEY = 'pi-share:v1:sidebar-width';
      const MIN_CONTENT_WIDTH = 320;

      function isMobileLayout() {
        return window.matchMedia('(max-width: 900px)').matches;
      }

      function getSidebarBounds() {
        const rootStyles = getComputedStyle(document.documentElement);
        const minWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-min-width')) || 240;
        const maxWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-max-width')) || 720;
        const viewportMaxWidth = window.innerWidth - MIN_CONTENT_WIDTH;
        return {
          minWidth,
          maxWidth: Math.max(minWidth, Math.min(maxWidth, viewportMaxWidth))
        };
      }

      function clampSidebarWidth(width) {
        const { minWidth, maxWidth } = getSidebarBounds();
        return Math.max(minWidth, Math.min(maxWidth, width));
      }

      function applySidebarWidth(width) {
        document.documentElement.style.setProperty('--sidebar-width', `${Math.round(clampSidebarWidth(width))}px`);
      }

      function loadSidebarWidth() {
        try {
          const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
          if (raw === null) return null;
          const width = Number(raw);
          return Number.isFinite(width) ? width : null;
        } catch {
          return null;
        }
      }

      function saveSidebarWidth(width) {
        try {
          localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clampSidebarWidth(width))));
        } catch {
          // Ignore storage failures (e.g. private browsing restrictions)
        }
      }

      function setupSidebarResize() {
        const savedWidth = loadSidebarWidth();
        if (savedWidth !== null) {
          applySidebarWidth(savedWidth);
        }

        if (!sidebarResizer) return;

        let cleanupDrag = null;

        const stopDrag = (pointerId) => {
          if (cleanupDrag) {
            cleanupDrag(pointerId);
            cleanupDrag = null;
          }
        };

        sidebarResizer.addEventListener('pointerdown', (e) => {
          if (isMobileLayout()) return;

          e.preventDefault();
          const startX = e.clientX;
          const startWidth = sidebar.getBoundingClientRect().width;
          document.body.classList.add('sidebar-resizing');
          sidebarResizer.setPointerCapture?.(e.pointerId);

          const onPointerMove = (event) => {
            applySidebarWidth(startWidth + (event.clientX - startX));
          };

          cleanupDrag = (pointerIdToRelease) => {
            document.body.classList.remove('sidebar-resizing');
            sidebarResizer.releasePointerCapture?.(pointerIdToRelease);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerCancel);
            saveSidebarWidth(sidebar.getBoundingClientRect().width);
          };

          const onPointerUp = (event) => stopDrag(event.pointerId);
          const onPointerCancel = (event) => stopDrag(event.pointerId);

          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
          window.addEventListener('pointercancel', onPointerCancel);
        });

        sidebarResizer.addEventListener('dblclick', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(400);
          saveSidebarWidth(400);
        });

        window.addEventListener('resize', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(sidebar.getBoundingClientRect().width);
        });
      }

      setupSidebarResize();

      hamburger.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('open');
        hamburger.style.display = 'none';
      });

      const closeSidebar = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
        hamburger.style.display = '';
      };

      overlay.addEventListener('click', closeSidebar);
      document.getElementById('sidebar-close').addEventListener('click', closeSidebar);

      // Toggle states
      let thinkingExpanded = false;
      let toolOutputsExpanded = false;

      const toggleThinking = () => {
        thinkingExpanded = !thinkingExpanded;
        document.querySelectorAll('.thinking-text').forEach(el => {
          el.style.display = thinkingExpanded ? 'block' : 'none';
        });
        document.querySelectorAll('.thinking-collapsed').forEach(el => {
          el.style.display = thinkingExpanded ? 'none' : 'block';
        });
      };

      const toggleToolOutputs = () => {
        toolOutputsExpanded = !toolOutputsExpanded;
        document.querySelectorAll('.tool-output.expandable').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
        document.querySelectorAll('.compaction').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
      };

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (overlayStack.length > 0) {
            e.preventDefault();
            popSubSession();
            return;
          }
          searchInput.value = '';
          searchQuery = '';
          navigateTo(leafId, 'bottom');
        }
        if (e.ctrlKey && e.key === 't') {
          e.preventDefault();
          toggleThinking();
        }
        if (e.ctrlKey && e.key === 'o') {
          e.preventDefault();
          toggleToolOutputs();
        }
      });

      // Initial render
      // If URL has targetId, scroll to that specific message; otherwise stay at top
      if (leafId) {
        if (urlTargetId && byId.has(urlTargetId)) {
          navigateTo(leafId, 'target', urlTargetId);
        } else {
          navigateTo(leafId, 'none');
        }
      } else if (entries.length > 0) {
        // Fallback: use last entry if no leafId
        navigateTo(entries[entries.length - 1].id, 'none');
      }
      } // end bootSession

      function showLoadError(err) {
        const messages = document.getElementById('messages');
        if (!messages) return;
        const div = document.createElement('div');
        div.className = 'share-load-error';
        div.textContent = 'Failed to load session: ' + (err && err.message ? err.message : String(err));
        messages.appendChild(div);
      }

      const pending = window.__OMP_SESSION_DATA__;
      if (pending && typeof pending.then === 'function') {
        pending.then(bootSession, showLoadError);
      } else {
        const base64 = document.getElementById('session-data').textContent;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        bootSession(JSON.parse(new TextDecoder('utf-8').decode(bytes)));
      }
    })();
