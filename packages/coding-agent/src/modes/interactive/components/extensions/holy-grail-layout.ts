/**
 * HolyGrailLayout - 3-column layout with box-drawing borders.
 *
 * ```
 * ╭──────────┬──────────────────┬──────────────────╮
 * │ Sidebar  │ Main List        │ Inspector        │
 * │ (20%)    │ (40%)            │ (40%)            │
 * ╰──────────┴──────────────────┴──────────────────╯
 * ```
 */

import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../theme/theme";
import type { FocusPane } from "./types";

/**
 * Pad or truncate text to exact visible width.
 */
function padToWidth(text: string, targetWidth: number): string {
   const width = visibleWidth(text);
   if (width >= targetWidth) {
      return truncateToWidth(text, targetWidth);
   }
   return text + " ".repeat(targetWidth - width);
}

/**
 * Truncate text to fit within width, preserving ANSI codes.
 */
function truncateToWidth(text: string, maxWidth: number): string {
   if (maxWidth <= 0) return "";

   let width = 0;
   let result = "";
   let inAnsi = false;
   let ansiCode = "";

   for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Track ANSI escape sequences
      if (char === "\x1b") {
         inAnsi = true;
         ansiCode = char;
         continue;
      }

      if (inAnsi) {
         ansiCode += char;
         if (char === "m" || char === "G" || char === "K" || char === "H" || char === "J") {
            result += ansiCode;
            inAnsi = false;
            ansiCode = "";
         }
         continue;
      }

      // Calculate character width
      const charWidth = visibleWidth(char);
      if (width + charWidth > maxWidth) {
         break;
      }

      result += char;
      width += charWidth;
   }

   // Reset any active ANSI codes
   if (result.includes("\x1b[")) {
      result += "\x1b[0m";
   }

   return result;
}

/**
 * Column ratios for the layout.
 */
const SIDEBAR_RATIO = 0.20;
const MAIN_RATIO = 0.40;
const INSPECTOR_RATIO = 0.40;

/**
 * Minimum column widths.
 */
const MIN_SIDEBAR = 15;
const MIN_MAIN = 25;
const MIN_INSPECTOR = 15;

export class HolyGrailLayout implements Component {
   private sidebar: Component;
   private mainList: Component;
   private inspector: Component;
   private focusedPane: FocusPane = "sidebar";
   // Cache widths to prevent layout shifts
   private cachedWidth = 0;
   private cachedSidebarWidth = 0;
   private cachedMainWidth = 0;
   private cachedInspectorWidth = 0;

   constructor(sidebar: Component, mainList: Component, inspector: Component) {
      this.sidebar = sidebar;
      this.mainList = mainList;
      this.inspector = inspector;
   }

   setFocusedPane(pane: FocusPane): void {
      this.focusedPane = pane;
   }

   invalidate(): void {
      this.sidebar.invalidate?.();
      this.mainList.invalidate?.();
      this.inspector.invalidate?.();
   }

   render(width: number): string[] {
      // Only recalculate widths if terminal width changed
      if (width !== this.cachedWidth) {
         this.cachedWidth = width;
         // Content row format: │ sidebar │ main │ inspector │
         // Fixed chars: 4 borders (│) + 3 spaces = 7
         const fixedChars = 7;
         const contentWidth = Math.max(0, width - fixedChars);

         // Distribute remaining width across columns
         this.cachedSidebarWidth = Math.max(MIN_SIDEBAR, Math.floor(contentWidth * SIDEBAR_RATIO));
         this.cachedMainWidth = Math.max(MIN_MAIN, Math.floor(contentWidth * MAIN_RATIO));
         this.cachedInspectorWidth = Math.max(MIN_INSPECTOR, contentWidth - this.cachedSidebarWidth - this.cachedMainWidth);

         // Ensure total doesn't exceed contentWidth
         const total = this.cachedSidebarWidth + this.cachedMainWidth + this.cachedInspectorWidth;
         if (total > contentWidth) {
            const excess = total - contentWidth;
            if (this.cachedMainWidth > MIN_MAIN) {
               this.cachedMainWidth = Math.max(MIN_MAIN, this.cachedMainWidth - excess);
            } else if (this.cachedSidebarWidth > MIN_SIDEBAR) {
               this.cachedSidebarWidth = Math.max(MIN_SIDEBAR, this.cachedSidebarWidth - excess);
            } else {
               this.cachedInspectorWidth = Math.max(1, this.cachedInspectorWidth - excess);
            }
         }
      }

      const sidebarWidth = this.cachedSidebarWidth;
      const mainWidth = this.cachedMainWidth;
      const inspectorWidth = this.cachedInspectorWidth;

      // Render each panel
      const sidebarLines = this.sidebar.render(sidebarWidth);
      const mainLines = this.mainList.render(mainWidth);
      const inspectorLines = this.inspector.render(inspectorWidth);

      // Find max height
      const maxHeight = Math.max(sidebarLines.length, mainLines.length, inspectorLines.length, 1);

      const lines: string[] = [];

      // Top border
      lines.push(this.renderTopBorder(sidebarWidth, mainWidth, inspectorWidth));

      // Content rows
      for (let i = 0; i < maxHeight; i++) {
         const sidebarLine = sidebarLines[i] ?? "";
         const mainLine = mainLines[i] ?? "";
         const inspectorLine = inspectorLines[i] ?? "";
         lines.push(this.renderContentRow(sidebarLine, mainLine, inspectorLine, sidebarWidth, mainWidth, inspectorWidth));
      }

      // Bottom border
      lines.push(this.renderBottomBorder(sidebarWidth, mainWidth, inspectorWidth));

      return lines;
   }

   /**
    * Render top border: ╭──────┬──────────┬──────╮
    */
   private renderTopBorder(sw: number, mw: number, iw: number): string {
      const sidebarBorder = this.focusedPane === "sidebar" ? "borderAccent" : "border";
      const mainBorder = this.focusedPane === "main" ? "borderAccent" : "border";
      const inspectorBorder = this.focusedPane === "inspector" ? "borderAccent" : "border";

      return (
         theme.fg(sidebarBorder as any, "╭" + "─".repeat(sw + 1)) +
         theme.fg("border" as any, "┬") +
         theme.fg(mainBorder as any, "─".repeat(mw + 1)) +
         theme.fg("border" as any, "┬") +
         theme.fg(inspectorBorder as any, "─".repeat(iw + 1) + "╮")
      );
   }

   /**
    * Render content row: │ content │ content │ content │
    */
   private renderContentRow(s: string, m: string, ins: string, sw: number, mw: number, iw: number): string {
      const sidebarBorder = this.focusedPane === "sidebar" ? "borderAccent" : "border";
      const mainBorder = this.focusedPane === "main" ? "borderAccent" : "border";
      const inspectorBorder = this.focusedPane === "inspector" ? "borderAccent" : "border";

      const paddedS = padToWidth(s, sw);
      const paddedM = padToWidth(m, mw);
      const paddedI = padToWidth(ins, iw);

      return (
         theme.fg(sidebarBorder as any, "│") +
         " " +
         paddedS +
         theme.fg("border" as any, "│") +
         " " +
         paddedM +
         theme.fg("border" as any, "│") +
         " " +
         paddedI +
         theme.fg(inspectorBorder as any, "│")
      );
   }

   /**
    * Render bottom border: ╰──────┴──────────┴──────╯
    */
   private renderBottomBorder(sw: number, mw: number, iw: number): string {
      const sidebarBorder = this.focusedPane === "sidebar" ? "borderAccent" : "border";
      const mainBorder = this.focusedPane === "main" ? "borderAccent" : "border";
      const inspectorBorder = this.focusedPane === "inspector" ? "borderAccent" : "border";

      return (
         theme.fg(sidebarBorder as any, "╰" + "─".repeat(sw + 1)) +
         theme.fg("border" as any, "┴") +
         theme.fg(mainBorder as any, "─".repeat(mw + 1)) +
         theme.fg("border" as any, "┴") +
         theme.fg(inspectorBorder as any, "─".repeat(iw + 1) + "╯")
      );
   }
}
