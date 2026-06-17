import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    environmentOptions: {
      jsdom: {
        url: "http://127.0.0.1:4174"
      }
    },
    setupFiles: "./src/test/setup.ts"
  }
});
