import type { EfmTheme } from '../efmThemeTypes';

/**
 * The built-in look. Intentionally EMPTY: the components' default classes ARE
 * this preset, so applying it changes nothing — it exists as a named base for
 * overrides and an explicit way to ask for the default look.
 */
const defaultEfmTheme: EfmTheme = {};

export { defaultEfmTheme };
