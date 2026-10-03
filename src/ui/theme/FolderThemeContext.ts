import { createContext, useContext } from 'react';
import type { EfmTheme } from './efmThemeTypes';

/**
 * The optional theme context. No provider means `undefined`, and every
 * component keeps its default classes — zero change without a provider.
 * React context crosses portals, so the portaled menus read it too, and the
 * dialogs read it wherever their `element` is rendered. A leaf module (react
 * + types only): components import it without pulling in the presets.
 */
const FolderThemeContext = createContext<EfmTheme | undefined>(undefined);

/** The resolved theme of the nearest `FolderThemeProvider`; `undefined`
 *  without one (never throws). */
function useFolderTheme(): EfmTheme | undefined {
  return useContext(FolderThemeContext);
}

export { FolderThemeContext, useFolderTheme };
