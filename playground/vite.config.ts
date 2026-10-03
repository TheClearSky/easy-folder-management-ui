import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev-only page that renders the components from SOURCE on a bare page.
export default defineConfig({ root: __dirname, plugins: [react(), tailwindcss()] });
