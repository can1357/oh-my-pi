/**
 * SidebarTree - Hierarchical tree view with provider toggles.
 *
 * Displays providers grouped by source with toggle checkboxes.
 * Supports expand/collapse for categories.
 */

import {
   type Component,
   isArrowDown,
   isArrowUp,
   isEnter,
   truncateToWidth,
   visibleWidth,
} from "@oh-my-pi/pi-tui";
import { theme } from "../../theme/theme";
import { flattenTree, toggleProvider } from "./state-manager";
import type { FlatTreeItem, TreeNode } from "./types";

export interface SidebarTreeCallbacks {
   /** Called when provider is toggled */
   onProviderToggle?: (providerId: string, enabled: boolean) => void;
   /** Called when selection changes */
   onSelectionChange?: (nodeId: string) => void;
   /** Called when tree structure changes (collapse/expand) */
   onTreeChange?: () => void;
}

export class SidebarTree implements Component {
   private tree: TreeNode[];
   private flatItems: FlatTreeItem[] = [];
   private selectedIndex = 0;
   private focused = false;
   private callbacks: SidebarTreeCallbacks;

   constructor(tree: TreeNode[], callbacks: SidebarTreeCallbacks = {}) {
      this.tree = tree;
      this.callbacks = callbacks;
      this.flatItems = flattenTree(tree);
   }

   setTree(tree: TreeNode[]): void {
      this.tree = tree;
      this.flatItems = flattenTree(tree);
      // Keep selection in bounds
      if (this.selectedIndex >= this.flatItems.length) {
         this.selectedIndex = Math.max(0, this.flatItems.length - 1);
      }
   }

   setFocused(focused: boolean): void {
      this.focused = focused;
   }

   getSelectedNode(): TreeNode | null {
      return this.flatItems[this.selectedIndex]?.node ?? null;
   }

   invalidate(): void {}

   render(width: number): string[] {
      const lines: string[] = [];

      // Header
      lines.push(theme.bold(theme.fg("accent", "Providers")));
      lines.push("");

      if (this.flatItems.length === 0) {
         lines.push(theme.fg("muted", "No providers"));
         return lines;
      }

      for (let i = 0; i < this.flatItems.length; i++) {
         const { node, depth } = this.flatItems[i];
         const isSelected = this.focused && i === this.selectedIndex;

         // Build the line
         const indent = "  ".repeat(depth);
         let checkbox = "";
         let arrow = "";
         let label = node.label;

         // Provider nodes get checkboxes
         if (node.type === "provider") {
            checkbox = node.enabled
               ? theme.fg("success", "[x]") + " "
               : theme.fg("muted", "[ ]") + " ";
         }

         // Nodes with children get expand/collapse arrows
         if (node.children.length > 0) {
            arrow = node.collapsed ? "▸ " : "▾ ";
         } else if (node.type === "kind") {
            arrow = "  ";
         }

         // Add count if present
         if (node.count !== undefined && node.count > 0) {
            label += theme.fg("dim", ` (${node.count})`);
         }

         // Style based on state
         if (isSelected) {
            label = theme.bg("selectedBg", theme.bold(theme.fg("text", label)));
         } else if (!node.enabled) {
            label = theme.fg("dim", label);
         }

         const fullLine = `${indent}${checkbox}${arrow}${label}`;
         lines.push(truncateToWidth(fullLine, width));
      }

      return lines;
   }

   handleInput(data: string): void {
      if (this.flatItems.length === 0) return;

      // Navigation
      if (isArrowUp(data) || data === "k") {
         if (this.selectedIndex > 0) {
            this.selectedIndex--;
            this.notifySelectionChange();
         }
         return;
      }

      if (isArrowDown(data) || data === "j") {
         if (this.selectedIndex < this.flatItems.length - 1) {
            this.selectedIndex++;
            this.notifySelectionChange();
         }
         return;
      }

      // Toggle or expand/collapse
      if (data === " ") {
         const item = this.flatItems[this.selectedIndex];
         if (!item) return;

         if (item.node.type === "provider") {
            // Toggle provider
            const newEnabled = toggleProvider(item.node.id);
            item.node.enabled = newEnabled;
            // Also update children
            for (const child of item.node.children) {
               child.enabled = newEnabled;
            }
            this.callbacks.onProviderToggle?.(item.node.id, newEnabled);
         }
         return;
      }

      if (isEnter(data)) {
         const item = this.flatItems[this.selectedIndex];
         if (!item) return;

         if (item.node.children.length > 0) {
            // Toggle collapse
            item.node.collapsed = !item.node.collapsed;
            this.flatItems = flattenTree(this.tree);
            this.callbacks.onTreeChange?.();
         }
         return;
      }
   }

   private notifySelectionChange(): void {
      const node = this.getSelectedNode();
      if (node) {
         this.callbacks.onSelectionChange?.(node.id);
      }
   }
}
