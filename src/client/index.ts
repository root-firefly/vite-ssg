import type { Component } from 'vue'
import type { ViteSSGClientOptions, ViteSSGContext } from '../types'
import { createApp as createClientApp, createSSRApp } from 'vue'
import { ClientOnly } from './components/ClientOnly'

export * from '../types'

export function ViteSSG(
  App: Component,
  fn?: (context: ViteSSGContext) => Promise<void> | void,
  options: ViteSSGClientOptions = {},
) {
  const {
    registerComponents = true,
    rootContainer = '#app',
  } = options
  const isClient = typeof window !== 'undefined'

  async function createApp(client = false) {
    const app = client
      ? createClientApp(App)
      : createSSRApp(App)

    const context = { app, isClient }

    if (registerComponents)
      app.component('ClientOnly', ClientOnly)

    await fn?.(context)

    return context
  }

  if (isClient) {
    (async () => {
      const { app } = await createApp(true)
      app.mount(rootContainer, true)
    })()
  }

  return createApp
}
