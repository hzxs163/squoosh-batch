import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],

  // 👇 关键：适配 Cloudflare Pages 部署路径
  base: './',

  // 👇 构建输出配置（和 CF 构建设置一致）
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },

  // 👇 开发服务器配置
  server: {
    port: 26268,
    open: true,
  },
});
