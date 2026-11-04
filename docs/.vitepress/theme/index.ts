// Hands docs theme: the docs-kit theme, driven by docs.config.mjs.
// @ts-expect-error plain ESM source from the docs-kit package
import { createDocsTheme } from '@botiverse/docs-kit/theme'
// @ts-expect-error plain ESM module (repo root)
import docsConfig from '../../../docs.config.mjs'
import { useData } from 'vitepress'
import { defineComponent, Fragment, h, onMounted, watch } from 'vue'
import { persistLocale } from '../../../admin/src/lib/localePreference'

const theme = createDocsTheme(docsConfig, {})

// The locale in a documentation URL is explicit. Keep the shared preference
// in step when the user opens a translated page or switches languages.
const SaveDocsLocale = defineComponent({
  setup() {
    const { page } = useData()
    const save = () => persistLocale(page.value.relativePath.startsWith('zh/') ? 'zh-CN' : 'en')
    onMounted(save)
    watch(() => page.value.relativePath, save)
    return () => null
  },
})

export default {
  ...theme,
  Layout() {
    return h(Fragment, [h(theme.Layout), h(SaveDocsLocale)])
  },
}
