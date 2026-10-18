/** Locale registry for every UI string; missing keys fall through the harness
 *  locale chain (active → en → common → the key). The dictionaries live in
 *  `i18nZh.ts` (the key-set source of truth), `i18nEn.ts` and `i18nRu.ts`. */

/** Keyed `string`, not a {@link DictKey} union: call sites compose keys at runtime (`'form.' + form`,
 *  a weekday template), and typing the union would mean a cast at each one. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

export { DICT_ZH, type DictKey } from './i18nZh'
export { DICT_EN } from './i18nEn'
export { DICT_RU } from './i18nRu'
