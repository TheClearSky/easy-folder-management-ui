import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import dts from 'vite-plugin-dts';

// Library build, ES + CJS. Declarations are emitted per source file (not
// rolled). Entries: `.` (framework-free core), `./react` (hooks) and `./ui`
// (React components, whose stylesheet is extracted to dist/styles.css). Everything the package
// depends on stays external, so a consumer's single React (and single copy
// of each dependency) is the one used.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    dts({ tsconfigPath: './tsconfig.json', exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'playground/**'] }),
  ],
  build: {
    lib: {
      entry: { index: 'src/index.ts', react: 'src/react/index.ts', ui: 'src/ui/index.ts' },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        /^@headless-tree\//,
        /^@radix-ui\//,
        'clsx',
        'tailwind-merge',
      ],
    },
    sourcemap: false,
    emptyOutDir: true,
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'node',
  },
});
