import type { IAttribute } from 'html5parser'
/* eslint-disable no-console */
// import type { RouteRecordRaw } from 'vue-router'
import type { InlineConfig, ResolvedConfig } from 'vite'
import type { SSRContext } from 'vue/server-renderer'
import type { ViteSSGContext, ViteSSGOptions } from '../types'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse } from 'node:path'
import process from 'node:process'
import { renderDOMHead } from '@unhead/dom'
import fs from 'fs-extra'
import { JSDOM } from 'jsdom'
import { blue, cyan, dim, gray, green, red, yellow } from 'kolorist'
// import PQueue from 'p-queue'
import { mergeConfig, resolveConfig, build as viteBuild } from 'vite'
import { serializeState } from '../utils/state'
import { getBeasties } from './critical'
import { renderPreloadLinks } from './preload-links'
import { buildLog, getSize } from './utils'

export type Manifest = Record<string, string[]>

export type CreateAppFactory = (client: boolean, routePath?: string) => Promise<ViteSSGContext<true> | ViteSSGContext<false>>

// function DefaultIncludedRoutes(paths: string[], _routes: Readonly<RouteRecordRaw[]>) {
//   // ignore dynamic routes
//   return paths.filter(i => !i.includes(':') && !i.includes('*'))
// }

export async function build(ssgOptions: Partial<ViteSSGOptions> = {}, viteConfig: InlineConfig = {}) {
  const nodeEnv = process.env.NODE_ENV || 'production'
  const mode = process.env.MODE || ssgOptions.mode || nodeEnv
  const config = await resolveConfig(viteConfig, 'build', mode, nodeEnv)

  const cwd = process.cwd()
  const root = config.root || cwd
  const ssgOutTempFolder = join(root, '.vite-ssg-temp')
  const ssgOut = join(ssgOutTempFolder, Math.random().toString(36).substring(2, 12))
  const outDir = config.build.outDir || 'dist'
  const out = isAbsolute(outDir) ? outDir : join(root, outDir)

  const mergedOptions = Object.assign({}, config.ssgOptions || {}, ssgOptions)
  const {
    script = 'sync',
    mock = false,
    entry = await detectEntry(root),
    formatting = 'none',
    // includedRoutes: configIncludedRoutes = DefaultIncludedRoutes,
    onBeforePageRender,
    onPageRendered,
    onFinished,
    // dirStyle = 'flat',
    // includeAllRoutes = false,
    format = 'esm',
    // concurrency = 20,
    rootContainerId = 'app',
    base,
  }: ViteSSGOptions = mergedOptions

  const beastiesOptions = mergedOptions.beastiesOptions ?? {}

  if (fs.existsSync(ssgOutTempFolder))
    await fs.remove(ssgOutTempFolder)

  // client
  buildLog('Build for client...')
  await viteBuild(mergeConfig(viteConfig, {
    base,
    build: {
      ssrManifest: true,
      rollupOptions: {
        input: {
          app: join(root, './index.html'),
        },
      },
    },
    mode: config.mode,
  }))

  // load jsdom before building the SSR and so jsdom will be available
  if (mock) {
    // @ts-expect-error just ignore it
    const { jsdomGlobal }: { jsdomGlobal: () => void } = await import('./jsdomGlobal.mjs')
    jsdomGlobal()
  }

  // server
  buildLog('Build for server...')
  process.env.VITE_SSG = 'true'
  const ssrEntry = await resolveAlias(config, entry)
  await viteBuild(mergeConfig(viteConfig, {
    base,
    build: {
      ssr: ssrEntry,
      outDir: ssgOut,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: {
        output: format === 'esm'
          ? {
              entryFileNames: '[name].mjs',
              format: 'esm',
            }
          : {
              entryFileNames: '[name].cjs',
              format: 'cjs',
            },
      },
    },
    mode: config.mode,
  }))

  const prefix = (format === 'esm' && process.platform === 'win32') ? 'file://' : ''
  const ext = format === 'esm' ? '.mjs' : '.cjs'

  /**
   * `join('file://')` will be equal to `'file:\'`, which is not the correct file protocol and will fail to be parsed under bun.
   * It is changed to '+' splicing here.
   */
  const serverEntry = prefix + join(ssgOut, parse(ssrEntry).name + ext).replace(/\\/g, '/')

  const _require = createRequire(import.meta.url)

  const { createApp }: { createApp: CreateAppFactory } = format === 'esm'
    ? await import(serverEntry)
    : _require(serverEntry)
  // const includedRoutes = serverEntryIncludedRoutes || configIncludedRoutes
  // const { routes } = await createApp(false)

  // let routesPaths = includeAllRoutes
  //   ? routesToPaths(routes)
  //   : await includedRoutes(routesToPaths(routes), routes || [])

  // // uniq
  // routesPaths = Array.from(new Set(routesPaths))

  // buildLog('Rendering Pages...', routesPaths.length)

  const beasties = beastiesOptions !== false
    ? await getBeasties(outDir, beastiesOptions)
    : undefined

  if (beasties)
    console.log(`${gray('[vite-ssg]')} ${blue('Critical CSS generation enabled via `beasties`')}`)

  const {
    path: _ssrManifestPath,
    content: ssrManifestRaw,
  } = await readFiles(
    join(out, '.vite', 'ssr-manifest.json'), // Vite 5
    join(out, 'ssr-manifest.json'), // Vite 4 and below
  )
  const ssrManifest: Manifest = JSON.parse(ssrManifestRaw)
  let indexHTML = await fs.readFile(join(out, 'index.html'), 'utf-8')
  indexHTML = rewriteScripts(indexHTML, script)

  const { renderToString }: typeof import('vue/server-renderer') = await import('vue/server-renderer')

  // const queue = new PQueue({ concurrency })

  // for (const route of routesPaths) {
  //   queue.add(async () => {
  //     try {
  //       const appCtx = await createApp(false, route) as ViteSSGContext<true>
  //       const { app, router, head, initialState, triggerOnSSRAppRendered, transformState = serializeState } = appCtx

  //       if (router) {
  //         await router.push(route)
  //         await router.isReady()
  //       }

  //       const transformedIndexHTML = (await onBeforePageRender?.(route, indexHTML, appCtx)) || indexHTML

  //       const ctx: SSRContext = {}
  //       const appHTML = await renderToString(app, ctx)
  //       await triggerOnSSRAppRendered?.(route, appHTML, appCtx)
  //       // need to resolve assets so render content first
  //       const renderedHTML = await renderHTML({
  //         rootContainerId,
  //         indexHTML: transformedIndexHTML,
  //         appHTML,
  //         initialState: transformState(initialState),
  //       })

  //       // create jsdom from renderedHTML
  //       const jsdom = new JSDOM(renderedHTML)

  //       // render current page's preloadLinks
  //       renderPreloadLinks(jsdom.window.document, ctx.modules || new Set<string>(), ssrManifest)

  //       // render head
  //       if (head)
  //         await renderDOMHead(head, { document: jsdom.window.document })

  //       const html = jsdom.serialize()
  //       let transformed = (await onPageRendered?.(route, html, appCtx)) || html
  //       if (beasties)
  //         transformed = await beasties.process(transformed)

  //       const formatted = await formatHtml(transformed, formatting)

  //       const relativeRouteFile = `${(route.endsWith('/')
  //         ? `${route}index`
  //         : route).replace(/^\//g, '')}.html`

  //       const filename = dirStyle === 'nested'
  //         ? join(route.replace(/^\//g, ''), 'index.html')
  //         : relativeRouteFile

  //       await fs.ensureDir(join(out, dirname(filename)))
  //       await fs.writeFile(join(out, filename), formatted, 'utf-8')
  //       config.logger.info(
  //         `${dim(`${outDir}/`)}${cyan(filename.padEnd(15, ' '))}  ${dim(getSize(formatted))}`,
  //       )
  //     }
  //     catch (err: any) {
  //       throw new Error(`${gray('[vite-ssg]')} ${red(`Error on page: ${cyan(route)}`)}\n${err.stack}`)
  //     }
  //   })
  // }

  try {
    const appCtx = await createApp(false) as ViteSSGContext<true>
    const { app, head, initialState, triggerOnSSRAppRendered, transformState = serializeState } = appCtx

    // if (router) {
    //   await router.push(route)
    //   await router.isReady()
    // }

    const transformedIndexHTML = (await onBeforePageRender?.('', indexHTML, appCtx)) || indexHTML

    const ctx: SSRContext = {}
    const appHTML = await renderToString(app, ctx)
    await triggerOnSSRAppRendered?.('', appHTML, appCtx)
    // need to resolve assets so render content first
    const renderedHTML = await renderHTML({
      rootContainerId,
      indexHTML: transformedIndexHTML,
      appHTML,
      initialState: transformState(initialState),
    })

    // create jsdom from renderedHTML
    const jsdom = new JSDOM(renderedHTML)

    // render current page's preloadLinks
    renderPreloadLinks(jsdom.window.document, ctx.modules || new Set<string>(), ssrManifest)

    // render head
    if (head)
      await renderDOMHead(head, { document: jsdom.window.document })

    const html = jsdom.serialize()
    let transformed = (await onPageRendered?.('', html, appCtx)) || html
    if (beasties)
      transformed = await beasties.process(transformed)

    const formatted = await formatHtml(transformed, formatting)

    // const relativeRouteFile = `${(route.endsWith('/')
    //   ? `${route}index`
    //   : route).replace(/^\//g, '')}index.html`

    const filename = 'index.html'

    await fs.ensureDir(join(out, dirname(filename)))
    await fs.writeFile(join(out, filename), formatted, 'utf-8')
    config.logger.info(
      `${dim(`${outDir}/`)}${cyan(filename.padEnd(15, ' '))}  ${dim(getSize(formatted))}`,
    )
  }
  catch (err: any) {
    throw new Error(`${gray('[vite-ssg]')} ${red(`Error on page: `)}\n${err.stack}`)
  }

  await fs.remove(ssgOutTempFolder)

  console.log(`\n${gray('[vite-ssg]')} ${green('Build finished.')}`)

  await onFinished?.()
}

async function detectEntry(root: string) {
  // pick the first script tag of type module as the entry
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const scriptSrcReg = /<script.*?src=["'](.+?)["'](?!<).*>\s*<\/script>/gi
  const html = await fs.readFile(join(root, 'index.html'), 'utf-8')
  const scripts = [...html.matchAll(scriptSrcReg)]
  const [, entry] = scripts.find((matchResult) => {
    const [script] = matchResult
    const [, scriptType] = script.match(/.*\stype=(?:'|")?([^>'"\s]+)/i) || []
    return scriptType === 'module'
  }) || []
  return entry || 'src/main.ts'
}

async function resolveAlias(config: ResolvedConfig, entry: string) {
  const resolver = config.createResolver()
  const result = await resolver(entry, config.root)
  return result || join(config.root, entry)
}

function rewriteScripts(indexHTML: string, mode?: string) {
  if (!mode || mode === 'sync')
    return indexHTML
  return indexHTML.replace(/<script type="module" /g, `<script type="module" ${mode} `)
}

async function renderHTML({
  rootContainerId,
  indexHTML,
  appHTML,
  initialState,
}: {
  rootContainerId: string
  indexHTML: string
  appHTML: string
  initialState: any
},
) {
  const stateScript = initialState
    ? `\n<script>window.__INITIAL_STATE__=${initialState}</script>`
    : ''
  const container = `<div id="${rootContainerId}"></div>`
  if (indexHTML.includes(container)) {
    return indexHTML
      .replace(
        container,
        () => `<div id="${rootContainerId}" data-server-rendered="true">${appHTML}</div>${stateScript}`,
      )
  }

  const html5Parser = await import('html5parser')
  const ast = html5Parser.parse(indexHTML)
  let renderedOutput: string | undefined

  html5Parser.walk(ast, {
    enter: (node) => {
      if (!renderedOutput
        && node?.type === html5Parser.SyntaxKind.Tag
        && Array.isArray(node.attributes)
        && node.attributes.length > 0
        && node.attributes.some(attr => attr.name.value === 'id' && attr.value?.value === rootContainerId)
      ) {
        const attributesStringified = [...node.attributes.map(({ name: { value: name }, value }) => `${name}="${value!.value}"`)].join(' ')
        const indexHTMLBefore = indexHTML.slice(0, node.start)
        const indexHTMLAfter = indexHTML.slice(node.end)
        renderedOutput = `${indexHTMLBefore}<${node.name} ${attributesStringified} data-server-rendered="true">${appHTML}</${node.name}>${stateScript}${indexHTMLAfter}`
      }
    },
  })

  if (!renderedOutput)
    throw new Error(`Could not find a tag with id="${rootContainerId}" to replace it with server-side rendered HTML`)

  return renderedOutput
}

async function formatHtml(html: string, formatting: ViteSSGOptions['formatting']) {
  if (formatting === 'minify') {
    const htmlMinifier = await import('html-minifier-terser')
    return await htmlMinifier.minify(html, {
      collapseWhitespace: true,
      caseSensitive: true,
      collapseInlineTagWhitespace: false,
      minifyJS: true,
      minifyCSS: true,
    })
  }
  else if (formatting === 'prettify') {
    const prettier = (await import('prettier')).default
    return await prettier.format(html, { semi: false, parser: 'html' })
  }
  return html
}

async function readFiles(...paths: string[]) {
  for (const path of paths) {
    if (fs.existsSync(path)) {
      return {
        path,
        content: await fs.readFile(path, 'utf-8'),
      }
    }
  }
  throw new Error(`Could not find any of the following files: ${paths.join(', ')}`)
}

function genAttrstr(attributes: IAttribute[]) {
  const others = attributes.filter(attr => attr.name.value !== 'src' && attr.name.value !== 'href')
  return [...others.map(({ name: { value: name }, value }) => value ? `${name}="${value!.value}"` : name)].join(' ')
}

function getSrcName(attributes: IAttribute[]) {
  const srcAttr = attributes.find(attr => attr.name.value === 'src' || attr.name.value === 'href')
  if (srcAttr?.value?.value) {
    return {
      name: srcAttr.name.value,
      src: basename(srcAttr?.value?.value),
    }
  }
}

// eslint-disable-next-line unused-imports/no-unused-vars
async function renderBlock({
  rootContainerId,
  indexHTML,
  appHTML,
  initialState,
  templateHTML,
  copyFilter = [],
}: {
  rootContainerId: string
  indexHTML: string
  appHTML: string
  initialState: any
  templateHTML: string
  copyFilter: string[]
}) {
  const stateScript = initialState
    ? `\n<script>window.__INITIAL_STATE__=${initialState}</script>`
    : ''
  const htmlCtx = `<div id="${rootContainerId}" data-server-rendered="true">${appHTML}</div>${stateScript}`
  let styleOutput: string = ''
  let scriptOutput: string = ''

  const html5Parser = await import('html5parser')
  const ast = html5Parser.parse(indexHTML, { setAttributeMap: true })

  const searchTag = ['script', 'style', 'link']
  const blockFiles: string[] = []
  html5Parser.walk(ast, {
    enter: (node) => {
      if (node?.type === html5Parser.SyntaxKind.Tag
        && searchTag.includes(node.name)
        && (copyFilter.some(name => node.attributeMap?.src?.value?.value.includes(name) || node.attributeMap?.href?.value?.value.includes(name)) || node.name === 'style')
      ) {
        if (node.name === 'script' || node.name === 'link') {
          const srcObj = getSrcName(node.attributes)
          if (!srcObj?.src)
            return
          blockFiles.push(srcObj.src)
          const tagHtml = `<${node.name} ${genAttrstr(node.attributes)} ${srcObj.name}="{{ '${srcObj.src}' | asset_url }}"></${node.name}>\n`
          if (node.name === 'link') {
            styleOutput += tagHtml
          }
          else {
            scriptOutput += tagHtml
          }
        }
        if (node.name === 'style') {
          const styleHtml = indexHTML.slice(node.start, node.end)

          styleOutput = `${styleHtml}\n${styleOutput}`
        }
      }
    },
  })

  const blockLiquid = styleOutput + templateHTML.replace('{%html%}', htmlCtx).replace('{%script%}', scriptOutput)

  return {
    blockLiquid,
    blockFiles,
  }
}
