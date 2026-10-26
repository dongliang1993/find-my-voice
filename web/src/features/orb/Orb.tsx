import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Keyboard, Loader2, Mic, Square } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { VoiceRing } from '@/features/orb/ring';
import type { EarState, TalkMode } from '@/features/orb/useEar';
import { cn } from '@/lib/utils';

/** The circle's diameter, which is also the capsule's height. */
const SIZE = 48;
/** Inside the capsule the circle sits this far in from its top, bottom and right end. */
const INSET = 6;
/** The circle, shrunk to fit inside the capsule's end. A scale, so the icon keeps its proportion. */
const TUCKED = (SIZE - INSET * 2) / SIZE;
/** An empty capsule that has lost focus folds back after this long. */
const FOLD_MS = 3000;
const ICON = 'size-[17px]';
/** The capsule opening out of the circle and folding back into it. */
const MORPH = { duration: 0.35, ease: [0.32, 0.72, 0, 1] } as const;

/** Somewhere the keyboard already belongs to: typing there is not typing to her. */
const EDITABLE = 'input, textarea, select, [contenteditable="true"], [role="dialog"]';
/** A key that writes something, or that an input method is about to compose with. */
const writes = (event: globalThis.KeyboardEvent) =>
  (event.key.length === 1 && event.key !== ' ') || event.key === 'Process' || event.isComposing;

type Props = {
  ear: EarState;
  /** False: she cannot hear here (no key, no microphone, refused), so the circle is for typing. */
  canSpeak: boolean;
  /** It is her turn: the circle steps back without going away. */
  dim?: boolean;
  /** Neither keys nor clicks reach it. Looks the same: pair it with `dim` where it should also step back. */
  disabled?: boolean;
  /** Opens as a field: the step is one you type at rather than talk to. */
  autoOpen?: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onStart: (mode: TalkMode) => void;
  /** Ends a recording and keeps it. */
  onStop: () => void;
  /** Ends a recording and throws it away: the user started typing. */
  onCancel: () => void;
  label: string;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  /** Told when the user is at the field — open and focused — and when they leave it or send. */
  onTypingChange?: (typing: boolean) => void;
};

/**
 * The one control, the same in the first meeting and on the stage. It is a
 * circle: a click talks, a held Space talks until it is let go, and a key
 * pressed anywhere grows a field out of it to both sides, the circle sliding
 * right to become the send button. Enter sends and the field folds back;
 * Esc, or an empty field left alone for a moment, folds it back too.
 *
 * The field is always mounted — and, on a desktop, holds the focus while it
 * is folded — so the first key lands inside it. That matters most for an
 * input method, which can only compose into a field that was focused before
 * the key arrived.
 */
export function Orb({ ear, canSpeak, dim = false, disabled = false, autoOpen = false, value, onChange, onSend, onStart, onStop, onCancel, label, placeholder, maxLength = 4000, className, onTypingChange }: Props) {
  const [open, setOpen] = useState(autoOpen);
  const [focused, setFocused] = useState(false);
  const told = useRef(onTypingChange);
  told.current = onTypingChange;
  useEffect(() => { told.current?.(open && focused); }, [open, focused]);
  const field = useRef<HTMLInputElement>(null);
  const fold = useRef<number | undefined>(undefined);
  const still = useReducedMotion() ?? false;
  const listening = ear === 'listening';
  const hearing = ear === 'hearing';
  const ready = Boolean(value.trim());
  /** A phone's keyboard appears on focus, so the field is only focused when asked for there. */
  const park = useRef(typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches);

  const grow = () => {
    window.clearTimeout(fold.current);
    if (listening) onCancel();
    setOpen(true);
  };
  const shrink = () => {
    window.clearTimeout(fold.current);
    setOpen(false);
  };

  // Folded, the field keeps the caret out of sight so the next key is caught
  // whole; anything else taking focus (a button, a dialog) is left alone.
  useEffect(() => {
    if (!park.current || open || disabled) return;
    const settle = () => {
      if (document.activeElement === document.body || document.activeElement === null) field.current?.focus({ preventScroll: true });
    };
    settle();
    document.addEventListener('focusout', defer);
    function defer() { window.setTimeout(settle, 0); }
    return () => document.removeEventListener('focusout', defer);
  }, [open, disabled]);

  useEffect(() => { if (autoOpen) field.current?.focus({ preventScroll: true }); }, []);

  // Words that arrive from elsewhere — what she heard, a name she suggests —
  // open the field with them in it, to be checked before they are sent.
  const typed = useRef(false);
  useEffect(() => {
    if (typed.current) { typed.current = false; return; }
    if (value.trim()) { setOpen(true); field.current?.focus({ preventScroll: true }); }
  }, [value]);

  // Keys pressed while focus sits on something that is not a field: the
  // first one moves into the field, in time for the browser to deliver it there.
  // Space is the microphone whenever the field is folded.
  const held = useRef(false);
  useEffect(() => {
    const down = (event: globalThis.KeyboardEvent) => {
      if (disabled || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const inField = target === field.current;
      if (!inField && target?.closest(EDITABLE)) return;
      if (event.code === 'Space' && !open && !event.isComposing) {
        event.preventDefault();
        if (event.repeat || !canSpeak || hearing) return;
        if (listening) { onStop(); return; }
        held.current = true;
        onStart('hold');
        return;
      }
      if (inField || !writes(event)) return;
      grow();
      field.current?.focus({ preventScroll: true });
    };
    const up = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'Space' || !held.current) return;
      held.current = false;
      onStop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  });

  useEffect(() => () => window.clearTimeout(fold.current), []);

  const send = () => {
    if (!ready) return;
    onSend(value.trim());
    shrink();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an input method's candidate is not a send.
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) { event.preventDefault(); return; }
    if (event.key === 'Escape' && open) { event.preventDefault(); shrink(); }
  };

  const press = () => {
    if (open) {
      if (ready) send();
      // Empty, the button is the microphone again: talking folds the field away.
      else if (canSpeak && !hearing) { shrink(); onStart('tap'); }
      else shrink();
      return;
    }
    if (!canSpeak) { grow(); field.current?.focus(); return; }
    if (hearing) return;
    if (listening) onStop();
    else onStart('tap');
  };

  /** One icon at a time; in the field it is the microphone until there is something to send. */
  const icon = open ? (ready || !canSpeak ? 'send' : 'mic')
    : hearing ? 'busy' : listening ? 'stop' : canSpeak ? 'mic' : 'type';
  const name = { send: 'Send', mic: 'Talk', busy: 'Working it out', stop: 'Stop', type: 'Type' }[icon];
  const transition = still ? { duration: 0 } : MORPH;
  const layer = (shown: boolean) => cn('[grid-area:1/1] transition-opacity duration-150', shown ? 'opacity-100' : 'opacity-0');

  return (
    <form className={cn('relative flex h-12 w-[min(384px,86vw)] items-center', open ? 'justify-end' : 'justify-center', className)}
      onSubmit={event => { event.preventDefault(); send(); }}>
      {/* The capsule, one whole outline. It opens out from behind the circle as the circle slides to its
          right end, both on the same curve, so its end stays wrapped around the circle all the way. */}
      <motion.div aria-hidden="true" initial={false}
        animate={{ width: open ? '100%' : SIZE, opacity: open ? 1 : 0 }} transition={transition}
        className="absolute inset-y-0 left-0 right-0 mx-auto rounded-full border border-(--orb-edge) bg-(--orb-field) backdrop-blur-md" />
      {/* The words stop short of the circle: its width and a 12px gap. */}
      <input ref={field} value={value} disabled={disabled} maxLength={maxLength} aria-label={label} tabIndex={open ? 0 : -1}
        enterKeyHint="send" autoComplete="off" placeholder={placeholder}
        onChange={event => { typed.current = true; if (!open) grow(); onChange(event.target.value); }}
        onCompositionStart={() => { if (!open) grow(); }}
        onKeyDown={onKeyDown}
        onFocus={() => { setFocused(true); window.clearTimeout(fold.current); }}
        onBlur={() => {
          setFocused(false);
          if (!open || value.trim()) return;
          window.clearTimeout(fold.current);
          fold.current = window.setTimeout(() => setOpen(false), FOLD_MS);
        }}
        style={{ paddingRight: SIZE }}
        className={cn('absolute inset-0 min-w-0 bg-transparent pl-5 text-[15px] text-(--orb-text) caret-(--orb-text) outline-none transition-opacity placeholder:text-(--orb-text)/60',
          open ? 'opacity-100 delay-100 duration-300' : 'pointer-events-none opacity-0 duration-100')} />

      <motion.div layout="position" initial={false} animate={{ scale: open ? TUCKED : 1 }} transition={transition} className="relative z-10">
        <div className={cn('relative transition-[opacity,scale] duration-500', dim && !open && 'scale-92 opacity-45')}>
          <VoiceRing live={listening} size={SIZE} />
          {/* In the capsule the circle turns solid: nothing of the outline shows through it. */}
          <button type="button" onClick={press} disabled={disabled}
            aria-label={name} title={name} aria-pressed={!open && canSpeak ? listening : undefined}
            className={cn('relative grid size-12 place-items-center rounded-full text-(--orb-ink) transition-[background-color,box-shadow,scale] duration-300',
              'hover:scale-[1.04] active:scale-95',
              'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--orb)',
              open ? 'bg-(--orb-solid)' : 'bg-(--orb) shadow-(--orb-glow)',
              !open && !listening && !hearing && 'orb-breathe')}>
            {/* Every icon the same size, a little over a third of the circle. */}
            <span className="grid place-items-center">
              <ArrowUp className={cn(ICON, layer(icon === 'send'))} />
              <Mic className={cn(ICON, layer(icon === 'mic'))} />
              <Loader2 className={cn(ICON, layer(icon === 'busy'), icon === 'busy' && 'animate-spin')} />
              <Square className={cn('size-3.5 fill-current', layer(icon === 'stop'))} />
              <Keyboard className={cn(ICON, layer(icon === 'type'))} />
            </span>
          </button>
        </div>
      </motion.div>
    </form>
  );
}
