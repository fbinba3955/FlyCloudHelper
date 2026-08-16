import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * 创建 FlyCloudHelper Web 的 Vite 配置。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(currentDirectory, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 9935,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:9934",
        // 保留浏览器访问时的 Host，供后台进行同源 CSRF 校验。
        changeOrigin: false,
      },
    },
  },
});
