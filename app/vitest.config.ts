import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
    // lib code under ../lib/dist must use the app's single vendored copy, not lib/node_modules.
    dedupe: ['@bsv/sdk', '@bsv/templates', '@bsv/message-box-client']
  },
  test: { environment: 'node' }
})
