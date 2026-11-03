import { z } from 'zod';
import type { SparkClient } from './client.js';

export const CAPTION_LANGUAGES = { pidgin: 'Nigerian Pidgin', yoruba: 'Yoruba, with its proper tone marks' } as const;
export type CaptionLanguage = keyof typeof CAPTION_LANGUAGES;
export const captionLanguages = Object.keys(CAPTION_LANGUAGES) as CaptionLanguage[];

export type WriteCaption = (rule: string, language: CaptionLanguage) => Promise<string>;

// Says what a rule's alert means, for the person who reads it. It sees only the rule, since given a sampled picture's description
// it denies alerts that are right, and it writes fixed text, since asked to state the event as fact it hedges or refuses.
export class SparkAlertCaption {
  constructor(private readonly spark: Pick<SparkClient, 'json'>) {}

  write: WriteCaption = async (rule, language) => {
    const { caption } = await this.spark.json(
      `You are writing fixed notice text for a camera product. The software sends this text to a resident each time a rule fires, so it claims nothing about this moment and nothing needs checking.
The rule, as its owner worded it: ${rule}
Write its notice in ${CAPTION_LANGUAGES[language]}: one short plain statement of the event, in at most ten words. For example, the rule "Tell me if the freezer lid is left up" has the notice "The freezer lid is up", in the language asked. State the event as having happened: never say it is unknown, uncertain, possible or did not happen, put no label such as "warning" before it, and add nothing the rule does not say.
Reply with JSON only: {"caption": "the alert"}`,
      [],
      z.object({ caption: z.string().trim().min(1) }),
    );
    // Yoruba written with its marks is never plain ASCII, and a caption is kept once, so English left in place must not be.
    if (language === 'yoruba' && /^[\x00-\x7f]*$/.test(caption)) throw new Error('The Yoruba caption came back in English.');
    return caption;
  };
}
