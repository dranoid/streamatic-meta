import { Segmented } from '@/components/ui/segmented';
import type { CaptionLanguage } from '@/lib/api';

export type AlertLanguage = 'english' | CaptionLanguage;

const LANGUAGES: Array<{ value: AlertLanguage; label: string }> = [
  { value: 'english', label: 'English' },
  { value: 'pidgin', label: 'Pidgin' },
  { value: 'yoruba', label: 'Yorùbá' },
];

export function LanguageChoice({ value, onChange }: { value: AlertLanguage; onChange: (language: AlertLanguage) => void }) {
  return <Segmented label='Language of the alert' value={value} options={LANGUAGES} onChange={onChange} />;
}
