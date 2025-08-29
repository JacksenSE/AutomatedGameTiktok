import Phaser from 'phaser';
import type { Team, UnitKind, UnitDef } from './unitDefs';

export type FighterState =
  | 'idle'
  | 'chase'
  | 'windup'
  | 'recover'
  | 'block'
  | 'dead';

export class Fighter extends Phaser.Physics.Matter.Sprite {
  id: string;
  name: string;
  team: Team;
  kind: UnitKind;
  defn: UnitDef;

  // Stats (copied from defn at spawn)
  level = 1;
  maxHP = 100;
  hp = 100;
  atk = 12;
  def = 3;
  range = 120;
  speed = 0.75;

  // UI
  label: Phaser.GameObjects.Text;
  hpBarBg: Phaser.GameObjects.Rectangle;
  hpBar: Phaser.GameObjects.Rectangle;

  // Runtime
  state: FighterState = 'idle';
  target?: Fighter;

  facing: 1 | -1 = 1; // 1 right, -1 left
  frictionAir = 0.06;

  // Timers
  attackCd = 0;
  windupMs = 220;
  recoverMs = 180;
  staggerMs = 0;

  // AI throttle
  aiCdMs = 60; // first think comes quickly, then Scene resets to ~120–160ms

  // Block
  canBlock = false;
  blockReductionPct = 0.7;
  blockMs = 260;
  blockCd = 0;

  // Internal
  private _dead = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    id: string,
    name: string,
    team: Team,
    kind: UnitKind,
    defn: UnitDef
  ) {
    const baseKey = `${kind}_idle_100`;
    const has = scene.textures.exists(baseKey);

    // Use scene.matter.world
    super(scene.matter.world, x, y, has ? baseKey : (undefined as any), 0);
    scene.add.existing(this);

    this.id = id;
    this.name = name;
    this.team = team;
    this.kind = kind;
    this.defn = defn;

    // Copy stats from definition
    this.maxHP = defn.stats.maxHP;
    this.hp = defn.stats.maxHP;
    this.atk = defn.stats.atk;
    this.def = defn.stats.def;
    this.range = defn.stats.range;
    this.speed = defn.stats.speed;

    this.windupMs = defn.timings?.windupMs ?? this.windupMs;
    this.recoverMs = defn.timings?.recoverMs ?? this.recoverMs;
    this.attackCd = 0;

    this.canBlock = !!defn.canBlock;
    this.blockReductionPct = defn.blockReductionPct ?? this.blockReductionPct;

    // Matter body setup (lock rotation AFTER creating body)
    this.setIgnoreGravity(true);
    this.setRectangle(20, 28, { chamfer: 6 });
    this.setDepth(5);
    this.setFrictionAir(this.frictionAir);
    this.setFriction(0.08, 0.01, 0.0);
    this.setBounce(0);
    this.setFixedRotation();
    this.setRotation(0);
    this.setAngularVelocity(0);
    this.setScale(1.6);

    // Fallback texture if needed
    if (!has) {
      const g = scene.add.graphics();
      g.fillStyle(team === 'A' ? 0x4dd2ff : 0xff6a6a, 1);
      g.fillCircle(16, 16, 14);
      const texKey = `fallback_${id}`;
      g.generateTexture(texKey, 32, 32);
      g.destroy();
      this.setTexture(texKey);
    } else {
      this.setAnimIdle();
    }

    // UI
    this.label = scene.add.text(x, y - 42, name, {
      fontSize: '14px',
      color: '#ffffff',
      stroke: '#000',
      strokeThickness: 4,
    })
      .setOrigin(0.5)
      .setDepth(10);

    this.hpBarBg = scene.add
      .rectangle(x, y - 28, 46, 6, 0x222222, 0.9)
      .setOrigin(0.5)
      .setDepth(9);

    this.hpBar = scene.add
      .rectangle(x - 23, y - 28, 46, 6, 0x55ff77, 1)
      .setOrigin(0, 0.5)
      .setDepth(9);
  }

  // --------- Anim Helpers ----------
  private safePlay(key: string) {
    if (!this.scene || !this.scene.anims || !this.scene.anims.exists(key)) return;
    this.anims.play(key, true);
  }
  setAnimIdle() { this.safePlay(`${this.kind}_idle`); }
  setAnimRun()  {
    const runKey = `${this.kind}_run`;
    const walkKey = `${this.kind}_walk`;
    if (this.scene.anims.exists(runKey)) this.safePlay(runKey);
    else this.safePlay(walkKey);
  }
  setAnimAttack() {
    const choices = [`${this.kind}_attack2`, `${this.kind}_attack3`, `${this.kind}_attack`]
      .filter(k => this.scene.anims.exists(k));
    if (choices.length) this.safePlay(choices[Math.floor(Math.random() * choices.length)]);
    else this.safePlay(`${this.kind}_attack`);
  }
  setAnimHurt()  { this.safePlay(`${this.kind}_hurt`); }
  setAnimBlock() { this.safePlay(`${this.kind}_block`); }
  setAnimDeath() { this.safePlay(`${this.kind}_death`); }

  // ------------- Lifecycle -------------
  preUpdate(time: number, delta: number) {
    super.preUpdate(time, delta);

    // Keep UI pinned
    this.label.setPosition(this.x, this.y - 42);
    this.hpBarBg.setPosition(this.x, this.y - 28);
    this.hpBar.setPosition(this.x - 23, this.y - 28);

    // Stay upright, no spin
    if (this.rotation !== 0) this.setRotation(0);
    this.setAngularVelocity(0);

    // Face target (or preserve last facing)
    if (this.target && this.target.body) {
      this.facing = (this.target.x < this.x) ? -1 : 1;
    }
    this.setFlipX(this.facing < 0).setFlipY(false);

    const ms = delta;
    if (this.attackCd > 0) this.attackCd -= ms;
    if (this.staggerMs > 0) this.staggerMs -= ms;
    if (this.blockCd > 0) this.blockCd -= ms;

    // AI cooldown ticks here (Scene reads it)
    if (this.aiCdMs > 0) this.aiCdMs -= ms;
  }

  resolveHit(target: Fighter) {
    if (this._dead || !target || target._dead) return;
    target.takeDamage(this.atk + this.level * 2);
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const kx = (dx / dist) * 1.2;
    const ky = (dy / dist) * 1.2;
    if (target.body) target.setVelocity(
      (((target.body as any).velocity?.x) ?? 0) + kx,
      (((target.body as any).velocity?.y) ?? 0) + ky
    );
  }

  enter(state: FighterState) {
    if (this._dead) return;
    this.state = state;
    if (state === 'idle') this.setAnimIdle();
    if (state === 'chase') this.setAnimRun();
    if (state === 'windup') this.setAnimAttack();
    if (state === 'block') this.setAnimBlock();
  }

  tryBeginBlock(){
    if (!this.canBlock || this.blockCd > 0 || this.state === 'block') return false;
    this.state = 'block';
    this.setAnimBlock();
    this.blockCd = 1300; // cooldown
    (this.scene as any).time.delayedCall(this.blockMs, () => {
      if (!this._dead) this.enter('idle');
    });
    return true;
  }

  takeDamage(dmg: number) {
    if (this._dead) return;

    if (this.canBlock && this.blockCd <= 0 && Math.random() < 0.28) {
      if (this.tryBeginBlock()) {
        dmg = Math.floor(dmg * (1 - this.blockReductionPct));
      }
    }

    const real = Math.max(1, Math.floor(dmg - this.def));
    this.hp = Math.max(0, this.hp - real);

    const pct = this.hp / this.maxHP;
    this.hpBar.scaleX = pct;
    this.hpBar.fillColor = pct > 0.5 ? 0x55ff77 : pct > 0.25 ? 0xffd866 : 0xff5566;

    this.setAnimHurt();
    this.staggerMs = Math.max(this.staggerMs, 120);

    if (this.hp <= 0) this.die();
  }

  heal(amount: number) {
    if (this._dead) return;
    this.hp = Math.min(this.maxHP, this.hp + amount);
    const pct = this.hp / this.maxHP;
    this.hpBar.scaleX = pct;
    this.hpBar.fillColor = pct > 0.5 ? 0x55ff77 : pct > 0.25 ? 0xffd866 : 0xff5566;
  }

  die() {
    if (this._dead) return;
    this._dead = true;
    this.state = 'dead';
    this.setAnimDeath();
    const [minMs, maxMs] = this.defn.timings?.deathDespawnMs ?? [1000, 2500];
    const t = Phaser.Math.Between(minMs, maxMs);
    (this.scene as any).time.delayedCall(t, () => {
      if (!this.active) return;
      this.setActive(false).setVisible(false);
      this.label.destroy(); this.hpBar.destroy(); this.hpBarBg.destroy();
      this.destroy();
    });
  }
}
