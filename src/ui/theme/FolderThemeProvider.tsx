import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { EfmTheme } from './efmThemeTypes';
import { FolderThemeContext } from './FolderThemeContext';
import { defaultEfmThemePresetName } from './presets';
import type { EfmThemePresetName } from './presets';
import { resolveTheme } from './resolveTheme';

type FolderThemeProviderProps = {
  /** Named preset to start from. Default `'default'` (the built-in look). */
  preset?: EfmThemePresetName;
  /**
   * Partial theme deep-merged over the preset; overrides win per slot. Inline
   * object literals are safe: resolution is memoised STRUCTURALLY, so the
   * context value only changes when the theme's content changes.
   */
  theme?: EfmTheme;
  children?: ReactNode;
};

/**
 * Wrap it around the components (or the whole app) to theme them. Without it
 * every component keeps its default look. Providers do not inherit from outer
 * providers: the innermost one wins wholesale.
 */
function FolderThemeProvider({ preset, theme, children }: FolderThemeProviderProps) {
  // Structural memo (react-blender-nodes' GraphThemeProvider): an identity-
  // keyed useMemo would miss on every render for an inline `theme={{…}}`, and
  // each fresh context value re-renders every themed component (every tree
  // row). Themes are small JSON-ish data, so a stringify key is cheap; the
  // render-phase ref write is the derive-during-render pattern.
  const lastResolved = useRef<{ key: string; theme: EfmTheme } | null>(null);
  const key = `${preset ?? defaultEfmThemePresetName}|${theme === undefined ? '' : JSON.stringify(theme)}`;
  if (lastResolved.current?.key !== key) {
    lastResolved.current = { key, theme: resolveTheme(preset, theme) };
  }
  return <FolderThemeContext.Provider value={lastResolved.current.theme}>{children}</FolderThemeContext.Provider>;
}

export { FolderThemeProvider };
export type { FolderThemeProviderProps };
