import Phaser from 'phaser';
import type { Team } from './unitDefs';

export type ProjectileKind = 'arrow' | 'magic' | 'heal' | 'generic';

export interface ProjectileOptions {
  team: Team;
  kind: ProjectileKind;
  x: number; y: number;
  vx: number; vy: number;
  dmg: number;                 // also used as heal amount for 'heal'
  radius?: number;             // collision radius
  maxLifeMs?: number;          // lifetime
  aoeRadius?: number;          // magic splash
}

export class Projectile {
  scene: Phaser.Scene;
  sprite: Phaser.GameObjects.Image;
  alive = true;
  team: Team;
  kind: ProjectileKind;
  dmg: number;
  radius: number;
  aoeRadius?: number;
  vx: number;
  vy: number;
  lifeMs: number;
  maxLifeMs: number;

  constructor(scene: Phaser.Scene, texKey: string, opts: ProjectileOptions){
    this.scene = scene;
    this.team = opts.team;
    this.kind = opts.kind;
    this.dmg = opts.dmg;
    this.radius = opts.radius ?? 10;
    this.aoeRadius = opts.aoeRadius;
    this.vx = opts.vx; this.vy = opts.vy;
    this.lifeMs = 0; this.maxLifeMs = opts.maxLifeMs ?? 2500;

    // Create as plain image, not physics; we'll do simple swept collision
    this.sprite = scene.add.image(opts.x, opts.y, texKey)
      .setDepth(6)
      .setScale(this.kind === 'magic' ? 0.7 : 0.5)
      .setRotation(Math.atan2(this.vy, this.vx));
  }

  update(dt: number){
    if (!this.alive) return;
    const nx = this.sprite.x + this.vx * (dt/1000);
    const ny = this.sprite.y + this.vy * (dt/1000);
    this.sprite.setPosition(nx, ny);
    this.lifeMs += dt;
    if (this.lifeMs > this.maxLifeMs) this.destroy();
  }

  destroy(){
    if (!this.alive) return;
    this.alive = false;
    this.sprite.destroy();
  }
}
