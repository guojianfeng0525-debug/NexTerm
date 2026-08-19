/**
 * Layout Configuration and Management
 * Provides VS Code-like layout functionality
 */

import { prefGet, prefSet, prefDelete } from './preferences';

export interface LayoutConfig {
  leftSidebarVisible: boolean;
  leftSidebarSize: number;
  rightSidebarVisible: boolean;
  rightSidebarSize: number;
  bottomPanelVisible: boolean;
  bottomPanelSize: number;
  zenMode: boolean;
}

export interface LayoutPreset {
  name: string;
  description: string;
  config: LayoutConfig;
}

const DEFAULT_LAYOUT: LayoutConfig = {
  leftSidebarVisible: true,
  leftSidebarSize: 15,
  rightSidebarVisible: true,
  rightSidebarSize: 20,
  bottomPanelVisible: true,
  bottomPanelSize: 30,
  zenMode: false,
};

const LAYOUT_STORAGE_KEY = 'nexterm-layout-config';

export class LayoutManager {
  /**
   * Load layout configuration (SQLite preferences)
   */
  static loadLayout(): LayoutConfig {
    try {
      const config = prefGet<Partial<LayoutConfig> | null>(LAYOUT_STORAGE_KEY, null);
      if (config && typeof config === 'object') {
        return { ...DEFAULT_LAYOUT, ...config };
      }
    } catch (error) {
      console.error('Failed to load layout config:', error);
    }
    return DEFAULT_LAYOUT;
  }

  /**
   * Save layout configuration (SQLite preferences)
   */
  static saveLayout(config: LayoutConfig): void {
    try {
      prefSet(LAYOUT_STORAGE_KEY, config);
    } catch (error) {
      console.error('Failed to save layout config:', error);
    }
  }

  /**
   * Reset layout to default
   */
  static resetLayout(): LayoutConfig {
    prefDelete(LAYOUT_STORAGE_KEY);
    return DEFAULT_LAYOUT;
  }

  /**
   * Get predefined layout presets
   */
  static getPresets(): LayoutPreset[] {
    return [
      {
        name: 'Default',
        description: 'Directory bar + terminal with monitor and file browser',
        config: DEFAULT_LAYOUT,
      },
      {
        name: 'Minimal',
        description: 'Terminal only — hide directory bar, monitor and file browser',
        config: {
          leftSidebarVisible: false,
          leftSidebarSize: 15,
          rightSidebarVisible: false,
          rightSidebarSize: 20,
          bottomPanelVisible: false,
          bottomPanelSize: 30,
          zenMode: false,
        },
      },
      {
        name: 'Focus Mode',
        description: 'Directory bar + terminal, without monitor or file browser',
        config: {
          leftSidebarVisible: true,
          leftSidebarSize: 15,
          rightSidebarVisible: false,
          rightSidebarSize: 20,
          bottomPanelVisible: false,
          bottomPanelSize: 30,
          zenMode: false,
        },
      },
      {
        name: 'Full Stack',
        description: 'Directory bar + terminal + monitor + file browser',
        config: {
          leftSidebarVisible: true,
          leftSidebarSize: 15,
          rightSidebarVisible: true,
          rightSidebarSize: 20,
          bottomPanelVisible: true,
          bottomPanelSize: 35,
          zenMode: false,
        },
      },
      {
        name: 'Zen Mode',
        description: 'Distraction-free fullscreen terminal',
        config: {
          leftSidebarVisible: false,
          leftSidebarSize: 15,
          rightSidebarVisible: false,
          rightSidebarSize: 20,
          bottomPanelVisible: false,
          bottomPanelSize: 30,
          zenMode: true,
        },
      },
    ];
  }

  /**
   * Apply a preset layout
   */
  static applyPreset(presetName: string): LayoutConfig {
    const preset = this.getPresets().find(p => p.name === presetName);
    if (preset) {
      this.saveLayout(preset.config);
      return preset.config;
    }
    return DEFAULT_LAYOUT;
  }
}
