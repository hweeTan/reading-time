import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/** Relax CSP in dev so Vite HMR / React Fast Refresh can connect and inject updates. */
function electronDevCsp(): Plugin {
  return {
    name: "electron-dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      const devCsp = [
        "default-src 'self' http://127.0.0.1:5173 http://localhost:5173",
        "script-src 'self' 'unsafe-inline' http://127.0.0.1:5173 http://localhost:5173",
        "style-src 'self' 'unsafe-inline' http://127.0.0.1:5173 http://localhost:5173",
        "connect-src 'self' ws://127.0.0.1:5173 ws://localhost:5173 http://127.0.0.1:5173 http://localhost:5173",
        "media-src 'self' blob: data:",
      ].join("; ");
      return html.replace(
        /http-equiv="Content-Security-Policy"\s+content="[^"]*"/,
        `http-equiv="Content-Security-Policy" content="${devCsp}"`
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  root: path.resolve(__dirname),
  // Dev loads from http://localhost:5173 — use "/" so HMR asset URLs resolve correctly.
  // Prod uses loadFile — keep relative base for bundled assets.
  base: command === "serve" ? "/" : "./",
  plugins: [
    react({ jsxRuntime: "automatic" }),
    electronDevCsp(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    hmr: {
      protocol: "ws",
      host: "127.0.0.1",
      port: 5173,
    },
  },
}));
