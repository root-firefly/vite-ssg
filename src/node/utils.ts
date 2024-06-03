import { blue, gray, yellow, dim, cyan } from 'kolorist'
import type { RouteRecordRaw } from 'vue-router'
import { ViteSSGOptions } from '../types'
import { dirname, join, } from 'node:path'
import fs from 'fs-extra'
import type { ResolvedConfig } from 'vite'

export function buildLog(text: string, count?: number) {
  // eslint-disable-next-line no-console
  console.log(`\n${gray('[vite-ssg]')} ${yellow(text)}${count ? blue(` (${count})`) : ''}`)
}

export function getSize(str: string) {
  return `${(str.length / 1024).toFixed(2)} KiB`
}

export function routesToPaths(routes?: Readonly<RouteRecordRaw[]>) {
  if (!routes)
    return ['/']

  const paths: Set<string> = new Set()

  const getPaths = (routes: Readonly<RouteRecordRaw[]>, prefix = '') => {
    // remove trailing slash
    prefix = prefix.replace(/\/$/g, '')
    for (const route of routes) {
      let path = route.path

      // check for leading slash
      if (route.path != null) {
        path = (prefix && !route.path.startsWith('/'))
          ? `${prefix}${route.path ? `/${route.path}` : ''}`
          : route.path

        paths.add(path)
      }
      if (Array.isArray(route.children))
        getPaths(route.children, path)
    }
  }

  getPaths(routes)
  return Array.from(paths)
}

export async function formatHtml(html: string, formatting: ViteSSGOptions['formatting']) {
  if (formatting === 'minify') {
    const htmlMinifier = await import('html-minifier')
    return htmlMinifier.minify(html, {
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


export async function whiteFile({ filename, html, out, outDir, config }: { filename: string, html: string, out: string, outDir: string, config: ResolvedConfig }) {
  await fs.ensureDir(join(out, dirname(filename)))
  await fs.writeFile(join(out, filename), html, 'utf-8')
  config.logger.info(
    `${dim(`${outDir}/`)}${cyan(filename.padEnd(15, ' '))}  ${dim(getSize(html))}`,
  )
}