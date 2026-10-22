import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
    // lib code under ../lib/dist must use the app's single vendored copy, not lib/node_modules.
    dedupe: ['@bsv/sdk', '@bsv/templates', '@bsv/message-box-client']
  },
  optimizeDeps: { exclude: ['@bsv/sdk'] },
  server: { port: 5173 }
})
