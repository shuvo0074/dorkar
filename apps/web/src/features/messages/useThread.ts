import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/http';
import { chatApi, type Message } from './api';

export interface Outgoing {
  clientId: string;
  body: string;
  status: 'sending' | 'failed';
  error?: unknown;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * One conversation, live: history first, then a long poll for anything newer (the server holds
 * each request up to eight seconds). Sends echo immediately and are deduplicated by clientId,
 * so a retried send never appears twice.
 */
export function useThread(conversationId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const lastId = useRef<string | null>(null);

  const merge = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const next = [...prev, ...incoming.filter((m) => !seen.has(m.id))];
      next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      lastId.current = next.at(-1)?.id ?? null;
      return next;
    });
    const done = new Set(incoming.map((m) => m.clientId));
    setOutgoing((o) => o.filter((x) => !done.has(x.clientId)));
  }, []);

  // History, then the live loop.
  useEffect(() => {
    const ctrl = new AbortController();
    setMessages([]);
    setLoaded(false);
    lastId.current = null;
    void (async () => {
      try {
        const page = await chatApi.history(conversationId);
        merge([...page.data].reverse());
        setOlder(page.page.nextCursor);
        setLoaded(true);
      } catch (err) {
        setLoadError(err);
        return;
      }
      while (!ctrl.signal.aborted) {
        const after = lastId.current;
        const started = Date.now();
        try {
          if (after) {
            merge(await chatApi.poll(conversationId, after, ctrl.signal));
          } else {
            // Nothing to wait after yet: check the history again shortly.
            const page = await chatApi.history(conversationId);
            merge([...page.data].reverse());
          }
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.status === 404) return;
          await sleep(3_000, ctrl.signal);
          continue;
        }
        // Don't spin if the server answered at once with nothing (or a proxy cut the wait).
        if (Date.now() - started < 1_000) await sleep(after ? 2_000 : 5_000, ctrl.signal);
      }
    })();
    return () => ctrl.abort();
  }, [conversationId, merge]);

  const loadOlder = useCallback(async () => {
    if (!older) return;
    const page = await chatApi.history(conversationId, older);
    merge([...page.data].reverse());
    setOlder(page.page.nextCursor);
  }, [conversationId, older, merge]);

  const send = useCallback(
    async (body: string, clientId: string = crypto.randomUUID()) => {
      setOutgoing((o) => [
        ...o.filter((x) => x.clientId !== clientId),
        { clientId, body, status: 'sending' },
      ]);
      try {
        merge([await chatApi.send(conversationId, body, clientId)]);
      } catch (error) {
        setOutgoing((o) =>
          o.map((x) => (x.clientId === clientId ? { ...x, status: 'failed', error } : x)),
        );
      }
    },
    [conversationId, merge],
  );

  return { messages, outgoing, loaded, loadError, older: Boolean(older), loadOlder, send };
}
