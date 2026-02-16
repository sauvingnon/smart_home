import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3008,
    host: true, // разрешаем доступ извне контейнера
    strictPort: true, // использовать точно этот порт
  },
  preview: {
    port: 3008,
    host: true,
  }
})