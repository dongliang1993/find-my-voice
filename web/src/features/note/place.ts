/** The stage's box and the room's size, in the room's own coordinates. */
export type StageBox = { left: number; top: number; right: number; bottom: number; roomW: number; roomH: number };

/**
 * Where the note sits. `outside`: beside the stage, its top on the stage's top.
 * `over`: there is no room beside it, so it lies plainly over the stage's
 * bottom-right corner instead — never half on, half off.
 */
export type NotePlace = {
  side: 'outside' | 'over';
  width: number;
  maxHeight: number;
  at: { left?: number; top?: number; right?: number; bottom?: number };
  /** Where the paper corner rests once it is put away. */
  corner: { left: number; top: number };
};

const WIDTH = 300;
const GAP = 28;
const MARGIN = 16;

export function placeNote(stage: StageBox): NotePlace {
  const maxHeight = Math.round(stage.roomH * 0.7);
  if (stage.roomW - stage.right >= WIDTH + GAP + MARGIN) {
    return {
      side: 'outside', width: WIDTH, maxHeight,
      at: { left: stage.right + GAP, top: stage.top },
      corner: { left: stage.right, top: stage.top + 24 },
    };
  }
  const width = Math.min(WIDTH, stage.roomW - 2 * MARGIN);
  const inset = 20;
  return {
    side: 'over', width, maxHeight: Math.min(maxHeight, stage.bottom - stage.top - 2 * inset - 64),
    // Above the mat, clear of the circle's row on a narrow stage.
    at: { right: stage.roomW - stage.right + inset, top: stage.top + 64 },
    corner: { left: stage.right - 18, top: stage.top + 72 },
  };
}
