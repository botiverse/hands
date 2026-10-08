// Hands docs site declaration, consumed by the docs-kit (theme + agent
// artifacts). Mirrors raft-docs' docs.config.mjs with the Hands shape: /docs
// base path, flat slugs, en + zh locales, index twins at /docs.md (above the
// output dir) and /docs/zh.md (inside it).
import { defineDocsConfig } from '@botiverse/docs-kit/config'

export default defineDocsConfig({
  siteUrl: 'https://hands.build',
  basePath: '/docs/',
  routing: 'flat',
  locales: [
    {
      key: 'en',
      dir: '',
      label: 'English',
      htmlLang: 'en',
      chrome: {
        openRaft: 'Login',
        markdownIndexTitle: '# Hands Documentation',
        markdownIndexNote:
          'Machine-readable index. Every page below has a raw-markdown twin at\n`/docs/<slug>.md` (this index is `/docs.md`). Fetch those for clean,\nchrome-free content — no HTML or JavaScript.',
      },
    },
    {
      key: 'zh',
      dir: 'zh',
      label: '中文',
      htmlLang: 'zh-CN',
      chrome: {
        openRaft: '登录',
        language: '语言',
        languageAria: '切换语言',
        markdownIndexTitle: '# Hands 文档',
        markdownIndexNote:
          '机器可读索引。下列每个页面都有对应的纯 Markdown 孪生文件（`/docs/zh/<slug>.md`；本索引为 `/docs/zh.md`），可直接抓取，无 HTML 或 JavaScript。',
        categories: {
          'Start here': '从这里开始',
          'For agents': '面向 Agent',
          Console: '控制台',
          'SDKs & API': 'SDK 与 API',
        },
      },
    },
  ],
  twins: {
    page: 'same-dir',
    index: {
      en: { name: 'docs.md', placement: 'out-parent' },
      zh: { name: 'zh.md', placement: 'out-root' },
    },
  },
  nav: {
    categories: ['Start here', 'For agents', 'Console', 'SDKs & API'],
    externals: [{ label: 'API explorer', href: '/api-docs' }],
  },
  brand: {
    name: 'Hands',
    logo: '/favicon.svg',
    home: '/',
    headerNav: [
      // VitePress prefixes every nav `link` with `base` ('/docs/'), so the
      // in-docs entries are written base-relative ('/' resolves to /docs/);
      // destinations outside the docs site use absolute URLs so the prefix
      // cannot turn them into /docs/<path> 404s (API explorer, Login CTA).
      { label: 'Docs', href: '/' },
      { label: 'SDKs & API', href: '/cli-reference/' },
      { label: 'API explorer', href: 'https://hands.build/api-docs' },
      // `primary` items are rendered as the rightmost CTA (not a nav tab).
      { label: 'Login', href: 'https://app.hands.build/', primary: true },
    ],
  },
  search: true,
  coverage: { mode: 'report' },
  artifacts: { llms: false, headers: false },
  output: { contentDir: 'docs/public', outDir: 'admin/public/docs', contentExclude: ['agc-market-packages'] },
})
