/**
 * ExtensionDashboard - Main container for the Extension Control Center.
 *
 * Orchestrates the 3-column layout, handles keyboard navigation between panes,
 * and manages state updates.
 */

import {
   Container,
   isCtrlC,
   isEnter,
   isEscape,
   isShiftTab,
   isTab,
   Spacer,
   Text,
} from "@oh-my-pi/pi-tui";
import type { SettingsManager } from "../../../../core/settings-manager";
import { theme } from "../../theme/theme";
import { DynamicBorder } from "../dynamic-border";
import { ExtensionList } from "./extension-list";
import { HolyGrailLayout } from "./holy-grail-layout";
import { InspectorPanel } from "./inspector-panel";
import { SidebarTree } from "./sidebar-tree";
import { createInitialState, refreshState } from "./state-manager";
import type { DashboardCallbacks, DashboardState, FocusPane } from "./types";

export class ExtensionDashboard extends Container {
   private state: DashboardState;
   private layout: HolyGrailLayout;
   private sidebar: SidebarTree;
   private mainList: ExtensionList;
   private inspector: InspectorPanel;
   private settingsManager: SettingsManager | null;
   private cwd: string;

   public onClose?: () => void;

   constructor(cwd: string, settingsManager: SettingsManager | null = null) {
      super();
      this.cwd = cwd;
      this.settingsManager = settingsManager;
      const disabledIds = settingsManager?.getDisabledExtensions() ?? [];
      this.state = createInitialState(cwd, disabledIds);

      // Create sidebar
      this.sidebar = new SidebarTree(this.state.sidebarTree, {
         onProviderToggle: (providerId, enabled) => {
            this.refreshFromState();
         },
         onSelectionChange: (nodeId) => {
            // Could filter main list by provider
         },
         onTreeChange: () => {
            // Refresh flat tree in state
         },
      });

      // Create main list
      this.mainList = new ExtensionList(this.state.extensions, {
         onSelectionChange: (ext) => {
            this.state.selected = ext;
            this.inspector.setExtension(ext);
         },
         onToggle: (extensionId, enabled) => {
            this.handleExtensionToggle(extensionId, enabled);
         },
      });

      // Create inspector
      this.inspector = new InspectorPanel();
      if (this.state.selected) {
         this.inspector.setExtension(this.state.selected);
      }

      // Create layout
      this.layout = new HolyGrailLayout(this.sidebar, this.mainList, this.inspector);

      // Set initial focus
      this.updateFocus();

      // Build component tree
      this.addChild(new DynamicBorder());
      this.addChild(new Text(theme.bold(theme.fg("accent", " Extension Control Center")), 0, 0));
      this.addChild(
         new Text(
            theme.fg("dim", " Tab: pane  j/k: nav  Space: toggle  Enter: expand  type: search  Esc: close"),
            0,
            0,
         ),
      );
      this.addChild(new Spacer(1));
      this.addChild(this.layout);
      this.addChild(new DynamicBorder());
   }

   private updateFocus(): void {
      this.sidebar.setFocused(this.state.focusPane === "sidebar");
      this.mainList.setFocused(this.state.focusPane === "main");
      this.layout.setFocusedPane(this.state.focusPane);
   }

   private cycleFocusRight(): void {
      switch (this.state.focusPane) {
         case "sidebar":
            this.state.focusPane = "main";
            break;
         case "main":
            this.state.focusPane = "inspector";
            break;
         case "inspector":
            this.state.focusPane = "sidebar";
            break;
      }
      this.updateFocus();
   }

   private cycleFocusLeft(): void {
      switch (this.state.focusPane) {
         case "sidebar":
            this.state.focusPane = "inspector";
            break;
         case "main":
            this.state.focusPane = "sidebar";
            break;
         case "inspector":
            this.state.focusPane = "main";
            break;
      }
      this.updateFocus();
   }

   private handleExtensionToggle(extensionId: string, enabled: boolean): void {
      if (!this.settingsManager) return;

      if (enabled) {
         this.settingsManager.enableExtension(extensionId);
      } else {
         this.settingsManager.disableExtension(extensionId);
      }

      this.refreshFromState();
   }

   private refreshFromState(): void {
      const disabledIds = this.settingsManager?.getDisabledExtensions() ?? [];
      this.state = refreshState(this.state, this.cwd, disabledIds);
      this.sidebar.setTree(this.state.sidebarTree);
      this.mainList.setExtensions(this.state.extensions);
      if (this.state.selected) {
         this.inspector.setExtension(this.state.selected);
      }
   }

   handleInput(data: string): void {
      // Ctrl+C - close dashboard
      if (isCtrlC(data)) {
         this.onClose?.();
         return;
      }

      // Escape: Clear search if in main pane with query, otherwise close
      if (isEscape(data)) {
         if (this.state.focusPane === "main") {
            this.mainList.clearSearch();
         }
         this.onClose?.();
         return;
      }

      // Tab: Cycle focus right
      if (isTab(data)) {
         this.cycleFocusRight();
         return;
      }

      // Shift+Tab: Cycle focus left
      if (isShiftTab(data)) {
         this.cycleFocusLeft();
         return;
      }

      // Delegate to focused pane
      switch (this.state.focusPane) {
         case "sidebar":
            this.sidebar.handleInput(data);
            break;
         case "main":
            this.mainList.handleInput(data);
            break;
         case "inspector":
            // Inspector is read-only
            break;
      }
   }
}
