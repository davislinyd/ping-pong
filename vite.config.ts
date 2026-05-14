import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  root: "src/client",
  envDir: "../../",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
});
