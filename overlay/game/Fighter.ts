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

  // ---- UI (baked) ----
  /** Single image containing: avatar (for Team A) + name + role line. */
  private plate?: Phaser.GameObjects.Image;
  /** Tiny HP bar (visible only when damaged). */
  private hpBarBg!: Phaser.GameObjects.Rectangle;
  private hpBar!: Phaser.GameObjects.Rectangle;

  // ---- Runtime ----
  state: FighterState = 'idle';
  target?: Fighter;

  facing: 1 | -1 = 1; // 1 right, -1 left
  frictionAir = 0.06;

  // Timers
  attackCd = 0;
  windupMs = 220;
  recoverMs = 180;
  staggerMs = 0;

  // AI throttle (Scene can step this; we just expose a timer)
  aiCdMs = 0;

  // Block
  canBlock = false;
  blockReductionPct = 0.7;
  blockMs = 260;
  blockCd = 0;

  // Internal
  private _dead = false;

  // Perf: track last pos so we only move UI when needed
  private _uiLastX = Number.NaN;
  private _uiLastY = Number.NaN;

  // Avatar loading
  private pfpUrl?: string;
  private pfpKey?: string; // 'pfp_<id>'

  // Layout constants
  private static readonly NAME_Y = -34; // slimmer stack
  private static readonly ROLE_Y = -22;
  private static readonly HP_Y   = -14;
  private static readonly AVATAR = { size: 18, gap: 3 }; // left circle (Team A only)
  private static readonly COLORS = {
    frame: 0xc9aa71,
    nameFill: 0x000000,
    roleFill: 0x000000,
    nameAlpha: 0.55,
    roleAlpha: 0.45,
    enemyFill: 0x000000,
    enemyAlpha: 0.35,
  };

  // ----- Enemy plate cache (reused by thousands) -----
  private static enemyPlateCache = new Map<string, string>(); // role/displayName -> textureKey

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
    super(scene.matter.world, x, y, has ? baseKey : (undefined as any), 0);
    scene.add.existing(this);

    this.id = id;
    this.name = name;
    this.team = team;
    this.kind = kind;
    this.defn = defn;

    // Copy stats
    this.maxHP   = defn.stats.maxHP;
    this.hp      = defn.stats.maxHP;
    this.atk     = defn.stats.atk;
    this.def     = defn.stats.def;
    this.range   = defn.stats.range;
    this.speed   = defn.stats.speed;
    this.windupMs = defn.timings?.windupMs ?? this.windupMs;
    this.recoverMs = defn.timings?.recoverMs ?? this.recoverMs;

    // Body (kinematic-ish)
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

    // Fallback look if no spritesheet
    if (!has) {
      const g = scene.add.graphics();
      g.fillStyle(team === 'A' ? 0x4dd2ff : 0xff6a6a, 1).fillCircle(16, 16, 14);
      const texKey = `fallback_${id}`;
      g.generateTexture(texKey, 32, 32);
      g.destroy();
      this.setTexture(texKey);
    } else {
      this.setAnimIdle();
    }

    // UI
    if (team === 'A') {
      // Player: 2-line plate with avatar bubble
      this.buildPlayerPlate(); // uses fallback initials until setAvatar() loads
    } else {
      // Enemy: single micro plate cached by role/displayName
      const key = Fighter.getOrCreateEnemyPlate(scene, defn.displayName);
      this.plate = scene.add.image(x, y + Fighter.NAME_Y, key)
        .setDepth(10)
        .setOrigin(0.5);
    }

    // Tiny HP bar (hidden at full)
    this.hpBarBg = scene.add.rectangle(x, y + Fighter.HP_Y, 30, 3, 0x222222, 0.9)
      .setOrigin(0.5)
      .setDepth(9)
      .setVisible(false);
    this.hpBar = scene.add.rectangle(x - 15, y + Fighter.HP_Y, 30, 3, 0x55ff77, 1)
      .setOrigin(0, 0.5)
      .setDepth(9)
      .setVisible(false);

    // seed AI timer a bit staggered
    this.aiCdMs = 80 + Phaser.Math.Between(0, 80);
  }

  // ---------------- Nameplate building ----------------

  /** Build the 2-line **player** plate as a single texture (avatar + name + role). */
  private buildPlayerPlate() {
    const scene = this.scene;
    const name = this.name || 'Player';
    const role = this.defn.displayName;

    // measure with temp texts (created once, then destroyed)
    const tName = scene.add.text(-10000, -10000, name, {
      fontSize: '10px', fontStyle: 'bold', color: '#ffffff'
    }).setDepth(-999);
    const tRole = scene.add.text(-10000, -10000, role, {
      fontSize: '9px', color: '#dddddd'
    }).setDepth(-999);

    // widths and layout
    const nameW = Math.max(40, Math.ceil(tName.width) + 8);
    const roleW = Math.max(36, Math.ceil(tRole.width) + 8);
    const textBlockW = Math.max(nameW, roleW);
    const A = Fighter.AVATAR;
    const leftW = A.size + A.gap; // avatar + gap
    const totalW = leftW + textBlockW;      // overall plate width
    const totalH = 12 + 10 + 4;             // name row + role row + small spacing

    // Make RT and draw
   const rt = scene.add
  .renderTexture(-9999, -9999, totalW + 2, totalH + 2)
  .setVisible(false);

    // background frames
    const g = scene.add.graphics();
    g.lineStyle(1, Fighter.COLORS.frame);
    // name row
    g.fillStyle(Fighter.COLORS.nameFill, Fighter.COLORS.nameAlpha)
      .fillRoundedRect(leftW + 0.5, 0.5, nameW, 12, 2);
    g.strokeRoundedRect(leftW + 0.5, 0.5, nameW, 12, 2);
    // role row
    g.fillStyle(Fighter.COLORS.roleFill, Fighter.COLORS.roleAlpha)
      .fillRoundedRect(leftW + 0.5, 13.5, roleW, 10, 2);
    g.strokeRoundedRect(leftW + 0.5, 13.5, roleW, 10, 2);

    // avatar bubble (gold ring)
    g.lineStyle(1, Fighter.COLORS.frame)
      .strokeCircle(A.size / 2 + 0.5, A.size / 2 + 0.5, A.size / 2);

    rt.draw(g, 0, 0);
    g.destroy();

    // draw avatar (masked circle) if loaded, otherwise initials badge
    const pfpKey = this.pfpKey && scene.textures.exists(this.pfpKey) ? this.pfpKey : undefined;
    if (pfpKey) {
      // Create a temp image, mask it with a circular bitmap, draw into RT, then destroy
      Fighter.ensureMaskTexture(scene, A.size);
      const img = scene.add.image(A.size / 2 + 0.5, A.size / 2 + 0.5, pfpKey)
        .setDisplaySize(A.size, A.size)
        .setOrigin(0.5);
      const maskSprite = scene.add.image(img.x, img.y, `ui_mask_${A.size}`).setVisible(false);
      const mask = new Phaser.Display.Masks.BitmapMask(scene, maskSprite);
      img.setMask(mask);
      rt.draw(img);
      img.destroy(); maskSprite.destroy();
    } else {
      // initials fallback drawn directly to RT
      const initials = (this.name || '?')
        .split(' ')
        .map(s => s[0]).join('').slice(0, 2).toUpperCase();
      const gi = scene.add.graphics();
      gi.fillStyle(0x2b2b2b, 1).fillCircle(A.size / 2 + 0.5, A.size / 2 + 0.5, A.size / 2);
      rt.draw(gi); gi.destroy();
      const ti = scene.add.text(A.size / 2 + 0.5, A.size / 2 + 0.5, initials, {
        fontSize: '9px', color: '#ffffff'
      }).setOrigin(0.5);
      rt.draw(ti); ti.destroy();
    }

    // draw texts
    tName.setPosition(leftW + nameW / 2 + 0.5, 6.5).setOrigin(0.5);
    tRole.setPosition(leftW + roleW / 2 + 0.5, 18.5).setOrigin(0.5);
    rt.draw(tName); rt.draw(tRole);
    tName.destroy(); tRole.destroy();

    // commit texture
    const texKey = `plate_p_${this.id}`;
    // If rebuilding, replace old texture (safe to remove first)
    if (scene.textures.exists(texKey)) scene.textures.remove(texKey);
    rt.saveTexture(texKey);
    rt.destroy();

    // attach as an Image
    if (!this.plate) {
      this.plate = scene.add.image(this.x, this.y + Fighter.NAME_Y, texKey)
        .setDepth(10)
        .setOrigin(0.5);
    } else {
      this.plate.setTexture(texKey);
    }
  }

  /** Enemy micro plate (1-line) cached by text (role/display name). */
  private static getOrCreateEnemyPlate(scene: Phaser.Scene, text: string): string {
    let got = Fighter.enemyPlateCache.get(text);
    if (got) return got;

    // measure
    const t = scene.add.text(-10000, -10000, text, { fontSize: '10px', color: '#dddddd' });
    const w = Math.max(34, Math.ceil(t.width) + 8);
    const h = 12;
 const rt = scene.add
  .renderTexture(-9999, -9999, w + 2, h + 2)
  .setVisible(false);

    const g = scene.add.graphics();
    g.lineStyle(1, Fighter.COLORS.frame);
    g.fillStyle(Fighter.COLORS.enemyFill, Fighter.COLORS.enemyAlpha)
      .fillRoundedRect(0.5, 0.5, w, h, 2);
    g.strokeRoundedRect(0.5, 0.5, w, h, 2);

    rt.draw(g, 0, 0); g.destroy();

    t.setPosition(w / 2 + 0.5, h / 2 + 0.5).setOrigin(0.5);
    rt.draw(t); t.destroy();

    const key = `plate_e_${text}`;
    rt.saveTexture(key); rt.destroy();
    Fighter.enemyPlateCache.set(text, key);
    return key;
  }

  private static ensureMaskTexture(scene: Phaser.Scene, size: number) {
    const key = `ui_mask_${size}`;
    if (scene.textures.exists(key)) return;
    const g = scene.add.graphics();
    g.fillStyle(0xffffff, 1).fillCircle(size / 2, size / 2, size / 2);
    g.generateTexture(key, size, size);
    g.destroy();
  }

  /** Public: set/change avatar URL. Rebuilds the baked plate when loaded. */
  setAvatar(url: string) {
    this.pfpUrl = url;
    this.pfpKey = `pfp_${this.id}`;
    // already loaded?
    if (this.scene.textures.exists(this.pfpKey)) {
      this.buildPlayerPlate();
      return;
    }
    const loader = this.scene.load;
    // one-time listeners
    const onComplete = (fileKey: string) => {
      if (fileKey === this.pfpKey) this.buildPlayerPlate();
    };
    const onError = (file: any) => {
      if (file && file.key === this.pfpKey) {
        console.warn(`[pfp] failed for ${this.name} -> ${url}`);
        this.buildPlayerPlate(); // build with initials
      }
    };
    loader.once(Phaser.Loader.Events.FILE_COMPLETE, onComplete);
    loader.once(Phaser.Loader.Events.FILE_LOAD_ERROR, onError);
    // @ts-ignore allow crossOrigin option
    loader.image(this.pfpKey, url, { crossOrigin: 'anonymous' });
    loader.start();
  }

  // ---------------- Anim Helpers ----------------
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

  // ---------------- Lifecycle ----------------
  preUpdate(time: number, delta: number) {
    super.preUpdate(time, delta);

    // Move UI only when needed
    if (this.x !== this._uiLastX || this.y !== this._uiLastY) {
      const x = this.x, y = this.y;
      this.plate?.setPosition(x, this.team === 'A' ? y + Fighter.NAME_Y : y + Fighter.NAME_Y);
      this.hpBarBg.setPosition(x, y + Fighter.HP_Y);
      this.hpBar.setPosition(x - 15, y + Fighter.HP_Y);
      this._uiLastX = x; this._uiLastY = y;
    }

    // keep upright
    if (this.rotation !== 0) this.setRotation(0);
    this.setAngularVelocity(0);

    // Face target (or preserve last)
    if (this.target && this.target.body) {
      this.facing = (this.target.x < this.x) ? -1 : 1;
    }
    this.setFlipX(this.facing < 0).setFlipY(false);

    // timers
    const ms = delta;
    if (this.attackCd > 0) this.attackCd -= ms;
    if (this.staggerMs > 0) this.staggerMs -= ms;
    if (this.blockCd > 0) this.blockCd -= ms;
    if (this.aiCdMs > 0) this.aiCdMs -= ms;
  }

  resolveHit(target: Fighter) {
    if (this._dead || !target || target._dead) return;
    target.takeDamage(this.atk + this.level * 2);

    // tiny knockback
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

  tryBeginBlock() {
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

    // reactive block chance
    if (this.canBlock && this.blockCd <= 0 && Math.random() < 0.28) {
      if (this.tryBeginBlock()) dmg = Math.floor(dmg * (1 - this.blockReductionPct));
    }

    const real = Math.max(1, Math.floor(dmg - this.def));
    const newHP = Math.max(0, this.hp - real);
    if (newHP === this.hp) return;
    this.hp = newHP;

    const pct = this.hp / this.maxHP;
    this.hpBar.scaleX = pct;
    this.hpBar.fillColor = pct > 0.5 ? 0x55ff77 : pct > 0.25 ? 0xffd866 : 0xff5566;

    // show HP bar when damaged
    const vis = this.hp < this.maxHP;
    this.hpBar.setVisible(vis);
    this.hpBarBg.setVisible(vis);

    this.setAnimHurt();
    this.staggerMs = Math.max(this.staggerMs, 120);

    if (this.hp <= 0) this.die();
  }

  heal(amount: number) {
    if (this._dead || amount <= 0) return;
    const newHP = Math.min(this.maxHP, this.hp + amount);
    if (newHP === this.hp) return;
    this.hp = newHP;

    const pct = this.hp / this.maxHP;
    this.hpBar.scaleX = pct;
    this.hpBar.fillColor = pct > 0.5 ? 0x55ff77 : pct > 0.25 ? 0xffd866 : 0xff5566;

    // hide HP bar again if back to full
    const vis = this.hp < this.maxHP;
    this.hpBar.setVisible(vis);
    this.hpBarBg.setVisible(vis);
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

      // Destroy UI safely
      this.plate?.destroy();
      this.hpBar.destroy();
      this.hpBarBg.destroy();

      this.destroy();
    });
  }
}
