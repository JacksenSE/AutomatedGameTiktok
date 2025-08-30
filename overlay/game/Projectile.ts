import Phaser from 'phaser';
import type { Team } from './unitDefs';

export type ProjectileKind = 'arrow' | 'magic' | 'heal' | 'generic';

export class Projectile extends Phaser.GameObjects.Sprite {
  team: Team = 'A';
  kind: ProjectileKind = 'generic';
  dmg = 0;
  radius = 10;
  aoeRadius?: number;
  vx = 0;
  vy = 0;
  lifeMs = 0;
  maxLifeMs = 2500;
  ownerId = '';
  
  private _alive = false;
  private _pooled = false;

  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0, '');
    scene.add.existing(this);
    this.setDepth(6);
  }

  init(
    x: number, y: number,
    team: Team,
    kind: ProjectileKind,
    vx: number, vy: number,
    dmg: number,
    ownerId: string,
    radius = 10,
    maxLifeMs = 2500,
    aoeRadius?: number
  ): void {
    this.setPosition(x, y);
    this.team = team;
    this.kind = kind;
    this.vx = vx;
    this.vy = vy;
    this.dmg = dmg;
    this.ownerId = ownerId;
    this.radius = radius;
    this.maxLifeMs = maxLifeMs;
    this.aoeRadius = aoeRadius;
    
    this.lifeMs = 0;
    this._alive = true;
    this._pooled = false;
    
    // Set texture and scale
    const texKey = this.getTextureKey(kind);
    this.setTexture(texKey);
    this.setScale(kind === 'magic' ? 0.7 : 0.5);
    this.setRotation(Math.atan2(vy, vx));
    
    this.setActive(true).setVisible(true);
  }

  private getTextureKey(kind: ProjectileKind): string {
    const global = `proj_${kind}`;
    if (this.scene.textures.exists(global)) return global;
    
    const g = this.scene.add.graphics();
    switch (kind) {
      case 'arrow':
        g.fillStyle(0xffffff, 1);
        g.fillRect(0, 5, 22, 2);
        g.fillStyle(0x222222, 1);
        g.fillTriangle(22, 6, 16, 9, 16, 3);
        g.generateTexture(global, 26, 12);
        break;
      case 'magic':
        g.fillStyle(0x66ccff, 1);
        g.fillCircle(8, 8, 8);
        g.generateTexture(global, 16, 16);
        break;
      case 'heal':
        g.fillStyle(0x66ff99, 1);
        g.fillCircle(8, 8, 8);
        g.generateTexture(global, 16, 16);
        break;
      default:
        g.fillStyle(0xffffff, 1);
        g.fillCircle(6, 6, 6);
        g.generateTexture(global, 12, 12);
        break;
    }
    g.destroy();
    return global;
  }

  updateFixed(dtMs: number): void {
    if (!this._alive || this._pooled) return;
    
    const dtSec = dtMs / 1000;
    this.x += this.vx * dtSec;
    this.y += this.vy * dtSec;
    
    this.lifeMs += dtMs;
    if (this.lifeMs > this.maxLifeMs) {
      this.kill();
    }
  }

  kill(): void {
    if (!this._alive) return;
    this._alive = false;
  }

  reset(): void {
    this._pooled = true;
    this._alive = false;
    this.setActive(false).setVisible(false);
  }

  get alive(): boolean {
    return this._alive;
  }

  get isPooled(): boolean {
    return this._pooled;
  }
}