import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { audio } from '@/lib/audio';
import { cn } from '@/lib/utils';

export type SwitcherApp = { id: string; label: string; icon: React.ReactElement; dot?: boolean };

export type SwitcherHandle = {
  /** A card's centre on screen — the front one's without an id: where a kept note flies to. */
  center: (id?: string) => { x: number; y: number } | null;
};

type Props = {
  apps: SwitcherApp[];
  /** The app that is up. */
  current: string;
  /**
   * The card the stack rests on: the app last opened, which stays in front
   * after it closes. The stack rolls to it when it changes from elsewhere.
   */
  rest: string;
  onOpen: (id: string) => void;
  still?: boolean;
  hidden?: boolean;
  ref?: Ref<SwitcherHandle>;
};

const CARD = 52;
/** Room around the stack inside its own box, so the hover tilt and the passing cards have somewhere to be. */
const PAD = 12;
/** Each card behind sits this much up and right of the one before it, and this much smaller. */
const STACK_PX = 6;
const SHRINK = 0.92;
/** The share of the front card's colour a card behind keeps: 60% by day, 50% at night.
 * The style itself reads --sw-behind (turned with the hour); this is its day figure,
 * for draw's visibility test. */
const BEHIND = 0.6;
/** Where a card passed by the hand goes: out toward the corner, per step. */
const PASS_X = 44;
const PASS_Y = 28;

const STIFFNESS = 260;
const DAMPING = 26;
const MASS = 1;

/** A trackpad's travel for one card. */
const PX_PER_STEP = 60;
/** How long the wheel must be still for a trackpad gesture to be over. */
const QUIET_MS = 150;
/** The pointer has to rest on the stack this long before the wheel is its own. */
const DWELL_MS = 150;
/** Past either end the stack gives, a third of the pull and no further than this. */
const RUBBER = 0.3;
const RUBBER_CAP = 0.3;

const LINE_PX = 16;

/** Past the ends the hand meets resistance, not a wall and not a loop. */
const rubber = (x: number, last: number) =>
  x < 0 ? -Math.min(RUBBER_CAP, -x * RUBBER)
    : x > last ? last + Math.min(RUBBER_CAP, (x - last) * RUBBER)
      : x;

/**
 * Trackpads send pixel deltas whose legacy wheelDelta is exactly −3× the
 * delta; a mouse sends notches. Lines and pages are always a mouse.
 */
function isTrackpad(event: WheelEvent): boolean {
  if (event.deltaMode !== 0) return false;
  const legacy = (event as WheelEvent & { wheelDeltaY?: number; wheelDeltaX?: number });
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  const wheelDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? legacy.wheelDeltaY : legacy.wheelDeltaX;
  if (wheelDelta !== undefined && wheelDelta !== 0) return wheelDelta === -3 * delta;
  return Math.abs(delta) < 50;
}

/** The wheel's travel in pixels, whichever unit it came in, along the axis it mostly moved. */
function pixels(event: WheelEvent): number {
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (event.deltaMode === 1) return delta * LINE_PX;
  if (event.deltaMode === 2) return delta * window.innerHeight;
  return delta;
}

type Gesture = { start: number; travel: number; locked: boolean; bumped: boolean };

/**
 * The app stack in the room's bottom-left corner, as in the film: the app
 * that is up in front, crisp; the rest stacked behind it, each a little up,
 * right and smaller, out of focus. The wheel turns it under the hand — a
 * spring, never per-frame React state — but only browses: nothing opens
 * until it is clicked, or ⌘1–3. Left without a click, it stays where it was turned to.
 */
export function Switcher({ apps, current, rest, onOpen, still = false, hidden = false, ref }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const shines = useRef<(HTMLDivElement | null)[]>([]);
  const traces = useRef<(SVGRectElement | null)[]>([]);
  /** The card that is in front, for the button's name; changes a handful of times per gesture at most. */
  const [front, setFront] = useState(() => Math.max(0, apps.findIndex(a => a.id === rest)));

  const live = useRef({ apps, current, rest, onOpen, still });
  live.current = { apps, current, rest, onOpen, still };

  const sim = useRef({
    x: front, v: 0, target: front,
    /** The card the stack last came to rest on: a new one gets its edge traced. */
    rested: front,
    /** The card nearest the front, for the tick as each one passes. */
    nearest: front,
    moved: false,
    /** Moving on its own (an app opened elsewhere): no tick, no settle, no trace. */
    hushed: false,
    raf: 0, last: 0,
    tilt: { x: 0, y: 0 }, hover: { x: 0, y: 0, on: false },
    /** The stack warming under the hand, eased like the tilt; at 0 the class colours stand. */
    warm: 0,
    enteredAt: Number.POSITIVE_INFINITY,
    gesture: null as Gesture | null,
    quiet: 0 as ReturnType<typeof setTimeout> | 0,
  });

  useImperativeHandle(ref, () => ({
    center: id => {
      const i = id ? live.current.apps.findIndex(a => a.id === id) : Math.round(sim.current.target);
      const card = cards.current[i];
      const box = card?.getBoundingClientRect();
      return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    },
  }), []);

  /** Writes every card's place for the stack at `x`. The only per-frame work, and all of it styles. */
  const draw = () => {
    const s = sim.current;
    const last = live.current.apps.length - 1;
    const shown = rubber(s.x, last);
    const speed = Math.min(1, Math.abs(s.v) / 8);
    const lift = Math.max(speed, s.hover.on ? 0.35 : 0);
    // How far between two cards the stack is: the warm light slides across as it turns.
    const sweep = ((shown % 1) + 1) % 1;
    cards.current.forEach((card, i) => {
      if (!card) return;
      const d = i - shown;
      let tx: number, ty: number, scale: number, blur: number, o: number, oCss: string;
      if (d >= 0) {
        tx = STACK_PX * d;
        ty = -STACK_PX * d;
        scale = SHRINK ** d;
        blur = Math.min(d, 3) * 1.2;
        // The cards behind keep one share of the front card's colour, written as a
        // calc on --sw-behind so the hour turns them where they rest, without a
        // redraw. `o` is its day figure, for the visibility test alone.
        const fade = Math.max(0, 1 - Math.max(0, d - 2));
        o = d < 1 ? 1 - (1 - BEHIND) * d : BEHIND * fade;
        oCss = d < 1
          ? `calc(1 - (1 - var(--sw-behind, ${BEHIND})) * ${d.toFixed(3)})`
          : `calc(var(--sw-behind, ${BEHIND}) * ${fade.toFixed(3)})`;
      } else {
        tx = PASS_X * d;
        ty = -PASS_Y * d;
        scale = 1 - 0.05 * d;
        blur = -d * 2;
        o = Math.max(0, 1 + 1.8 * d);
        oCss = o.toFixed(3);
      }
      const near = Math.max(0, 1 - Math.abs(d));
      ty -= 2 * lift * near;
      const tilt = near > 0.5 ? `perspective(400px) rotateX(${(-s.tilt.y * 3).toFixed(2)}deg) rotateY(${(s.tilt.x * 3).toFixed(2)}deg) ` : '';
      card.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) ${tilt}scale(${scale.toFixed(4)})`;
      card.style.opacity = oCss;
      card.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
      card.style.zIndex = String(100 - Math.round(d * 10));
      card.style.visibility = o < 0.01 ? 'hidden' : 'visible';
      // The shadow holds the card up off the room; as it lifts, the shadow lifts with it.
      // The hairline ring leads the shadow — composed here, not as a class: this
      // inline box-shadow is written every frame and would override one.
      const l = lift * near;
      card.style.boxShadow = `0 0 0 1px var(--sw-ring), 0 ${(6 + 8 * l).toFixed(1)}px ${(16 + 12 * l).toFixed(1)}px ${(-8 * l).toFixed(1)}px rgb(var(--sw-shadow-rgb) / calc(var(--sw-shadow-a) + ${(0.12 * l).toFixed(3)}))`;
      // Under the hand the card leans to its hover colour, the icon with it. By day
      // the hover icon is the card's own, so that mix changes nothing.
      const warm = s.warm * near;
      const mix = (a: string, b: string) => `color-mix(in srgb, var(${a}), var(${b}) ${(warm * 100).toFixed(1)}%)`;
      card.style.backgroundColor = warm > 0.004 ? mix('--sw-card', '--sw-hover-card') : '';
      card.style.color = warm > 0.004 ? mix('--sw-icon', '--sw-hover-icon') : '';
      const shine = shines.current[i];
      if (shine) {
        shine.style.opacity = (speed * near * 0.8).toFixed(3);
        shine.style.backgroundPositionX = `${(160 - 220 * sweep).toFixed(1)}%`;
      }
    });
  };

  /** The edge of the card that just came to rest, traced once in her white line. */
  const trace = (i: number) => {
    const rect = traces.current[i];
    if (!rect || live.current.still) return;
    rect.animate(
      [{ strokeDashoffset: 1, opacity: 1 }, { strokeDashoffset: 0, opacity: 1, offset: 0.67 }, { strokeDashoffset: 0, opacity: 0 }],
      { duration: 750, easing: 'ease-out' },
    );
  };

  const frame = (now: number) => {
    const s = sim.current;
    const dt = Math.min(0.032, (now - s.last) / 1000);
    s.last = now;
    if (live.current.still) {
      s.x = s.target;
      s.v = 0;
    } else {
      // Semi-implicit Euler: stable at these numbers for any frame rate we will see.
      const force = -STIFFNESS * (s.x - s.target) - DAMPING * s.v;
      s.v += (force / MASS) * dt;
      s.x += s.v * dt;
    }
    const goal = s.hover.on ? s.hover : { x: 0, y: 0 };
    s.tilt.x += (goal.x - s.tilt.x) * 0.18;
    s.tilt.y += (goal.y - s.tilt.y) * 0.18;
    // The stack warms under the hand and cools away from it, eased with the tilt.
    const warmGoal = s.hover.on ? 1 : 0;
    s.warm += (warmGoal - s.warm) * 0.18;

    const last = live.current.apps.length - 1;
    const nearest = Math.max(0, Math.min(last, Math.round(s.x)));
    if (nearest !== s.nearest) {
      s.nearest = nearest;
      if (!s.hushed) audio.click('tick', Math.min(1, Math.abs(s.v) / 14));
      setFront(nearest);
    }

    const resting = Math.abs(s.x - s.target) < 0.001 && Math.abs(s.v) < 0.005;
    const tilting = Math.abs(goal.x - s.tilt.x) > 0.002 || Math.abs(goal.y - s.tilt.y) > 0.002 || Math.abs(warmGoal - s.warm) > 0.002;
    if (resting) {
      s.x = s.target;
      s.v = 0;
      if (s.hushed) {
        s.hushed = false;
        s.rested = s.target;
      } else if (s.moved && Number.isInteger(s.target)) {
        s.moved = false;
        audio.click('settle');
        if (s.target !== s.rested) trace(s.target);
        s.rested = s.target;
      }
    }
    draw();
    s.raf = resting && !tilting ? 0 : requestAnimationFrame(frame);
  };

  /** Runs the loop without counting as a move: the tilt or the hover's warmth easing out makes no sound. */
  const wake = () => {
    const s = sim.current;
    if (s.raf) return;
    s.last = performance.now();
    s.raf = requestAnimationFrame(frame);
  };

  /** The hand moved the stack: it ticks as cards pass and settles with a click. */
  const kick = () => {
    sim.current.moved = true;
    sim.current.hushed = false;
    wake();
  };

  /** `quiet` for the stack moving by itself (an app opened elsewhere), which should not be heard. */
  const rollTo = (i: number, quiet = false) => {
    const s = sim.current;
    s.target = i;
    if (!quiet) { kick(); return; }
    s.moved = false;
    s.hushed = true;
    wake();
  };

  /** Opens a card now, rolling the stack to it if it is not in front. */
  const open = (i: number) => {
    const app = live.current.apps[i];
    if (!app) return;
    rollTo(i);
    if (app.id !== live.current.current) live.current.onOpen(app.id);
  };

  // An app was opened from elsewhere — a letter picked, settings on first visit — so the stack follows.
  useEffect(() => {
    const s = sim.current;
    const i = apps.findIndex(a => a.id === rest);
    if (i >= 0 && !s.gesture && Math.round(s.target) !== i) rollTo(i, true);
  }, [rest, apps]);

  useLayoutEffect(() => { draw(); }, [apps.length]);

  // The wheel is native, not React's: React's is passive, and the stack has to keep the scroll once it owns it.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const s = sim.current;

    const endGesture = () => {
      const g = s.gesture;
      s.gesture = null;
      if (!g) return;
      const last = live.current.apps.length - 1;
      rollTo(Math.max(0, Math.min(last, Math.round(s.target))));
    };

    const onWheel = (event: WheelEvent) => {
      // Passing over on the way somewhere else is not turning it.
      if (performance.now() - s.enteredAt < DWELL_MS) return;
      const last = live.current.apps.length - 1;
      if (last < 0) return;
      event.preventDefault();

      if (!isTrackpad(event)) {
        // A notch is a card, however hard the wheel was turned.
        const dir = Math.sign(pixels(event));
        if (!dir) return;
        const next = Math.round(s.target) + dir;
        if (next < 0 || next > last) {
          audio.click('thud');
          // A push into the end: the stack gives a little and comes back.
          s.v += dir * 6;
          kick();
          return;
        }
        rollTo(next);
        return;
      }

      // A trackpad: the stack follows the fingers, one card per gesture.
      clearTimeout(s.quiet);
      s.quiet = setTimeout(endGesture, QUIET_MS);
      const g = s.gesture ??= { start: Math.max(0, Math.min(last, Math.round(s.target))), travel: 0, locked: false, bumped: false };
      if (g.locked) return;
      g.travel += pixels(event);
      const steps = g.travel / PX_PER_STEP;
      const next = g.start + Math.sign(steps);
      if (Math.abs(steps) >= 1 && next >= 0 && next <= last) {
        g.locked = true;
        rollTo(next);
        return;
      }
      const at = g.start + Math.max(-1, Math.min(1, steps));
      if ((at < 0 || at > last) && !g.bumped) {
        g.bumped = true;
        audio.click('thud');
      }
      rollTo(at);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      clearTimeout(s.quiet);
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
  }, []);

  // ⌘1, ⌘2, ⌘3: straight to an app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const n = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!n) return;
      const i = Number(n) - 1;
      if (i >= live.current.apps.length) return;
      event.preventDefault();
      open(i);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const app = apps[front];

  return (
    <div ref={root}
      onPointerEnter={() => { sim.current.enteredAt = performance.now(); }}
      onPointerLeave={() => {
        const s = sim.current;
        s.enteredAt = Number.POSITIVE_INFINITY;
        s.hover.on = false;
        // Whatever was browsed to stays in front: the hand leaving is not a choice either way.
        wake();
      }}
      onPointerMove={event => {
        const box = root.current?.getBoundingClientRect();
        if (!box) return;
        const s = sim.current;
        // Tilt by where the pointer is over the front card, about its centre.
        s.hover = {
          x: Math.max(-1, Math.min(1, (event.clientX - (box.left + PAD + CARD / 2)) / (CARD / 2))),
          y: Math.max(-1, Math.min(1, (event.clientY - (box.bottom - PAD - CARD / 2)) / (CARD / 2))),
          on: !s.gesture && event.pointerType === 'mouse',
        };
        wake();
      }}
      style={{ width: CARD + PAD * 2 + STACK_PX * 3, height: CARD + PAD * 2 + STACK_PX * 3 }}
      className={cn('absolute bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-2 z-20 transition-opacity duration-500 sm:bottom-4 sm:left-4',
        hidden && 'pointer-events-none opacity-0',
        // The stack's palette, turned with the room's hour ([data-dark] on the room):
        // cream and stage red by day; at night a lamp left on in the corner, warm and
        // a little brighter than the dark room around it. draw() leans card and icon
        // toward the hover pair under the hand, and rests the shadow on the rgb/a pair.
        '[--sw-card:#fbf5ef] [--sw-icon:#d2513f] [--sw-hover-card:#f4eae2] [--sw-hover-icon:#d2513f] [--sw-ring:rgb(58_38_34_/_0.08)] [--sw-shadow-rgb:80_40_20] [--sw-shadow-a:0.15] [--sw-behind:0.6]',
        'in-data-[dark=true]:[--sw-card:#4a3730] in-data-[dark=true]:[--sw-icon:#f2a493] in-data-[dark=true]:[--sw-hover-card:#54403a] in-data-[dark=true]:[--sw-hover-icon:#f6c3b6] in-data-[dark=true]:[--sw-ring:rgb(255_235_225_/_0.10)] in-data-[dark=true]:[--sw-shadow-rgb:0_0_0] in-data-[dark=true]:[--sw-shadow-a:0.35] in-data-[dark=true]:[--sw-behind:0.5]')}>
      {apps.map((a, i) => (
        <div key={a.id} ref={el => { cards.current[i] = el; }} aria-hidden="true"
          style={{ left: PAD, bottom: PAD, width: CARD, height: CARD, transformOrigin: '50% 50%' }}
          className={cn('absolute grid place-items-center rounded-[11px] bg-(--sw-card) text-(--sw-icon) will-change-transform',
            still && 'transition-opacity duration-200')}>
          <div className="size-8">{a.icon}</div>
          {/* The warm light across the face as it turns: only while it moves. */}
          <div ref={el => { shines.current[i] = el; }}
            className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[linear-gradient(105deg,transparent_35%,rgb(255_230_200/0.55)_50%,transparent_65%)] bg-[length:250%_100%] opacity-0 mix-blend-soft-light" />
          <svg className="pointer-events-none absolute inset-0 overflow-visible" viewBox={`0 0 ${CARD} ${CARD}`}>
            <rect ref={el => { traces.current[i] = el; }} x="0.75" y="0.75" width={CARD - 1.5} height={CARD - 1.5} rx="10.25"
              pathLength={1} strokeDasharray="1" strokeDashoffset="1" opacity="0"
              fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {a.dot && <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-(--paper-seal) ring-2 ring-(--base)" />}
        </div>
      ))}
      {app && (
        <button type="button" aria-label={app.label} title={app.label}
          onClick={() => {
            const i = sim.current.nearest;
            // In front and already up: the click switches on to the next one.
            open(apps[i]?.id === current ? (i + 1) % apps.length : i);
          }}
          style={{ left: PAD, bottom: PAD, width: CARD, height: CARD }}
          className="absolute z-[200] cursor-pointer rounded-[11px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--paper-seal)/60" />
      )}
    </div>
  );
}
