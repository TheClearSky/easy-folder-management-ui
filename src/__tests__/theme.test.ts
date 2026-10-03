import { describe, expect, it, vi } from 'vitest';
import { cn } from '../ui/cn';
import {
  defaultEfmTheme,
  defaultEfmThemePresetName,
  efmThemePresetNames,
  efmThemePresets,
  lightEfmTheme,
  mergeThemes,
  resolveTheme,
} from '../ui/theme';
import type { EfmTheme, EfmThemePresetName } from '../ui/theme';

describe('theme/mergeThemes', () => {
  it('merges nested sections recursively, overrides winning per slot', () => {
    const base: EfmTheme = { fileSidebar: { root: 'bg-zinc-100', row: 'h-8' }, tabStrip: { tab: 'px-2' } };
    const merged = mergeThemes(base, { fileSidebar: { root: 'bg-red-500' } });
    expect(merged).toEqual({ fileSidebar: { root: 'bg-red-500', row: 'h-8' }, tabStrip: { tab: 'px-2' } });
  });

  it('keeps base values when override values are undefined', () => {
    const base: EfmTheme = { menu: { item: 'rounded' }, toaster: { toast: 'p-2' } };
    expect(mergeThemes(base, { menu: { item: undefined }, toaster: undefined })).toEqual(base);
  });

  it('REPLACES the base with null override values (unlike undefined)', () => {
    const base: EfmTheme = { menu: { item: 'rounded' }, toaster: { toast: 'p-2' } };
    const merged = mergeThemes(base, { toaster: null } as unknown as EfmTheme);
    expect(merged.toaster).toBeNull();
    expect(merged.menu).toEqual({ item: 'rounded' });
  });

  it('REPLACES strings and arrays instead of concatenating or merging index-wise', () => {
    const base = { menu: { item: 'a b' }, extra: ['x', 'y'] } as unknown as EfmTheme;
    const merged = mergeThemes(base, { menu: { item: 'c' }, extra: ['z'] } as unknown as EfmTheme) as unknown as {
      menu: { item: string };
      extra: string[];
    };
    expect(merged.menu.item).toBe('c');
    expect(merged.extra).toEqual(['z']);
  });

  it('REPLACES non-plain objects instead of merging them into {}', () => {
    const date = new Date(0);
    const merged = mergeThemes({ menu: { item: 'a' } }, { menu: date } as unknown as EfmTheme) as unknown as {
      menu: unknown;
    };
    expect(merged.menu).toBe(date);
  });

  it('ignores __proto__/constructor/prototype keys (JSON-sourced themes)', () => {
    const hostile = JSON.parse('{"__proto__":{"menu":{"item":"evil"}},"toaster":{"toast":"ok"}}') as EfmTheme;
    const merged = mergeThemes({}, hostile);
    expect(merged.menu).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.toaster).toEqual({ toast: 'ok' });
  });

  it('throws on circular overrides instead of overflowing the stack', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const base = { menu: { self: {} } } as unknown as EfmTheme;
    expect(() => mergeThemes(base, { menu: loop } as unknown as EfmTheme)).toThrow(/circular/);
  });

  it('does not mutate either input, and copies base without overrides', () => {
    const base: EfmTheme = { menu: { item: 'a' } };
    const overrides: EfmTheme = { menu: { hint: 'b' } };
    mergeThemes(base, overrides);
    expect(base).toEqual({ menu: { item: 'a' } });
    expect(overrides).toEqual({ menu: { hint: 'b' } });
    const copy = mergeThemes(base);
    expect(copy).toEqual(base);
    expect(copy).not.toBe(base);
  });
});

describe('theme/resolveTheme and presets', () => {
  it('names the presets; the default preset is intentionally empty', () => {
    expect(efmThemePresetNames).toEqual(['default', 'light']);
    expect(defaultEfmThemePresetName).toBe('default');
    expect(defaultEfmTheme).toEqual({});
    expect(efmThemePresets.light).toBe(lightEfmTheme);
  });

  it('resolves the default preset when none is named, overrides winning', () => {
    expect(resolveTheme()).toEqual({});
    expect(resolveTheme(undefined, { menu: { item: 'x' } })).toEqual({ menu: { item: 'x' } });
    const light = resolveTheme('light', { tabStrip: { tabActive: 'shadow-none' } });
    expect(light.tabStrip?.tabActive).toBe('shadow-none');
    expect(light.tabStrip?.root).toBe(lightEfmTheme.tabStrip?.root);
    expect(light.fileSidebar).toBe(lightEfmTheme.fileSidebar); // untouched sections alias the preset
  });

  it('warns and falls back to the default on an unknown preset name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveTheme('neon' as EfmThemePresetName, { menu: { item: 'x' } })).toEqual({ menu: { item: 'x' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unknown theme preset 'neon'"));
    warn.mockRestore();
  });

  it('deep-freezes every preset, so a resolved theme cannot corrupt one', () => {
    for (const name of efmThemePresetNames) {
      const preset = efmThemePresets[name];
      expect(Object.isFrozen(preset)).toBe(true);
      for (const section of Object.values(preset)) expect(Object.isFrozen(section)).toBe(true);
    }
    const resolved = resolveTheme('light');
    expect(() => {
      (resolved.fileSidebar as { root?: string }).root = 'mutated';
    }).toThrow(TypeError);
  });

  it('the light preset covers every component section, and spells its classes with the efm: prefix', () => {
    expect(Object.keys(lightEfmTheme).sort()).toEqual(
      ['choiceDialog', 'emptyState', 'fileSidebar', 'menu', 'panelError', 'tabStrip', 'toaster', 'unsavedDialog', 'welcome'],
    );
    for (const section of Object.values(lightEfmTheme)) {
      for (const value of Object.values(section as Record<string, string>)) {
        for (const token of value.split(/\s+/).filter(Boolean)) expect(token.startsWith('efm:'), token).toBe(true);
      }
    }
  });
});

describe('theme/cn conflict resolution (slot classes over efm: defaults)', () => {
  it('an unprefixed slot class beats the efm: default it conflicts with — only it survives', () => {
    expect(cn('efm:bg-surface', 'bg-[#123]')).toBe('bg-[#123]');
    expect(cn('efm:text-fg-muted', 'text-zinc-500')).toBe('text-zinc-500');
    expect(cn('efm:border-border', 'border-amber-700')).toBe('border-amber-700');
    expect(cn('efm:rounded-md', 'rounded-none')).toBe('rounded-none');
  });

  it('non-conflicting defaults survive the append', () => {
    expect(cn('efm:flex efm:px-2 efm:bg-surface efm:text-[13px]', 'bg-white text-zinc-900')).toBe(
      'efm:flex efm:px-2 efm:text-[13px] bg-white text-zinc-900',
    );
  });

  it('merges per variant: hover/data-highlighted/focus-visible/backdrop', () => {
    expect(cn('efm:hover:bg-hover', 'hover:bg-zinc-200')).toBe('hover:bg-zinc-200');
    expect(cn('efm:data-[highlighted]:bg-hover', 'data-[highlighted]:bg-amber-900')).toBe('data-[highlighted]:bg-amber-900');
    expect(cn('efm:focus-visible:shadow-[0_0_0_2px_var(--efm-focus,var(--efm-accent))]', 'focus-visible:shadow-none')).toBe(
      'focus-visible:shadow-none',
    );
    expect(cn('efm:backdrop:bg-overlay', 'backdrop:bg-black/30')).toBe('backdrop:bg-black/30');
    expect(cn('efm:hover:bg-hover', 'bg-white')).toBe('efm:hover:bg-hover bg-white');
  });

  it('a prefixed preset class beats a default too (the built-in presets are prefixed)', () => {
    expect(cn('efm:shadow-[inset_0_2px_0_var(--efm-accent)]', 'efm:shadow-[inset_0_-2px_0_var(--efm-accent)]')).toBe(
      'efm:shadow-[inset_0_-2px_0_var(--efm-accent)]',
    );
  });

  it('the token-fallback defaults are background/shadow utilities to tailwind-merge', () => {
    const active = 'efm:bg-[color:var(--efm-selection,color-mix(in_oklab,var(--efm-accent)_25%,transparent))]';
    // selected + active: the active background wins, as before the token existed
    expect(cn('efm:bg-hover', active)).toBe(active);
    expect(cn(active, 'bg-amber-900/40')).toBe('bg-amber-900/40');
    expect(cn('efm:shadow-[inset_0_0_0_1px_var(--efm-focus,var(--efm-fg-disabled))]', 'shadow-none')).toBe('shadow-none');
  });

  it('root var overrides pass through and dedupe per variable', () => {
    expect(cn('efm:bg-surface', '[--efm-accent:#e9d3a8]')).toBe('efm:bg-surface [--efm-accent:#e9d3a8]');
    expect(cn('[--efm-accent:#111]', '[--efm-accent:#e9d3a8]')).toBe('[--efm-accent:#e9d3a8]');
    expect(cn('[--efm-accent:#111]', '[--efm-surface:#fff]')).toBe('[--efm-accent:#111] [--efm-surface:#fff]');
  });

  it('descendant variants pass through untouched', () => {
    const escaped = String.raw`[&_.efm\:text-fg-muted]:text-[#e9a55a]`;
    const attribute = 'efm:[&_[class~="efm:text-fg-muted"]]:text-[#8c929b]';
    expect(cn('efm:text-fg', escaped)).toBe(`efm:text-fg ${escaped}`);
    expect(cn('efm:text-fg', attribute)).toBe(`efm:text-fg ${attribute}`);
  });
});
