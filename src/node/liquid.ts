import type { RollupOutput, RollupWatcher, OutputChunk, OutputAsset } from 'rollup'
import type { ViteSSGContext, ViteSSGOptions } from '../types'
import { formatHtml } from './utils'
import { copy } from 'fs-extra'
import { join } from 'node:path'

type AssetType = OutputChunk | OutputAsset
export function collectAssets(source: RollupOutput | RollupOutput[] | RollupWatcher) {
  if ("change" in source) return []

  const assets: RollupOutput[] = Array.isArray(source) ? source : [source as RollupOutput]
  const assetList: AssetType[] = []
  assets.forEach(item => {
    assetList.push(...item.output)
  })
  const assetNames: string[] = []

  assetList.forEach(item => {
    const name = item.fileName
    if (name.endsWith('.js') || name.endsWith('.css')) {
      assetNames.push(name)
    }
  })

  return assetNames
}

export function genAssetsStr(assetNames: string[], extraLiquid: string | undefined) {
  let assetsStr = ''
  if (extraLiquid) assetsStr += `${extraLiquid}\n`

  assetNames.forEach(name => {
    if (name.endsWith('.css')) {
      assetsStr += `{{ '${name}' | asset_url | stylesheet_tag }}\n`
    } else if (name.endsWith('.iife.js')) {
      assetsStr += `<script nomodule src="{{ '${name}' | asset_url }}" defer></script>\n`
    } else if (name.endsWith('.js')) {
      assetsStr += `<script type="module" src="{{ '${name}' | asset_url }}" defer></script>\n`
    }
  })

  return assetsStr
}

export async function genLiquid({
  rootContainerId,
  appHTML,
  appCtx,
  initialState,
  formatting
}: {
  rootContainerId: string
  indexHTML: string
  appHTML: string
  initialState: any,
  appCtx: ViteSSGContext<true>,
  formatting: ViteSSGOptions['formatting']
}) {
  const { app } = appCtx
  const stateScript = initialState
    ? `\n<script>window.__INITIAL_STATE__=${initialState}</script>`
    : ''

  const schema = ((app._component as any).__schema__ as Record<string, any>) || undefined
  let schemaStr = schema ? `{% schema %}
${JSON.stringify(schema)}
{% endschema %}` : ''

  const formattedAppHTML = await formatHtml(appHTML, formatting)
  return `<div id="${rootContainerId}" data-server-rendered="true">${formattedAppHTML}</div>
  
${stateScript}

${schemaStr}`
}


async function copyFile(name: string, outDir: string, targetDir: string) {
  await copy(join(outDir, name), join(targetDir, name))
}

export async function copyToDist(assetNames: string[], out: string, target?: string) {
  if (!target) return
  const assets = assetNames.filter(name => name.endsWith('.js') || name.endsWith('.css'))

  assets.forEach(async name => {
    await copyFile(name, out, join(target, 'assets'))
  })

  const sections = assetNames.filter(name => name.endsWith('.liquid'))
  sections.forEach(async name => {
    await copyFile(name, out, join(target, 'sections'))
  })
}