import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import locale0 from '../../i18n/locales/en';
import locale1 from '../../i18n/locales/de';
import locale2 from '../../i18n/locales/es';
import locale3 from '../../i18n/locales/fr';
import locale4 from '../../i18n/locales/it';
import locale5 from '../../i18n/locales/ja';
import locale6 from '../../i18n/locales/ko';
import locale7 from '../../i18n/locales/pt-BR';
import locale8 from '../../i18n/locales/tr';
import locale9 from '../../i18n/locales/zh-CN';
import locale10 from '../../i18n/locales/zh-TW';

const locales = [
  { code: 'en', translation: locale0, one: 'item', other: 'items', separator: ' ' },
  { code: 'de', translation: locale1, one: 'Element', other: 'Elemente', separator: ' ' },
  { code: 'es', translation: locale2, one: 'elemento', other: 'elementos', separator: ' ' },
  { code: 'fr', translation: locale3, one: 'élément', other: 'éléments', separator: ' ' },
  { code: 'it', translation: locale4, one: 'elemento', other: 'elementi', separator: ' ' },
  { code: 'ja', translation: locale5, one: '件', other: '件', separator: '' },
  { code: 'ko', translation: locale6, one: '개 항목', other: '개 항목', separator: '' },
  { code: 'pt-BR', translation: locale7, one: 'item', other: 'itens', separator: ' ' },
  { code: 'tr', translation: locale8, one: 'öğe', other: 'öğe', separator: ' ' },
  { code: 'zh-CN', translation: locale9, one: '个项目', other: '个项目', separator: ' ' },
  { code: 'zh-TW', translation: locale10, one: '個項目', other: '個項目', separator: ' ' },
];

describe('queue item counts in every supported locale', () => {
  for (const locale of locales) {
    it(`uses ${locale.code} wording for each applicable count category`, async () => {
      const i18n = createInstance();
      await i18n.init({
        lng: locale.code, fallbackLng: 'en',
        resources: { en: { translation: locale0 }, [locale.code]: { translation: locale.translation } },
      });
      // Zero, one, four and a million exercise the supported languages' one,
      // other and many categories, including French zero and million plurals.
      for (const count of [0, 1, 4, 1000000]) {
        const category = new Intl.PluralRules(locale.code).select(count);
        const word = category === 'one' ? locale.one : locale.other;
        expect.soft(i18n.t('queue.itemCount', { count })).toBe(`${count}${locale.separator}${word}`);
      }
    });
  }
});
