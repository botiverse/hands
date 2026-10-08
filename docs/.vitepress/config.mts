// Hands docs site — VitePress wired from docs.config.mjs via the docs-kit.
// Preserves the old site's URL contract: /docs/<slug>/ HTML, /docs/<slug>.md
// twins, /docs/zh/... and the /docs.md + /docs/zh.md machine indexes (twins
// and indexes are emitted by the kit's generator after this build).
import { defineConfig } from 'vitepress'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
// @ts-expect-error plain ESM source from the docs-kit package
import { collectLocalePaths } from '@botiverse/docs-kit/content'
// @ts-expect-error plain ESM source from the docs-kit package
import { pageTwinPath } from '@botiverse/docs-kit/config'
// @ts-expect-error plain ESM module (repo root)
import docsConfig from '../../docs.config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const contentRoot = resolve(here, '../public')
const translated = Object.fromEntries(
  Object.entries(collectLocalePaths(docsConfig, { root: resolve(here, '../..') })).map(
    ([key, paths]) => [key, [...(paths as Set<string>)].sort()],
  ),
)

type PageMeta = { slug: string; title: string; description: string; category: string; order: number }

function frontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(markdown)
  const data: Record<string, string> = {}
  if (!match) return data
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (m) data[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return data
}

function pagesFor(localeDir: string): PageMeta[] {
  const dir = localeDir ? resolve(contentRoot, localeDir) : contentRoot
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md')
    .map((entry) => {
      const meta = frontmatter(readFileSync(resolve(dir, entry.name), 'utf8'))
      return {
        slug: entry.name.replace(/\.md$/, ''),
        title: meta.title ?? entry.name,
        description: meta.description ?? '',
        category: meta.category ?? 'Other',
        order: Number(meta.order ?? Number.MAX_SAFE_INTEGER),
      }
    })
}

function sidebarFor(localeDir: string) {
  const locale = docsConfig.locales.find((l: { dir: string }) => l.dir === localeDir)
  const chrome = (locale?.chrome ?? {}) as Record<string, string>
  const categoryLabels = (chrome as { categories?: Record<string, string> }).categories ?? {}
  const pages = pagesFor(localeDir)
  const groups = new Map<string, PageMeta[]>()
  for (const page of pages) {
    const list = groups.get(page.category) ?? []
    list.push(page)
    groups.set(page.category, list)
  }
  const configured: string[] = docsConfig.nav.categories
  const ordered = [
    ...configured.filter((category) => groups.has(category)),
    ...[...groups.keys()].filter((category) => !configured.includes(category)).sort(),
  ]
  return ordered.map((category) => ({
    text: categoryLabels[category] ?? category,
    items: groups
      .get(category)!
      .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
      .map((page) => ({
        text: page.title,
        link: localeDir ? `/${localeDir}/${page.slug}` : `/${page.slug}`,
      })),
  }))
}

export default defineConfig({
  title: 'Hands Docs',
  description: 'Product, admin, CLI, and API documentation for Hands.',
  base: '/docs/',
  srcDir: 'public',
  outDir: '../admin/public/docs',
  srcExclude: ['agc-market-packages/**'],
  cleanUrls: true,
  ignoreDeadLinks: ['/api-docs'],
  locales: {
    root: { label: 'English', lang: 'en' },
    zh: { label: '中文', lang: 'zh-CN', title: 'Hands 文档', link: '/zh/' },
  },
  themeConfig: {
    docsKit: { translated },
    nav: docsConfig.brand.headerNav
      .filter((item: { label: string; href: string; primary?: boolean }) => !item.primary)
      .map((item: { label: string; href: string }) => ({
        text: item.label,
        link: item.href,
      })),
    sidebar: { '/': sidebarFor(''), '/zh/': sidebarFor('zh') },
    search: { provider: 'local' },
  },
  head: [['link', { rel: 'icon', href: '/favicon.svg' }]],
  transformHead({ pageData }) {
    if (!pageData.relativePath.endsWith('.md')) return []
    const relative = pageData.relativePath
    const route = relative === 'index.md'
      ? '/'
      : relative.endsWith('/index.md')
        ? `/${relative.slice(0, -'/index.md'.length)}/`
        : `/${relative.replace(/\.md$/, '/')}`
    const joinPath = (path: string) => `${docsConfig.basePath}${path}`.replace(/\/{2,}/g, '/')
    const human = `${docsConfig.siteUrl}${joinPath(route.slice(1))}`
    const twin = `${docsConfig.siteUrl}${joinPath(pageTwinPath(docsConfig, relative))}`
    return [
      ['link', { rel: 'canonical', href: human }],
      ['link', { rel: 'alternate', type: 'text/markdown', href: twin }],
    ]
  },
  async transformHtml(html) {
    // The URL contract is directory style (/docs/<slug>/ served from
    // <slug>/index.html), so move VitePress' extensionless routes to their
    // trailing-slash form, and un-prefix the two nav targets that live
    // outside the docs base. Applies to rendered anchors and the serialized
    // router/sidebar data in the same document.
    return html
      .replaceAll('/docs/docs/', '/docs/')
      .replaceAll('/docs/api-docs', '/api-docs')
      .replaceAll('/docs/api/auth', '/api/auth')
      .replace(/href="\/docs\/((?:zh\/)?[A-Za-z0-9_-]+)"/g, 'href="/docs/$1/"')
      .replace(/"href":"\/docs\/((?:zh\/)?[A-Za-z0-9_-]+)"/g, '"href":"/docs/$1/"')
  },
  markdown: { theme: { light: 'github-light', dark: 'github-dark' } },
})
