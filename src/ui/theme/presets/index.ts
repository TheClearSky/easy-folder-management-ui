import type { EfmTheme } from '../efmThemeTypes';
import { defaultEfmTheme } from './defaultEfmTheme';
import { lightEfmTheme } from './lightEfmTheme';

const efmThemePresetNames = ['default', 'light'] as const;

type EfmThemePresetName = (typeof efmThemePresetNames)[number];

const defaultEfmThemePresetName: EfmThemePresetName = 'default';

// Presets are module singletons, and resolved themes alias their untouched
// sections by reference (mergeThemes copies only what an override touches).
// Freezing turns an accidental mutation of a resolved theme into a loud
// TypeError instead of a silent change to every later resolution.
function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const efmThemePresets: Record<EfmThemePresetName, EfmTheme> = {
  default: deepFreeze(defaultEfmTheme),
  light: deepFreeze(lightEfmTheme),
};

export { defaultEfmTheme, defaultEfmThemePresetName, efmThemePresetNames, efmThemePresets, lightEfmTheme };
export type { EfmThemePresetName };
