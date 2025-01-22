import Vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import createExternal from 'vite-plugin-external'

export default defineConfig(ssrBuild => ({
  plugins: [
    Vue({
      include: [/\.vue$/, /\.md$/],
    }),
    !ssrBuild.isSsrBuild && createExternal({
      interop: 'auto',
      externals: {
        vue: 'Vue',
      },
    }),
  ],
  ssgOptions: {
    script: 'async',
    // formatting: 'prettify',
    mock: true,
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `[name].js`,
        assetFileNames: '[name].[ext]',
      },
    },
  },
}))
