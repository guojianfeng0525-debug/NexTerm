import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from 'url';

const host = process.env.TAURI_DEV_HOST || '127.0.0.1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  build: {
    // Split heavyweight third-party libraries into stable vendor chunks so the
    // main entry stays small and unchanged vendors are cacheable. Function-form
    // manualChunks keeps the mapping close to the real dependency graph.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xterm')) return 'vendor-xterm';
          if (id.includes('@codemirror') || id.includes('/codemirror') || id.includes('@lezer')) return 'vendor-codemirror';
          if (id.includes('sql-formatter')) return 'vendor-sql-formatter';
          if (id.includes('/xlsx')) return 'vendor-xlsx';
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-recharts';
          if (id.includes('react') || id.includes('scheduler') || id.includes('react-dom')) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host,
    // WKWebView can resolve localhost to IPv6 while Vite listens on IPv4 (or
    // vice versa). Pin both the page and HMR client to one reachable endpoint.
    hmr: {
      protocol: "ws",
      host,
      port: 1420,
      clientPort: 1420,
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
