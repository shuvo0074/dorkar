import { Modes, type Mode } from './modes';

/**
 * The home composer's words, kept on this device until they become a real need. Signing in
 * or reloading never loses them; posting clears them.
 */
const DRAFT_KEY = 'dorkar.needDraft';

export interface ComposerDraft {
  mode: Mode;
  text: string;
}

export function loadDraft(): ComposerDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ComposerDraft>) : {};
    return {
      mode: Modes.includes(parsed.mode as Mode) ? (parsed.mode as Mode) : 'BUY',
      text: typeof parsed.text === 'string' ? parsed.text.slice(0, 600) : '',
    };
  } catch {
    return { mode: 'BUY', text: '' };
  }
}

export function saveDraft(d: ComposerDraft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // a draft is a convenience; losing it is acceptable
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // nothing to clear
  }
}

/** The composer's free text split into a headline (first line, ≤120) and the rest. */
export function splitDraft(text: string): { title: string; description: string } {
  const trimmed = text.trim();
  const [first = '', ...rest] = trimmed.split(/\n+/);
  if (first.length <= 120) return { title: first, description: rest.join('\n').trim() };
  const cut = first.slice(0, 120).replace(/\s+\S*$/, '');
  return { title: cut, description: trimmed };
}
