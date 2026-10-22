import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ChatMessage, ClientEvent, CompanionStatus, ServerEvent } from '@shared/protocol';
import { audio } from '@/audio';

export type Connection = 'connecting' | 'open' | 'closed';
export type Notice = { id: number; message: string };
type State = { messages: ChatMessage[]; status: CompanionStatus; connection: Connection; notices: Notice[] };

type Action =
  | { type: 'event'; event: ServerEvent }
  | { type: 'connection'; connection: Connection }
  | { type: 'dismiss'; id: number };

let noticeSeq = 0;

function upsert(messages: ChatMessage[], message: ChatMessage) {
  const index = messages.findIndex(m => m.id === message.id);
  if (index === -1) return [...messages, message];
  return messages.map((m, i) => (i === index ? message : m));
}

function reducer(state: State, action: Action): State {
  if (action.type === 'connection') return { ...state, connection: action.connection };
  if (action.type === 'dismiss') return { ...state, notices: state.notices.filter(n => n.id !== action.id) };
  const event = action.event;
  switch (event.type) {
    case 'hello': return { ...state, messages: event.messages, status: event.status };
    case 'message': return { ...state, messages: upsert(state.messages, event.message) };
    case 'text_delta': return {
      ...state,
      messages: state.messages.map(m => (m.id === event.messageId ? { ...m, text: m.text + event.delta } : m)),
    };
    case 'status': return { ...state, status: event.status };
    case 'error': return { ...state, notices: [...state.notices, { id: ++noticeSeq, message: event.message }].slice(-3) };
    default: return state;
  }
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

/** The live conversation over one auto-reconnecting WebSocket. */
export function useChat() {
  const [state, dispatch] = useReducer(reducer, { messages: [], status: 'idle', connection: 'connecting', notices: [] });
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef<ClientEvent[]>([]);

  useEffect(() => {
    let attempt = 0;
    let timer: number | undefined;
    let disposed = false;

    const connect = () => {
      dispatch({ type: 'connection', connection: 'connecting' });
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        dispatch({ type: 'connection', connection: 'open' });
        for (const event of pending.current.splice(0)) ws.send(JSON.stringify(event));
      };
      ws.onmessage = e => {
        const event = JSON.parse(e.data) as ServerEvent;
        // Audio chunks go straight to the speaker, never through React state.
        if (event.type === 'audio_chunk') audio.pushPcm(event.audioId, event.data);
        else dispatch({ type: 'event', event });
      };
      ws.onclose = () => {
        if (disposed) return;
        dispatch({ type: 'connection', connection: 'closed' });
        timer = window.setTimeout(connect, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
      };
    };
    connect();
    return () => { disposed = true; window.clearTimeout(timer); socket.current?.close(); };
  }, []);

  const emit = useCallback((event: ClientEvent) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    // Queued sends are replayed on reconnect; the server dedupes by clientId.
    else if (event.type === 'send') pending.current.push(event);
  }, []);

  const send = useCallback((text: string) => {
    audio.unlock();
    emit({ type: 'send', clientId: crypto.randomUUID(), text });
  }, [emit]);

  const interrupt = useCallback(() => {
    audio.stopAll();
    emit({ type: 'interrupt' });
  }, [emit]);
  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), []);

  return { ...state, send, interrupt, dismiss };
}
