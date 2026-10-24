import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ChatMessage, ClientEvent, CompanionStatus, Letter, LetterOp, Note, NoteOp, ServerEvent } from '@shared/protocol';
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
 * One edit she made to a letter, with the letter as it was just before: the
 * paper needs both ends to show her making the change.
 */
export type LetterEdit = { seq: number; before: Letter; after: Letter; ops: LetterOp[] };

/** One edit she made to the note, the same way. */
export type NoteEdit = { seq: number; before: Note; after: Note; ops: NoteOp[] };

type State = {
  messages: ChatMessage[]; status: CompanionStatus; connection: Connection;
  notices: Notice[]; reached: Reached | null; lines: SpeechLines;
  /** The inbox, newest first. */
  letters: Letter[];
  /** Edits in the order they happened, for the paper to play through. */
  edits: LetterEdit[];
  /** The one note, on the table. */
  note: Note | null;
  /** The notes taken off the table and kept: what the dock holds. */
  filedNotes: Note[];
  /** Note edits in order, for the card to play through. */
  noteEdits: NoteEdit[];
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

/** The newest letter first, the way the inbox and the stage both read it. */
function putLetter(letters: Letter[], letter: Letter) {
  const rest = letters.filter(l => l.id !== letter.id);
  return [letter, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

let editSeq = 0;

function reducer(state: State, action: Action): State {
  if (action.type === 'connection') return { ...state, connection: action.connection };
  if (action.type === 'dismiss') return { ...state, notices: state.notices.filter(n => n.id !== action.id) };
  const event = action.event;
  switch (event.type) {
    case 'hello': return { ...state, messages: event.messages, status: event.status, letters: event.letters ?? [], note: event.note ?? null, filedNotes: event.filedNotes ?? [] };
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
    case 'letter': return { ...state, letters: putLetter(state.letters, event.letter) };
    case 'letter_edit': {
      const before = state.letters.find(l => l.id === event.letter.id);
      const edits = before ? [...state.edits, { seq: ++editSeq, before, after: event.letter, ops: event.ops }].slice(-20) : state.edits;
      return { ...state, letters: putLetter(state.letters, event.letter), edits };
    }
    case 'letter_removed': {
      const gone = state.letters.find(l => l.id === event.letterId);
      // Deleted from the inbox, a finished letter was still something she gave, and
      // the history keeps its line. One that never came to anything — or broke off
      // and was written again — leaves no trace.
      const keepCard = gone?.status === 'done';
      return {
        ...state,
        letters: state.letters.filter(l => l.id !== event.letterId),
        messages: keepCard ? state.messages : state.messages.filter(m => m.letterId !== event.letterId),
      };
    }
    case 'note': return { ...state, note: event.note };
    case 'note_edit': {
      const before = state.note;
      const noteEdits = before
        ? [...state.noteEdits, { seq: ++editSeq, before, after: event.note, ops: event.ops }].slice(-20)
        : state.noteEdits;
      return { ...state, note: event.note, noteEdits };
    }
    case 'note_removed': return { ...state, note: null, noteEdits: [] };
    case 'note_filed': return { ...state, note: null, noteEdits: [], filedNotes: event.filedNotes };
    case 'note_unfiled': return { ...state, filedNotes: event.filedNotes };
    default: return state;
  }
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

/** The live conversation over one auto-reconnecting WebSocket. */
export function useChat() {
  const [state, dispatch] = useReducer(reducer, {
    messages: [], status: 'idle', connection: 'connecting', notices: [], reached: null, lines: {}, letters: [], edits: [],
    note: null, noteEdits: [], filedNotes: [],
  });
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef<ClientEvent[]>([]);
  /** The letter open on this page; told to the server again after a reconnect. */
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
        if (reading.current) ws.send(JSON.stringify({ type: 'reading', letterId: reading.current } satisfies ClientEvent));
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

  /** Which letter is open here, so what the user says next is read as being about it. */
  const setReading = useCallback((letterId: string | null) => {
    if (reading.current === letterId) return;
    reading.current = letterId;
    emit({ type: 'reading', letterId });
  }, [emit]);

  return { ...state, send, interrupt, dismiss, setReading };
}
