import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 1420,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
});
