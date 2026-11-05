import { Modes, type Mode } from '@web/features/needs/modes';
import { kv } from '../../lib/storage';

/** The home composer's words, kept on this device until they become a real need. */
const KEY = 'dorkar.needDraft';

export interface ComposerDraft {
  mode: Mode;
  text: string;
}

export function loadDraft(): ComposerDraft {
  try {
    const raw = kv.get(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ComposerDraft>) : {};
    return {
      mode: Modes.includes(parsed.mode as Mode) ? (parsed.mode as Mode) : 'BUY',
      text: typeof parsed.text === 'string' ? parsed.text.slice(0, 600) : '',
    };
  } catch {
    return { mode: 'BUY', text: '' };
  }
}

export const saveDraft = (d: ComposerDraft) => kv.set(KEY, JSON.stringify(d));
export const clearDraft = () => kv.remove(KEY);

/** The composer's free text split into a headline (first line, ≤120) and the rest. */
export function splitDraft(text: string): { title: string; description: string } {
  const trimmed = text.trim();
  const [first = '', ...rest] = trimmed.split(/\n+/);
  if (first.length <= 120) return { title: first, description: rest.join('\n').trim() };
  const cut = first.slice(0, 120).replace(/\s+\S*$/, '');
  return { title: cut, description: trimmed };
}
