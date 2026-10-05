// Hands docs theme: the docs-kit theme, driven by docs.config.mjs.
// @ts-expect-error plain ESM source from the docs-kit package
import { createDocsTheme } from '@botiverse/docs-kit/theme'
// @ts-expect-error plain ESM module (repo root)
import docsConfig from '../../../docs.config.mjs'

export default createDocsTheme(docsConfig, {})
