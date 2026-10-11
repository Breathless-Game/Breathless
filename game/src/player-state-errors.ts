/**
 * The player_state program's error codes (lib.rs PlayerStateError, Anchor numbers them from 6000
 * in declaration order) and a reader that finds one in whatever a failed send or confirmation
 * threw: `{ InstructionError: [i, { Custom: n }] }`, a TxFailedError's message, or preflight logs
 * ("custom program error: 0x1779"). No imports: tests load it on its own.
 */
export const PLAYER_STATE_ERRORS = [
  'Unauthorized',
  'InvalidSlot',
  'InvalidPath',
  'NoPathsForSlot',
  'PathLocked',
  'MaxLevel',
  'InvalidRecipe',
  'MissingMaterials',
  'NoComposite',
  'InsufficientPearl',
  'WrongMint',
  'WrongTokenProgram',
  'WrongTokenOwner',
  'InvalidPriceTable',
  'Overflow',
  'InvalidFood',
  'BadFishList',
  'FullyGrown',
  'FeedCooldown',
  'BadClock',
] as const;

export type PlayerStateErrorName = (typeof PLAYER_STATE_ERRORS)[number];

const nameOf = (code: number): PlayerStateErrorName | null => PLAYER_STATE_ERRORS[code - 6000] ?? null;

/** The program error inside `e`, or null when it is not one of player_state's. */
export function playerStateErrorName(e: unknown): PlayerStateErrorName | null {
  const seen = new Set<unknown>();
  const visit = (v: unknown): PlayerStateErrorName | null => {
    if (v == null || seen.has(v)) return null;
    if (typeof v === 'string') {
      const hex = /custom program error: 0x([0-9a-f]+)/i.exec(v);
      if (hex) return nameOf(parseInt(hex[1], 16));
      const json = /"Custom":\s*(\d+)/.exec(v);
      if (json) return nameOf(Number(json[1]));
      const anchor = /Error Code: (\w+)/.exec(v);
      if (anchor && (PLAYER_STATE_ERRORS as readonly string[]).includes(anchor[1])) return anchor[1] as PlayerStateErrorName;
      return null;
    }
    if (typeof v !== 'object') return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.Custom === 'number') return nameOf(o.Custom);
    for (const key of ['err', 'InstructionError', 'logs', 'cause', 'message']) {
      const inner = o[key];
      if (Array.isArray(inner)) {
        for (const item of inner) {
          const hit = visit(item);
          if (hit) return hit;
        }
      } else {
        const hit = visit(inner);
        if (hit) return hit;
      }
    }
    return null;
  };
  return visit(e);
}
