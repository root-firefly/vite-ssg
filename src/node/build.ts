/* eslint-disable no-console */
import type { IAttribute } from 'html5parser'
import type { InlineConfig, ResolvedConfig } from 'vite'
import type { SSRContext } from 'vue/server-renderer'
import type { ViteSSGContext, ViteSSGOptions } from '../types'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse } from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { JSDOM } from 'jsdom'
import { blue, cyan, dim, gray, green, red } from 'kolorist'
import { mergeConfig, resolveConfig, build as viteBuild } from 'vite'
import { getBeasties } from './critical'
import { buildLog, getSize } from './utils'

export type Manifest = Record<string, string[]>

export type CreateAppFactory = (client: boolean, routePath?: string) => Promise<ViteSSGContext>

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

  if (fs.existsSync(out))
    await fs.remove(out)

  const mergedOptions = Object.assign({}, config.ssgOptions || {}, ssgOptions)
  const {
    script = 'sync',
    mock = false,
    formatting = 'none',
    onBeforePageRender,
    onPageRendered,
    onFinished,
    format = 'esm',
    rootContainerId = 'app',
    base,
    entry = await detectEntry(root),
    templateFile,
    template = 'index',
    entrys,
  }: ViteSSGOptions = mergedOptions

  const ssgEntrys = mergedOptions.entrys ?? []
  if (!entrys?.length && entry) {
    ssgEntrys.push({
      name: rootContainerId,
      template,
      entry,
      templateFile,
    })
  }

  const beastiesOptions = mergedOptions.beastiesOptions ?? {}

  if (fs.existsSync(ssgOutTempFolder))
    await fs.remove(ssgOutTempFolder)

  if (mock) {
    // @ts-expect-error just ignore it
    const { jsdomGlobal }: { jsdomGlobal: () => void } = await import('./jsdomGlobal.mjs')
    jsdomGlobal()
  }

  // server
  for (let i = 0; i < ssgEntrys.length; i++) {
    const { name, entry, template = 'index.html', templateFile } = ssgEntrys[i]
    buildLog(`Build ${name} start...`)

    process.env.VITE_SSG = 'false'
    await viteBuild(mergeConfig(viteConfig, {
      base,
      build: {
        rollupOptions: {
          input: {
            [name]: join(root, template),
          },
        },
      },
      mode: config.mode,
    }))

    const ssrEntry = await resolveAlias(config, entry)
    process.env.VITE_SSG = 'true'
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

    const serverEntry = prefix + join(ssgOut, parse(ssrEntry).name + ext).replace(/\\/g, '/')

    const _require = createRequire(import.meta.url)

    const { createApp }: { createApp: CreateAppFactory } = format === 'esm'
      ? await import(serverEntry)
      : _require(serverEntry)

    const beasties = beastiesOptions !== false
      ? await getBeasties(outDir, beastiesOptions)
      : undefined

    if (beasties)
      console.log(`${gray('[vite-ssg]')} ${blue('Critical CSS generation enabled via `beasties`')}`)

    let indexHTML = await fs.readFile(join(out, `${name}.html`), 'utf-8')
    indexHTML = rewriteScripts(indexHTML, script)

    const { renderToString }: typeof import('vue/server-renderer') = await import('vue/server-renderer')

    try {
      const appCtx = await createApp(false) as ViteSSGContext
      const { app } = appCtx

      const transformedIndexHTML = (await onBeforePageRender?.(indexHTML, appCtx)) || indexHTML

      const ctx: SSRContext = {}
      const appHTML = await renderToString(app, ctx)
      const renderedHTML = await renderHTML({
        rootContainerId,
        indexHTML: transformedIndexHTML,
        appHTML,
      })

      const jsdom = new JSDOM(renderedHTML)

      const html = jsdom.serialize()
      let transformed = (await onPageRendered?.(html, appCtx)) || html
      if (beasties)
        transformed = await beasties.process(transformed)

      const formatted = await formatHtml(transformed, formatting)
      if (templateFile) {
        const templateLiquidPath = isAbsolute(templateFile) ? templateFile : join(root, templateFile)
        const templateLiquid = await fs.readFile(templateLiquidPath, 'utf-8')
        const blockLiquid = await renderBlock({
          rootContainerId,
          indexHTML: transformed,
          appHTML,
          templateHTML: templateLiquid,
        })
        const blockFilename = `${name}.liquid`
        await fs.ensureDir(join(out, dirname(blockFilename)))
        await fs.writeFile(join(out, blockFilename), blockLiquid, 'utf-8')
      }

      const filename = `${name}.html`

      await fs.ensureDir(join(out, dirname(filename)))
      await fs.writeFile(join(out, filename), formatted, 'utf-8')
      config.logger.info(
        `${dim(`${outDir}/`)}${cyan(filename.padEnd(15, ' '))}  ${dim(getSize(formatted))}\n`,
      )
    }
    catch (err: any) {
      throw new Error(`${gray('[vite-ssg]')} ${red(`Error on page: `)}\n${err.stack}`)
    }
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
  return entry || 'src/main.js'
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
}: {
  rootContainerId: string
  indexHTML: string
  appHTML: string
},
) {
  const container = `<div id="${rootContainerId}"></div>`
  if (indexHTML.includes(container)) {
    return indexHTML
      .replace(
        container,
        () => `<div id="${rootContainerId}" data-server-rendered="true">${appHTML}</div>`,
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
        renderedOutput = `${indexHTMLBefore}<${node.name} ${attributesStringified} data-server-rendered="true">${appHTML}</${node.name}>${indexHTMLAfter}`
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

async function renderBlock({
  rootContainerId,
  indexHTML,
  appHTML,
  templateHTML,
}: {
  rootContainerId: string
  indexHTML: string
  appHTML: string
  templateHTML: string
}) {
  const htmlCtx = `<div id="${rootContainerId}" data-server-rendered="true">${appHTML}</div>`
  let styleOutput: string = ''
  let scriptOutput: string = ''

  const html5Parser = await import('html5parser')
  const ast = html5Parser.parse(indexHTML, { setAttributeMap: true })

  const searchTag = ['script', 'style', 'link']
  html5Parser.walk(ast, {
    enter: (node) => {
      if (node?.type === html5Parser.SyntaxKind.Tag
        && searchTag.includes(node.name)
        && !node.attributes.some(attr => attr.name.value === 'ignore') // ignore some test tag
      ) {
        if (node.name === 'script' || node.name === 'link') {
          const srcObj = getSrcName(node.attributes)
          if (!srcObj?.src)
            return
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

  return blockLiquid
}
