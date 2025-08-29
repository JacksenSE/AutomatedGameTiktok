// Central place to describe every unit, their role, stats, attack style,
// and which side they're allowed to be on.

export type Team = 'A' | 'B';

// Keep your "kind" names lower_snake_case to match folder names under assets/characters/<kind>/
export type UnitKind =
  | 'soldier'
  | 'knight'
  | 'knight_templar'
  | 'swordsman'
  | 'armored_axeman'
  | 'wizard'
  | 'priest'
  | 'archer'
  | 'lancer'
  | 'werewolf'
  | 'werebear'
  | 'orc'
  | 'armored_orc'
  | 'elite_orc'
  | 'skeleton'
  | 'armored_skeleton'
  | 'slime'
  | 'orc_rider'
  | 'greatsword_skeleton'
  | 'skeleton_archer';

export type Role = 'melee' | 'ranged' | 'magic' | 'healer';

export interface UnitDef {
  displayName: string;
  side: 'player' | 'enemy' | 'either';
  role: Role;
  stats: {
    maxHP: number;
    atk: number;
    def: number;
    range: number;   // engage/attack distance (px)
    speed: number;   // movement "units" per tick (tuned for Matter.setVelocity)
  };
  /** If enemy is closer than this, unit will backpedal.
   *  Defaults to 0 (melee) if not set. */
  minRange?: number;

  timings?: {
    windupMs?: number;
    recoverMs?: number;
    attackCooldownMs?: number;
    deathDespawnMs?: [number, number];
  };

  canBlock?: boolean;
  blockReductionPct?: number;

  projectile?: {
    texture?: 'arrow' | 'magic' | 'heal';
    speed?: number;
    radius?: number;
    aoeRadius?: number;
  };
}


export const UNIT_DEFS: Record<UnitKind, UnitDef> = {
  // ---------- PLAYERS (team A) ----------
  soldier: {
    displayName: 'Soldier',
    side: 'player', role: 'melee',
    stats: { maxHP: 110, atk: 12, def: 3, range: 90, speed: 0.75 },
    timings: { windupMs: 220, recoverMs: 180, attackCooldownMs: 900, deathDespawnMs: [1000, 2200] },
  },
  swordsman: {
    displayName: 'Swordsman',
    side: 'player', role: 'melee',
    stats: { maxHP: 105, atk: 14, def: 3, range: 95, speed: 0.80 },
    timings: { windupMs: 210, recoverMs: 170, attackCooldownMs: 850, deathDespawnMs: [1000, 2200] },
  },
  knight: {
    displayName: 'Knight',
    side: 'player', role: 'melee',
    stats: { maxHP: 140, atk: 16, def: 6, range: 96, speed: 0.72 },
    canBlock: true, blockReductionPct: 0.7,
    timings: { windupMs: 240, recoverMs: 200, attackCooldownMs: 950, deathDespawnMs: [1200, 2500] },
  },
  knight_templar: {
    displayName: 'KnightTemplar',
    side: 'player', role: 'melee',
    stats: { maxHP: 160, atk: 20, def: 7, range: 98, speed: 0.72 },
    canBlock: true, blockReductionPct: 0.75,
    timings: { windupMs: 250, recoverMs: 220, attackCooldownMs: 950, deathDespawnMs: [1200, 2600] },
  },
  armored_axeman: {
    displayName: 'Armored Axeman',
    side: 'player', role: 'melee',
    stats: { maxHP: 150, atk: 22, def: 5, range: 92, speed: 0.68 },
    timings: { windupMs: 270, recoverMs: 250, attackCooldownMs: 1050, deathDespawnMs: [1200, 2600] },
  },
  lancer: {
    displayName: 'Lancer',
    side: 'player', role: 'melee',
    stats: { maxHP: 115, atk: 16, def: 3, range: 120, speed: 0.86 }, // longer reach
    timings: { windupMs: 220, recoverMs: 160, attackCooldownMs: 900, deathDespawnMs: [1000, 2200] },
  },
  archer: {
    displayName: 'Archer',
    side: 'player', role: 'ranged',
    stats: { maxHP: 90, atk: 14, def: 2, range: 220, speed: 0.72 },
    projectile: { texture: 'arrow', speed: 520, radius: 10 },
    timings: { windupMs: 220, recoverMs: 100, attackCooldownMs: 900, deathDespawnMs: [900, 2000] },
  },
  wizard: {
    displayName: 'Wizard',
    side: 'player', role: 'magic',
    stats: { maxHP: 88, atk: 18, def: 2, range: 300, speed: 0.70 },
        minRange: 200,
    projectile: { texture: 'magic', speed: 480, radius: 16, aoeRadius: 42 },
    timings: { windupMs: 280, recoverMs: 160, attackCooldownMs: 1150, deathDespawnMs: [900, 2000] },
  },
  priest: {
    displayName: 'Priest',
    side: 'player', role: 'healer',
    stats: { maxHP: 92, atk: 0, def: 2, range: 250, speed: 0.70 },
    minRange: 150,
    projectile: { texture: 'heal', speed: 1, radius: 15 },
    timings: { windupMs: 260, recoverMs: 160, attackCooldownMs: 1200, deathDespawnMs: [900, 2000] },
  },
  werewolf: {
    displayName: 'Werewolf',
    side: 'player', role: 'melee',
    stats: { maxHP: 170, atk: 26, def: 5, range: 95, speed: 1.0 },
    timings: { windupMs: 180, recoverMs: 140, attackCooldownMs: 800, deathDespawnMs: [1200, 2600] },
  },
  werebear: {
    displayName: 'Werebear',
    side: 'player', role: 'melee',
    stats: { maxHP: 210, atk: 28, def: 7, range: 100, speed: 0.62 },
    timings: { windupMs: 300, recoverMs: 240, attackCooldownMs: 1200, deathDespawnMs: [1400, 2800] },
  },

  // ---------- ENEMIES (team B) ----------
  orc: {
    displayName: 'Orc',
    side: 'enemy', role: 'melee',
    stats: { maxHP: 100, atk: 12, def: 2, range: 90, speed: 0.76 },
    timings: { windupMs: 220, recoverMs: 180, attackCooldownMs: 950, deathDespawnMs: [800, 2000] },
  },
  armored_orc: {
    displayName: 'ArmoredOrc',
    side: 'enemy', role: 'melee',
    stats: { maxHP: 140, atk: 16, def: 4, range: 92, speed: 0.70 },
    timings: { windupMs: 240, recoverMs: 200, attackCooldownMs: 980, deathDespawnMs: [900, 2200] },
  },
  elite_orc: {
    displayName: 'EliteOrc',
    side: 'enemy', role: 'melee',
    stats: { maxHP: 160, atk: 20, def: 5, range: 94, speed: 0.78 },
    timings: { windupMs: 230, recoverMs: 180, attackCooldownMs: 900, deathDespawnMs: [900, 2200] },
  },
  orc_rider: {
    displayName: 'Orc Rider',
    side: 'enemy', role: 'melee',
    stats: { maxHP: 170, atk: 22, def: 5, range: 96, speed: 1.05 },
    timings: { windupMs: 220, recoverMs: 160, attackCooldownMs: 850, deathDespawnMs: [900, 2200] },
  },
  skeleton: {
    displayName: 'Skeleton',
    side: 'enemy', role: 'melee',
    stats: { maxHP: 80, atk: 10, def: 1, range: 88, speed: 0.78 },
    timings: { windupMs: 210, recoverMs: 150, attackCooldownMs: 900, deathDespawnMs: [700, 1800] },
  },
  armored_skeleton: {
    displayName: 'ArmoredSkeleton',
    side: 'enemy', role: 'melee',
    stats: { maxHP: 120, atk: 14, def: 3, range: 90, speed: 0.74 },
    timings: { windupMs: 220, recoverMs: 170, attackCooldownMs: 930, deathDespawnMs: [800, 2000] },
  },
  greatsword_skeleton: {
    displayName: 'GreatswordSkeleton',
    side: 'enemy', role: 'melee',
    stats: { maxHP: 130, atk: 18, def: 2, range: 98, speed: 0.72 },
    timings: { windupMs: 260, recoverMs: 220, attackCooldownMs: 1100, deathDespawnMs: [900, 2200] },
  },
  skeleton_archer: {
    displayName: 'SkeletonArcher',
    side: 'enemy', role: 'ranged',
    stats: { maxHP: 85, atk: 12, def: 1, range: 210, speed: 0.72 },
    projectile: { texture: 'arrow', speed: 500, radius: 10 },
    timings: { windupMs: 230, recoverMs: 120, attackCooldownMs: 950, deathDespawnMs: [800, 2000] },
  },
  slime: {
    displayName: 'Slime',
    side: 'enemy', role: 'melee',
    stats: { maxHP: 60, atk: 8, def: 0, range: 80, speed: 0.65 },
    timings: { windupMs: 260, recoverMs: 200, attackCooldownMs: 1050, deathDespawnMs: [600, 1600] },
  },
};
