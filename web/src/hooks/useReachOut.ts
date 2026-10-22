import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@shared/protocol';
import type { Reached } from '@/hooks/useChat';

const BASE_TITLE = document.title;

/**
 * When she reaches out and the tab is in the background: a browser notification
 * (if allowed) and an unread count in the tab title, cleared on return. With the
 * page closed entirely, the server's macOS notification covers it instead.
 */
export function useReachOut(reached: Reached | null, messages: ChatMessage[], name: string) {
  const unread = useRef(0);
  const handled = useRef(0);

  useEffect(() => {
    if (!reached || reached.seq === handled.current) return;
    handled.current = reached.seq;
    if (document.visibilityState === 'visible') return;
    unread.current += 1;
    document.title = `(${unread.current}) ${name || BASE_TITLE}`;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const first = messages.find(m => m.id === reached.messageIds[0]);
      const body = !first ? '' : first.kind === 'voice' ? '给你发了一条语音' : first.text;
      const notice = new Notification(name || 'Find My Voice', { body, tag: 'find-my-voice', silent: false });
      notice.onclick = () => { window.focus(); notice.close(); };
    }
  }, [reached, messages, name]);

  useEffect(() => {
    const clear = () => {
      if (document.visibilityState !== 'visible') return;
      unread.current = 0;
      document.title = BASE_TITLE;
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);
}

/** Browsers only show the permission prompt from a user gesture, so this is called from a click. */
export async function requestReachOutPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}
