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
// @ts-expect-error shared ESM tokenizer used by VitePress and the build check
import { tokenizeSearch } from './search-tokenize.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const contentRoot = resolve(here, '../public')

// VitePress 1.6.4 hard-codes these screen-reader labels. Localize the three
// theme-owned labels at compile time so both SSR and client navigation agree.
function localizedThemeLabels() {
  return {
    name: 'hands-docs-localized-labels',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (id.includes('?')) return null
      const file = id.split('?')[0]
      const targets: Record<string, [string, string, string, string]> = {
        'VPNavBarMenu.vue': ['const { theme } = useData()', 'const { theme, lang } = useData()', 'Main Navigation', '主导航'],
        'VPSidebar.vue': ["import { inBrowser } from 'vitepress'", "import { inBrowser, useData } from 'vitepress'\nconst { lang } = useData()", 'Sidebar Navigation', '侧边导航'],
        'VPDocFooter.vue': ['const { theme, page, frontmatter } = useData()', 'const { theme, page, frontmatter, lang } = useData()', 'Pager', '页面导航'],
      }
      const entry = targets[file.slice(file.lastIndexOf('/') + 1)]
      if (!entry || !file.includes('/vitepress/dist/client/theme-default/components/')) return null
      const [oldSetup, newSetup, english, chinese] = entry
      if (!source.includes(oldSetup) || !source.includes(english)) {
        throw new Error(`Cannot localize the pinned VitePress component: ${file}`)
      }
      return source.replace(oldSetup, newSetup).replace(english, `{{ lang === 'zh-CN' ? '${chinese}' : '${english}' }}`)
    },
  }
}
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
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Hands 文档',
      description: 'Hands 的产品、管理、命令行和 API 文档。',
      link: '/zh/',
      themeConfig: {
        nav: [
          { text: '文档', link: '/zh/' },
          { text: 'SDK 与 API', link: '/zh/cli-reference/' },
          { text: 'API 浏览器', link: 'https://hands.build/api-docs' },
        ],
        outline: { label: '本页目录' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        langMenuLabel: '切换语言',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '返回顶部',
        skipToContentLabel: '跳转到正文',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换为浅色主题',
        darkModeSwitchTitle: '切换为深色主题',
      },
    },
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
    search: {
      provider: 'local',
      options: {
        miniSearch: { options: { tokenize: tokenizeSearch } },
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '清空搜索',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有找到相关结果：',
                footer: {
                  selectText: '选择', selectKeyAriaLabel: '回车键',
                  navigateText: '切换', navigateUpKeyAriaLabel: '上方向键',
                  navigateDownKeyAriaLabel: '下方向键', closeText: '关闭', closeKeyAriaLabel: '退出键',
                },
              },
            },
          },
        },
      },
    },
  },
  vite: { plugins: [localizedThemeLabels()] },
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
    const twinPath = relative === 'zh/index.md' ? '/zh/index.md' : pageTwinPath(docsConfig, relative)
    const twin = `${docsConfig.siteUrl}${joinPath(twinPath)}`
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
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    config(md) {
      const originalLink = md.renderer.rules.link_open
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const raw = tokens[index].attrGet('href') ?? ''
        const rendered = originalLink
          ? originalLink(tokens, index, options, env, self)
          : self.renderToken(tokens, index, options)
        if (raw.startsWith('#') && env.relativePath.startsWith('zh/')) {
          return rendered.replace('aria-label="Permalink to ', 'aria-label="跳转到 ')
        }
        // VitePress emits relative links for sibling Markdown pages. After
        // moving foo.html to foo/index.html those resolve under /foo/, so make
        // them absolute for both prerendered HTML and client-side navigation.
        if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(raw)) return rendered
        const target = new URL(raw, `https://docs.invalid/${env.relativePath}`)
        if (!target.pathname.endsWith('.md')) return rendered
        const path = target.pathname.replace(/(?:^|\/)index\.md$/, '/').replace(/\.md$/, '/')
        const href = `/docs${path}${target.search}${target.hash}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        return rendered.replace(/href="[^"]*"/, `href="${href}"`)
      }
    },
  },
})
