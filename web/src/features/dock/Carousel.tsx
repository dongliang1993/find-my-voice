import { useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { cn } from '@/lib/utils';

export type CarouselApp = { id: string; label: string; icon: React.ReactElement };

export type CarouselHandle = {
  /** The wheel is quiet: the stack rolls to its nearest card and stays. */
  snap: () => void;
};

type Props = {
  apps: CarouselApp[];
  onPick: (id: string) => void;
  /** The front card changed — rolling away from the app that is up takes it off the stage. */
  onFront?: (id: string) => void;
  still?: boolean;
  hidden?: boolean;
  ref?: Ref<CarouselHandle>;
};

/** The stack's own numbers. */
const FOV = 30;
const CAMERA_D = 1000;
const DEPTH = 300;   // world units a card recedes per step along the diagonal
const WHEEL_CARD = 100; // wheel deltas per card: one notch of a mouse wheel, a trackpad flick

/** The card as a texture: the icon alone, at the card's own size — no plate under it. */
const TEX = 512;
const ICON = TEX;

type Card = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
type Front = { cardW: number; cardH: number; ax: number; ay: number; stepX: number; stepY: number };
type Three = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cards: Card[];
  w: number;
  h: number;
  dirty: boolean;
  front0: Front | null;
};

type Colors = { paper: string; edge: string; sans: string };

function readColors(): Colors {
  const root = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  return {
    paper: v('--paper', '#f7f2e8'),
    edge: v('--paper-edge', 'rgba(74, 63, 53, 0.2)'),
    sans: v('--font-sans', 'system-ui'),
  };
}

/** The icons are drawn in currentColor; the card wants them in the paper's ink, at a size a raster can hold. */
function iconUrl(icon: React.ReactElement, ink: string): string {
  // xmlns is not optional here: off the DOM, an <img> will refuse the whole
  // SVG without it — and it refuses quietly, so the card stays blank.
  const svg = renderToStaticMarkup(icon)
    .replaceAll('currentColor', ink)
    .replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" `);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A transparent canvas: the icon is the card — nothing under it, nothing over it. */
function drawCard(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEX;
  canvas.height = TEX;
  return canvas;
}

/**
 * The app stack over the dock: each app a card, laid along the diagonal —
 * the front one just above the dock, the rest climbing to the right and up,
 * receding in depth so they shrink as they go. The hand rolls it: moving
 * down the dock slides the stack from the top right toward the bottom left,
 * moving up slides it back. Turning never opens anything — a click on the
 * front card does.
 */
export function Carousel({ apps, onPick, onFront, still = false, hidden = false, ref }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** Where the stack is, and where the hand wants it. */
  const roll = useRef(0);
  const target = useRef(0);
  const three = useRef<Three | null>(null);
  const stillRef = useRef(still);
  const appsRef = useRef(apps);
  const pickRef = useRef(onPick);
  const frontRef = useRef(onFront);
  /** The card the click button rides. */
  const front = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { stillRef.current = still; }, [still]);
  useEffect(() => { appsRef.current = apps; }, [apps]);
  useEffect(() => { pickRef.current = onPick; }, [onPick]);
  useEffect(() => { frontRef.current = onFront; }, [onFront]);

  const snap = () => {
    const n = appsRef.current.length;
    target.current = Math.max(0, Math.min(n - 1, Math.round(target.current)));
    if (three.current) three.current.dirty = true;
  };

  /** The wheel over the corner: it rolls the stack, then a quiet moment snaps it to a card. */
  const wheel = (event: React.WheelEvent) => {
    const n = appsRef.current.length;
    if (!n) return;
    event.preventDefault();
    // The ends are walls: the stack stops dead at the first and last card, no overshoot to spring back from.
    const next = Math.max(0, Math.min(n - 1, target.current + event.deltaY / WHEEL_CARD));
    if (next === target.current) return;
    target.current = next;
    if (three.current) three.current.dirty = true;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(snap, 140);
  };

  useImperativeHandle(ref, () => ({ snap }), []);

  const buildCards = (t: Three) => {
    for (const m of t.cards) {
      t.scene.remove(m);
      m.material.map?.dispose();
      m.material.dispose();
      m.geometry.dispose();
    }
    t.cards = [];
    const colors = readColors();
    t.cards = appsRef.current.map(app => {
      const canvas = drawCard();
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, t.renderer.capabilities.getMaxAnisotropy());
      const mesh: Card = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
      );
      t.scene.add(mesh);
      // The icon arrives off the thread of the data URL; drawn late, the card is still there.
      const img = new Image();
      img.onload = () => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, ICON, ICON);
        tex.needsUpdate = true;
        if (three.current === t) t.dirty = true;
      };
      // One ink for the whole stack, and a fixed one: the theme may go dark, the cards stay cream.
      img.src = iconUrl(app.icon, '#fffaf5');
      return mesh;
    });
    t.dirty = true;
  };

  /** One card's place on the screen, from its depth in the stack. */
  const layout = (t: Three, r: number) => {
    const { w, h } = t;
    if (!w || !h) return;
    // The size the front card was told to take: the one the back card showed, no bigger.
    const cardW = w < 640 ? 48 : 60;
    const cardH = cardW;
    // Down in the corner but not on its floor: the front card sits a hand's
    // width above the edge, the stack climbing away from it.
    const ax = cardW * 1.6;
    const ay = h - cardH * 0.55 - 56;
    // Same-size icons need their own room: the step clears a card's width,
    // so the stack climbs the diagonal without one icon piled on the next.
    const stepX = cardW + 12;
    const stepY = Math.round(cardW * 0.75) + 6;
    t.front0 = { cardW, cardH, ax, ay, stepX, stepY };
    const tan = Math.tan((FOV * Math.PI) / 360);
    const s0 = (2 * CAMERA_D * tan) / h; // px → world at the front card's depth
    t.cards.forEach((mesh, i) => {
      const d = i - r;
      const dist = CAMERA_D + d * DEPTH;
      const s = (2 * dist * tan) / h;
      const cx = ax + stepX * d;
      const cy = ay - stepY * d;
      mesh.position.set((cx - w / 2) * s, (h / 2 - cy) * s, -d * DEPTH);
      // Each card scaled to its own depth: every icon lands the same size on
      // screen — the front one no bigger than the one behind it. The stack's
      // depth is told by position alone, not by shrinking.
      mesh.scale.set(cardW * s, cardH * s, 1);
      // Past the front it is on its way out; behind, the stack holds — depth does the work, not transparency.
      const o = d < 0 ? Math.max(0, 1 + d * 2.4) : 1;
      mesh.material.opacity = o;
      mesh.visible = o > 0.01 && dist > 100;
    });
  };

  /** The click rides the card coming to the front — a plain button, moved to wherever the card is. */
  const placeButton = (t: Three, r: number) => {
    const button = buttonRef.current;
    const f = t.front0;
    if (!button || !f) return;
    const appsNow = appsRef.current;
    if (!appsNow.length) { button.style.visibility = 'hidden'; return; }
    const idx = Math.max(0, Math.min(appsNow.length - 1, Math.round(target.current)));
    const d = idx - r;
    const dist = CAMERA_D + d * DEPTH;
    const sw = (f.cardW * CAMERA_D) / dist;
    const sh = f.cardH * (sw / f.cardW);
    const cx = f.ax + f.stepX * d;
    const cy = f.ay - f.stepY * d;
    const o = d < 0 ? Math.max(0, 1 + d * 2.4) : 1;
    button.style.visibility = o > 0.2 ? 'visible' : 'hidden';
    button.style.opacity = String(Math.max(0.35, Math.min(1, o)));
    button.style.width = `${f.cardW}px`;
    button.style.height = `${f.cardH}px`;
    button.style.transform = `translate(${cx - sw / 2}px, ${cy - sh / 2}px) scale(${sw / f.cardW})`;
    if (front.current !== idx) {
      front.current = idx;
      const app = appsNow[idx]!;
      button.title = app.label;
      button.setAttribute('aria-label', app.label);
      frontRef.current?.(app.id);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 100, 4000);
    camera.position.set(0, 0, CAMERA_D);
    const t: Three = { renderer, scene, camera, cards: [], w: 0, h: 0, dirty: true, front0: null };
    three.current = t;

    const size = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      t.w = r.width;
      t.h = r.height;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      t.dirty = true;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(canvas);

    buildCards(t);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (Math.abs(target.current - roll.current) > 0.0004) {
        roll.current += (target.current - roll.current) * (stillRef.current ? 1 : 1 - Math.exp(-14 * dt));
        t.dirty = true;
      } else if (roll.current !== target.current) {
        roll.current = target.current;
        t.dirty = true;
      }
      if (t.dirty) {
        layout(t, roll.current);
        t.renderer.render(t.scene, t.camera);
        placeButton(t, roll.current);
        t.dirty = false;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (settleTimer.current) clearTimeout(settleTimer.current);
      for (const m of t.cards) {
        t.scene.remove(m);
        m.material.map?.dispose();
        m.material.dispose();
        m.geometry.dispose();
      }
      renderer.dispose();
      three.current = null;
    };
    // The cards are rebuilt by the apps effect; the scene here is built once.
  }, []);

  useEffect(() => {
    if (three.current) buildCards(three.current);
    const n = apps.length;
    target.current = Math.max(0, Math.min(Math.max(0, n - 1), target.current));
    roll.current = Math.max(0, Math.min(Math.max(0, n - 1), roll.current));
  }, [apps]);

  return (
    // One layer under the stage, down in the room's bottom-left corner: the
    // cards lie behind the panel, only their edges showing past it. The
    // wheel over the corner rolls them; the front card takes a click.
    <div onWheel={wheel}
      className={cn('absolute bottom-0 left-0 h-[240px] w-[min(42dvw,420px)] cursor-default touch-none transition-opacity duration-500', hidden && 'pointer-events-none opacity-0')}>
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
      <button ref={buttonRef} type="button"
        onClick={() => { const id = appsRef.current[front.current]?.id; if (id) pickRef.current(id); }}
        className="absolute left-0 top-0 cursor-pointer rounded-[8%] focus-visible:outline-2 focus-visible:outline-(--paper-seal)/60"
        style={{ visibility: 'hidden', transformOrigin: 'top left' }} />
    </div>
  );
}
