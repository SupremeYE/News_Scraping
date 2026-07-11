import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api 요청을 FastAPI 백엔드(localhost:8000)로 프록시한다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
