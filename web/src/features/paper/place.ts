/** The stage's box and the room's size, in the room's own coordinates. */
export type StageBox = { left: number; top: number; right: number; bottom: number; roomW: number; roomH: number };

/**
 * Where the paper sits: the right of the stage itself, top to bottom, the
 * stage split in two. Her column moves over by `reserve` to keep clear of it.
 * On a stage too narrow to share, the paper covers it, and nothing moves.
 */
export type PaperPlace = {
  width: number;
  /** How much of the stage's right the paper takes: what her column leaves free. */
  reserve: number;
  /** Where the paper corner rests once it is put away, in the room. */
  corner: { left: number; top: number };
};

/** The paper's part of a shared stage, and the stage width below which it is not shared. */
const SHARE = 0.4;
const SHARED_FROM = 640;

export function placePaper(stage: StageBox): PaperPlace {
  const stageW = stage.right - stage.left;
  const shared = stageW >= SHARED_FROM;
  const width = shared ? Math.round(stageW * SHARE) : stageW;
  return { width, reserve: shared ? width : 0, corner: { left: stage.right - 18, top: stage.top + 72 } };
}
