import type { EfmTheme } from './efmThemeTypes';
import { mergeThemes } from './mergeThemes';
import { defaultEfmThemePresetName, efmThemePresets } from './presets';
import type { EfmThemePresetName } from './presets';

/**
 * The effective theme: the named preset (default `'default'`) deep-merged with
 * the partial overrides, overrides winning. An unknown preset name (reachable
 * from untyped JS or a config string) warns and falls back to the default
 * instead of silently resolving from `undefined`.
 */
function resolveTheme(presetName?: EfmThemePresetName, overrides?: EfmTheme): EfmTheme {
  const requested = presetName ?? defaultEfmThemePresetName;
  const preset = efmThemePresets[requested];
  if (preset === undefined) {
    console.warn(
      `[easy-folder-management-ui] Unknown theme preset '${String(requested)}' — falling back to '${defaultEfmThemePresetName}'.`,
    );
    return mergeThemes(efmThemePresets[defaultEfmThemePresetName], overrides);
  }
  return mergeThemes(preset, overrides);
}

export { resolveTheme };
