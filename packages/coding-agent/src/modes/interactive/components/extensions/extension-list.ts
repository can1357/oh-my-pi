/**
 * ExtensionList - Tree view with grouping and fuzzy search.
 *
 * Displays extensions grouped by kind with collapsible headers.
 * Supports filtering via fuzzy search (flattens tree when active).
 */

import {
   type Component,
   isArrowDown,
   isArrowLeft,
   isArrowRight,
   isArrowUp,
   isBackspace,
   isEnter,
   truncateToWidth,
   visibleWidth,
} from "@oh-my-pi/pi-tui";
import { theme } from "../../theme/theme";
import { applyFilter } from "./state-manager";
import type { Extension, ExtensionKind, ExtensionState } from "./types";

export interface ExtensionListCallbacks {
   /** Called when selection changes */
   onSelectionChange?: (extension: Extension | null) => void;
   /** Called when extension is toggled (Enter pressed on item) */
   onToggle?: (extensionId: string, enabled: boolean) => void;
}

const MAX_VISIBLE = 30;

/** Tree group for a kind of extensions */
interface TreeGroup {
   id: string;
   kind: ExtensionKind;
   label: string;
   icon: string;
   collapsed: boolean;
   items: Extension[];
}

/** Flattened tree item for rendering */
type FlatItem =
   | { type: "group"; group: TreeGroup }
   | { type: "item"; item: Extension; group: TreeGroup };

export class ExtensionList implements Component {
   private extensions: Extension[] = [];
   private groups: TreeGroup[] = [];
   private flatItems: FlatItem[] = [];
   private selectedIndex = 0;
   private scrollOffset = 0;
   private searchQuery = "";
   private focused = false;
   private callbacks: ExtensionListCallbacks;
   /** True when there's an active filter (query.length > 0) */
   private hasFilter = false;

   constructor(extensions: Extension[], callbacks: ExtensionListCallbacks = {}) {
      this.extensions = extensions;
      this.callbacks = callbacks;
      this.rebuildGroups();
   }

   setExtensions(extensions: Extension[]): void {
      this.extensions = extensions;
      this.rebuildGroups();
      this.clampSelection();
   }

   setFocused(focused: boolean): void {
      this.focused = focused;
   }

   getSelectedExtension(): Extension | null {
      const item = this.flatItems[this.selectedIndex];
      if (item?.type === "item") {
         return item.item;
      }
      return null;
   }

   setSearchQuery(query: string): void {
      this.searchQuery = query;
      this.hasFilter = query.length > 0;
      this.rebuildGroups();
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.notifySelectionChange();
   }

   /** Clear search filter */
   clearSearch(): void {
      this.setSearchQuery("");
   }

   invalidate(): void {}

   render(width: number): string[] {
      const lines: string[] = [];

      // Search bar - cursor shown when focused
      const searchPrefix = theme.fg("muted", "Search: ");
      const searchText = this.searchQuery || (this.focused ? "" : theme.fg("dim", "type to filter"));
      const cursor = this.focused ? theme.fg("accent", "_") : "";
      lines.push(searchPrefix + searchText + cursor);
      lines.push("");

      if (this.flatItems.length === 0) {
         lines.push(theme.fg("muted", "  No extensions found"));
         return lines;
      }

      // Calculate visible range
      const startIdx = this.scrollOffset;
      const endIdx = Math.min(startIdx + MAX_VISIBLE, this.flatItems.length);

      // Render visible items
      for (let i = startIdx; i < endIdx; i++) {
         const flatItem = this.flatItems[i];
         const isSelected = this.focused && i === this.selectedIndex;

         if (flatItem.type === "group") {
            lines.push(this.renderGroupHeader(flatItem.group, isSelected, width));
         } else {
            lines.push(this.renderExtensionRow(flatItem.item, isSelected, width));
         }
      }

      // Scroll indicator
      if (this.flatItems.length > MAX_VISIBLE) {
         const indicator = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.flatItems.length})`);
         lines.push(indicator);
      }

      return lines;
   }

   private renderGroupHeader(group: TreeGroup, isSelected: boolean, width: number): string {
      const kindIcon = group.icon;
      const countStr = `(${group.items.length})`;

      let line = `${kindIcon} ${group.label} ${theme.fg("muted", countStr)}`;

      if (isSelected) {
         line = theme.bold(theme.fg("accent", line));
         line = theme.bg("selectedBg", line);
      }

      return truncateToWidth(line, width);
   }

   private renderExtensionRow(ext: Extension, isSelected: boolean, width: number): string {
      // Status icon
      const stateIcon = this.getStateIcon(ext.state);

      // Name
      let name = ext.displayName;
      const nameWidth = Math.min(28, width - 10);

      // Trigger (if present)
      const trigger = ext.trigger ? theme.fg("dim", ext.trigger) : "";

      // Build the line with tree branch structure
      let line = `  ├─ ${stateIcon} `;

      if (isSelected) {
         name = theme.bold(theme.fg("accent", name));
      } else if (ext.state === "disabled") {
         name = theme.fg("dim", name);
      } else if (ext.state === "shadowed") {
         name = theme.fg("warning", name);
      }

      // Pad name
      const namePadded = this.padText(name, nameWidth);
      line += namePadded;

      // Add trigger with spacing
      if (trigger) {
         const remainingWidth = width - visibleWidth(line) - 2;
         if (remainingWidth > 5) {
            line += "  " + truncateToWidth(trigger, remainingWidth);
         }
      }

      // Apply selection background
      if (isSelected) {
         line = theme.bg("selectedBg", line);
      }

      return truncateToWidth(line, width);
   }

   private getKindIcon(kind: ExtensionKind): string {
      switch (kind) {
         case "skill":
            return "⚡";
         case "tool":
         case "slash-command":
            return "🛠️";
         case "mcp":
            return "📦";
         case "rule":
            return "📋";
         case "hook":
            return "🪝";
         case "prompt":
            return "💬";
         case "context-file":
            return "📄";
         case "instruction":
            return "📌";
         default:
            return "•";
      }
   }

   private getStateIcon(state: ExtensionState): string {
      switch (state) {
         case "active":
            return theme.fg("success", "●");
         case "disabled":
            return theme.fg("dim", "○");
         case "shadowed":
            return theme.fg("warning", "◐");
      }
   }

   private padText(text: string, targetWidth: number): string {
      const width = visibleWidth(text);
      if (width >= targetWidth) {
         return truncateToWidth(text, targetWidth);
      }
      return text + " ".repeat(targetWidth - width);
   }

   private rebuildGroups(): void {
      if (this.hasFilter) {
         // Flatten: show only matching items, no group headers
         const filtered = applyFilter(this.extensions, this.searchQuery);
         this.flatItems = filtered.map((item) => ({
            type: "item" as const,
            item,
            group: this.findGroupForKind(item.kind),
         }));
      } else {
         // Build groups from extensions
         this.groups = this.buildGroupsFromExtensions();

         // Flatten tree based on collapsed state
         this.flatItems = [];
         for (const group of this.groups) {
            // Add group header
            this.flatItems.push({ type: "group", group });

            // Add items if not collapsed
            if (!group.collapsed) {
               for (const item of group.items) {
                  this.flatItems.push({ type: "item", item, group });
               }
            }
         }
      }
   }

   private buildGroupsFromExtensions(): TreeGroup[] {
      // Group extensions by kind
      const kindMap = new Map<ExtensionKind, Extension[]>();

      for (const ext of this.extensions) {
         const items = kindMap.get(ext.kind) ?? [];
         items.push(ext);
         kindMap.set(ext.kind, items);
      }

      // Create groups with labels and icons
      const groups: TreeGroup[] = [];
      const kindOrder: ExtensionKind[] = [
         "skill",
         "tool",
         "slash-command",
         "context-file",
         "rule",
         "mcp",
         "hook",
         "prompt",
         "instruction",
      ];

      for (const kind of kindOrder) {
         const items = kindMap.get(kind);
         if (items && items.length > 0) {
            groups.push({
               id: `group:${kind}`,
               kind,
               label: this.getKindLabel(kind),
               icon: this.getKindIcon(kind),
               collapsed: false,
               items,
            });
         }
      }

      return groups;
   }

   private findGroupForKind(kind: ExtensionKind): TreeGroup {
      return (
         this.groups.find((g) => g.kind === kind) ?? {
            id: `group:${kind}`,
            kind,
            label: this.getKindLabel(kind),
            icon: this.getKindIcon(kind),
            collapsed: false,
            items: [],
         }
      );
   }

   private getKindLabel(kind: ExtensionKind): string {
      switch (kind) {
         case "skill":
            return "Skills";
         case "tool":
            return "Custom Tools";
         case "slash-command":
            return "Slash Commands";
         case "mcp":
            return "MCP Servers";
         case "rule":
            return "Rules";
         case "hook":
            return "Hooks";
         case "prompt":
            return "Prompts";
         case "context-file":
            return "Context Files";
         case "instruction":
            return "Instructions";
         default:
            return "Other";
      }
   }

   private clampSelection(): void {
      if (this.flatItems.length === 0) {
         this.selectedIndex = 0;
         this.scrollOffset = 0;
         return;
      }

      this.selectedIndex = Math.min(this.selectedIndex, this.flatItems.length - 1);
      this.selectedIndex = Math.max(0, this.selectedIndex);

      // Adjust scroll offset
      if (this.selectedIndex < this.scrollOffset) {
         this.scrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) {
         this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
      }
   }

   handleInput(data: string): void {
      const charCode = data.length === 1 ? data.charCodeAt(0) : -1;

      // Navigation - j/k or arrows
      if (isArrowUp(data) || data === "k") {
         this.moveSelectionUp();
         return;
      }

      if (isArrowDown(data) || data === "j") {
         this.moveSelectionDown();
         return;
      }

      // Left arrow: collapse current group or move to parent group
      if (isArrowLeft(data)) {
         const item = this.flatItems[this.selectedIndex];
         if (item?.type === "group" && !item.group.collapsed) {
            item.group.collapsed = true;
            this.rebuildGroups();
            this.clampSelection();
         } else if (item?.type === "item") {
            // Move selection to parent group header
            const groupIndex = this.flatItems.findIndex(
               (fi) => fi.type === "group" && fi.group.kind === item.group.kind
            );
            if (groupIndex >= 0) {
               this.selectedIndex = groupIndex;
               this.clampSelection();
               this.notifySelectionChange();
            }
         }
         return;
      }

      // Right arrow: expand current group
      if (isArrowRight(data)) {
         const item = this.flatItems[this.selectedIndex];
         if (item?.type === "group" && item.group.collapsed) {
            item.group.collapsed = false;
            this.rebuildGroups();
            this.clampSelection();
         }
         return;
      }

      // Space: TOGGLE item enabled/disabled
      if (data === " ") {
         const item = this.flatItems[this.selectedIndex];
         if (item?.type === "item") {
            const newEnabled = item.item.state === "disabled";
            this.callbacks.onToggle?.(item.item.id, newEnabled);
         }
         return;
      }

      // Enter: expand/collapse group
      if (isEnter(data)) {
         const item = this.flatItems[this.selectedIndex];
         if (item?.type === "group") {
            item.group.collapsed = !item.group.collapsed;
            this.rebuildGroups();
            this.clampSelection();
         }
         return;
      }

      // Backspace: delete from search query
      if (isBackspace(data)) {
         if (this.searchQuery.length > 0) {
            this.setSearchQuery(this.searchQuery.slice(0, -1));
         }
         return;
      }

      // Printable characters (except special keys) -> search
      // Skip j/k (navigation), skip space, skip control chars
      if (data.length === 1 && charCode > 32 && charCode < 127) {
         // Skip j/k as they're navigation
         if (data === "j" || data === "k") {
            return;
         }
         this.setSearchQuery(this.searchQuery + data);
         return;
      }
   }

   private moveSelectionUp(): void {
      if (this.selectedIndex > 0) {
         this.selectedIndex--;
         if (this.selectedIndex < this.scrollOffset) {
            this.scrollOffset = this.selectedIndex;
         }
         this.notifySelectionChange();
      }
   }

   private moveSelectionDown(): void {
      if (this.selectedIndex < this.flatItems.length - 1) {
         this.selectedIndex++;
         if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) {
            this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
         }
         this.notifySelectionChange();
      }
   }

   private notifySelectionChange(): void {
      const ext = this.getSelectedExtension();
      this.callbacks.onSelectionChange?.(ext);
   }
}
