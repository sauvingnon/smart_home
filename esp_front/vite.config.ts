import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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