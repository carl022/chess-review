import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE is set in CI to "/<repo-name>/" so assets load from the Pages subpath.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
});
