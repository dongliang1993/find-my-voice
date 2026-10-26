import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ChatMessage, ClientEvent, CompanionStatus, Paper, PaperOp, ServerEvent } from '@shared/protocol';
import { api } from '@/lib/api';
import { audio } from '@/lib/audio';

export type Connection = 'connecting' | 'open' | 'closed';
export type Notice = { id: number; message: string };
/** Her latest unprompted message, for notifications. */
export type Reached = { seq: number; messageIds: string[] };
/** One spoken sentence, and the second of its stream it starts at. */
export type SpeechLine = { text: string; startsAt: number };
/** Sentence boundaries by audio id, for the caption. */
export type SpeechLines = Record<string, SpeechLine[]>;

/**
 * One edit she made to a paper, with the paper as it was just before: the
 * page needs both ends to show her making the change.
 */
export type PaperEdit = { seq: number; before: Paper; after: Paper; ops: PaperOp[] };

type State = {
  messages: ChatMessage[]; status: CompanionStatus; connection: Connection;
  notices: Notice[]; reached: Reached | null; lines: SpeechLines;
  /** Every paper still around, newest first; the Papers list is the saved ones. */
  papers: Paper[];
  /** The paper on the stage, if any. */
  stage: string | null;
  /** Edits in the order they happened, for the page to play through. */
  edits: PaperEdit[];
  /** Bumped when a setting changed outside the settings page: she was asked to, out loud. */
  settingsStamp: number;
  /** The paper last saved, for the moment it goes onto the list to be seen. */
  saved: { seq: number; paperId: string } | null;
};

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

/** The newest paper first, the way Papers reads them. */
function putPaper(papers: Paper[], paper: Paper) {
  const rest = papers.filter(p => p.id !== paper.id);
  return [paper, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A paper that was not saved and now is: the list just gained it. */
const justSaved = (papers: Paper[], paper: Paper) => Boolean(paper.savedAt) && !papers.find(p => p.id === paper.id)?.savedAt;

let editSeq = 0;

function reducer(state: State, action: Action): State {
  if (action.type === 'connection') return { ...state, connection: action.connection };
  if (action.type === 'dismiss') return { ...state, notices: state.notices.filter(n => n.id !== action.id) };
  const event = action.event;
  switch (event.type) {
    case 'hello': return { ...state, messages: event.messages, status: event.status, papers: event.papers ?? [], stage: event.stage ?? null };
    case 'message': return { ...state, messages: upsert(state.messages, event.message) };
    case 'text_delta': return {
      ...state,
      messages: state.messages.map(m => (m.id === event.messageId ? { ...m, text: m.text + event.delta } : m)),
    };
    case 'status': return { ...state, status: event.status };
    case 'error': return { ...state, notices: [...state.notices, { id: ++noticeSeq, message: event.message }].slice(-3) };
    case 'initiative': return { ...state, reached: { seq: (state.reached?.seq ?? 0) + 1, messageIds: event.messageIds } };
    case 'speech_line': return {
      ...state,
      lines: { ...state.lines, [event.audioId]: [...(state.lines[event.audioId] ?? []), { text: event.text, startsAt: event.startsAt }] },
    };
    case 'paper': return {
      ...state,
      papers: putPaper(state.papers, event.paper),
      saved: justSaved(state.papers, event.paper) ? { seq: (state.saved?.seq ?? 0) + 1, paperId: event.paper.id } : state.saved,
    };
    case 'paper_edit': {
      const before = state.papers.find(p => p.id === event.paper.id);
      const edits = before ? [...state.edits, { seq: ++editSeq, before, after: event.paper, ops: event.ops }].slice(-20) : state.edits;
      return { ...state, papers: putPaper(state.papers, event.paper), edits };
    }
    case 'paper_removed': {
      // Deleted from Papers, it was still something she wrote, and the history
      // keeps its line. One that came to nothing leaves no trace.
      const gone = state.papers.find(p => p.id === event.paperId);
      const keepCard = Boolean(gone?.blocks.length);
      return {
        ...state,
        papers: state.papers.filter(p => p.id !== event.paperId),
        messages: keepCard ? state.messages : state.messages.filter(m => m.paperId !== event.paperId),
      };
    }
    case 'stage': return { ...state, stage: event.paperId };
    case 'settings': return { ...state, settingsStamp: state.settingsStamp + 1 };
    default: return state;
  }
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

/** The live conversation over one auto-reconnecting WebSocket. */
export function useChat() {
  const [state, dispatch] = useReducer(reducer, {
    messages: [], status: 'idle', connection: 'connecting', notices: [], reached: null, lines: {}, papers: [], edits: [],
    stage: null, settingsStamp: 0, saved: null,
  });
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef<ClientEvent[]>([]);
  /** The paper open in Papers on this page; told to the server again after a reconnect. */
  const reading = useRef<string | null>(null);

  useEffect(() => {
    let attempt = 0;
    let timer: number | undefined;
    let disposed = false;

    const connect = () => {
      dispatch({ type: 'connection', connection: 'connecting' });
      const ws = new WebSocket(api.wsUrl());
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        dispatch({ type: 'connection', connection: 'open' });
        ws.send(JSON.stringify({ type: 'presence', visible: document.visibilityState === 'visible' } satisfies ClientEvent));
        if (reading.current) ws.send(JSON.stringify({ type: 'reading', paperId: reading.current } satisfies ClientEvent));
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
    // Lets the server skip the OS notification while the chat is on screen.
    const onVisibility = () => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'presence', visible: document.visibilityState === 'visible' } satisfies ClientEvent));
    };
    document.addEventListener('visibilitychange', onVisibility);
    connect();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(timer);
      socket.current?.close();
    };
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

  /** Which paper is open in Papers here, so what the user says next is read as being about it. */
  const setReading = useCallback((paperId: string | null) => {
    if (reading.current === paperId) return;
    reading.current = paperId;
    emit({ type: 'reading', paperId });
  }, [emit]);

  return { ...state, send, interrupt, dismiss, setReading };
}
