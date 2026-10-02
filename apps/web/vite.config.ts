import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Reads one token from tokens.css so the manifest and the page share the app's real colors. */
function token(name: string): string {
  const css = readFileSync(new URL("./src/styles/tokens.css", import.meta.url), "utf8");
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
  if (!value) throw new Error(`src/styles/tokens.css has no --${name}`);
  return value;
}

const surface0 = token("color-surface-0");

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
if (!html.includes(`<meta name="theme-color" content="${surface0}" />`)) {
  throw new Error(
    `index.html theme-color must equal --color-surface-0 (${surface0}) in tokens.css`,
  );
}

// Icons are generated at build time from public/favicon.svg by @vite-pwa/assets-generator.
// The mark already sits on surface-0, so no padding; Apple and maskable backgrounds match it.
const iconPreset = {
  transparent: { sizes: [64, 192, 512], favicons: [[48, "favicon.ico"]], padding: 0 },
  maskable: { sizes: [512], padding: 0, resizeOptions: { background: surface0 } },
  apple: { sizes: [180], padding: 0, resizeOptions: { background: surface0 } },
} satisfies Record<string, unknown>;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      pwaAssets: {
        image: "public/favicon.svg",
        preset: iconPreset as never,
        htmlPreset: "2023",
        includeHtmlHeadLinks: true,
        overrideManifestIcons: true,
        injectThemeColor: false,
      },
      manifest: {
        name: "Running Coach",
        short_name: "Coach",
        description: "Training plan, Garmin runs and a coach's review of each run.",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        theme_color: surface0,
        background_color: surface0,
      },
      workbox: {
        // App shell only. No runtimeCaching: API responses are never cached offline.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/health$/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  resolve: { tsconfigPaths: true },
  server: {
    proxy: { "/api": "http://localhost:3000" },
  },
  build: {
    outDir: "dist",
  },
});
