import Phaser from 'phaser';
import type { Team, UnitKind, UnitDef } from './unitDefs';

export type FighterState =
  | 'idle'
  | 'chase'
  | 'windup'
  | 'recover'
  | 'block'
  | 'dead';

export class Fighter extends Phaser.GameObjects.Sprite {
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

  // Position and velocity (manual physics)
  vx = 0;
  vy = 0;
  
  // ---- UI (baked) ----
  private plate?: Phaser.GameObjects.Image;
  private hpBarBg?: Phaser.GameObjects.Rectangle;
  private hpBar?: Phaser.GameObjects.Rectangle;

  // ---- Runtime ----
  state: FighterState = 'idle';
  target?: Fighter;
  targetId?: string; // for pooled lookup

  facing: 1 | -1 = 1;

  // Counters (no timers, no GC)
  attackCdMs = 0;
  windupMs = 0;
  recoverMs = 0;
  staggerMs = 0;
  aiCdMs = 0;
  blockCdMs = 0;

  // Block
  canBlock = false;
  blockReductionPct = 0.7;
  blockDurationMs = 260;

  // Internal
  private _dead = false;
  private _pooled = false;

  // UI update throttling
  private _uiLastX = Number.NaN;
  private _uiLastY = Number.NaN;
  private _lastHpPct = 1;
  private _uiUpdateMs = 0;

  // Avatar
  private pfpUrl?: string;
  private pfpKey?: string;

  // Layout constants
  private static readonly NAME_Y = -34;
  private static readonly ROLE_Y = -22;
  private static readonly HP_Y = -14;
  private static readonly AVATAR = { size: 18, gap: 3 };
  private static readonly COLORS = {
    frame: 0xc9aa71,
    nameFill: 0x000000,
    roleFill: 0x000000,
    nameAlpha: 0.55,
    roleAlpha: 0.45,
    enemyFill: 0x000000,
    enemyAlpha: 0.35,
  };

  private static enemyPlateCache = new Map<string, string>();

  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0, '');
    scene.add.existing(this);
    
    this.id = '';
    this.name = '';
    this.team = 'A';
    this.kind = 'soldier';
    this.defn = {} as UnitDef;
    
    this.setDepth(5);
    this.setScale(1.6);
  }

  // Pool-friendly initialization
  init(
    x: number,
    y: number,
    id: string,
    name: string,
    team: Team,
    kind: UnitKind,
    defn: UnitDef
  ): void {
    this.setPosition(x, y);
    this.id = id;
    this.name = name;
    this.team = team;
    this.kind = kind;
    this.defn = defn;

    // Reset all state
    this.state = 'idle';
    this.target = undefined;
    this.targetId = undefined;
    this.facing = 1;
    this.vx = 0;
    this.vy = 0;
    this._dead = false;
    this._pooled = false;

    // Copy stats
    this.maxHP = defn.stats.maxHP;
    this.hp = defn.stats.maxHP;
    this.atk = defn.stats.atk;
    this.def = defn.stats.def;
    this.range = defn.stats.range;
    this.speed = defn.stats.speed;

    // Reset counters
    this.attackCdMs = 0;
    this.windupMs = 0;
    this.recoverMs = 0;
    this.staggerMs = 0;
    this.blockCdMs = 0;
    this.aiCdMs = 80 + Math.floor(Math.random() * 80);

    // Reset UI tracking
    this._uiLastX = Number.NaN;
    this._uiLastY = Number.NaN;
    this._lastHpPct = 1;
    this._uiUpdateMs = 0;

    // Set texture
    const baseKey = `${kind}_idle_100`;
    if (this.scene.textures.exists(baseKey)) {
      this.setTexture(baseKey);
      this.setAnimIdle();
    } else {
      // Fallback texture
      const fallbackKey = `fallback_${kind}`;
      if (!this.scene.textures.exists(fallbackKey)) {
        const g = this.scene.add.graphics();
        g.fillStyle(team === 'A' ? 0x4dd2ff : 0xff6a6a, 1);
        g.fillCircle(16, 16, 14);
        g.generateTexture(fallbackKey, 32, 32);
        g.destroy();
      }
      this.setTexture(fallbackKey);
    }

    // Create UI
    this.createUI();
    
    this.setActive(true).setVisible(true);
  }

  // Pool-friendly reset
  reset(): void {
    this._pooled = true;
    this.setActive(false).setVisible(false);
    
    // Destroy UI
    if (this.plate) {
      this.plate.destroy();
      this.plate = undefined;
    }
    if (this.hpBarBg) {
      this.hpBarBg.destroy();
      this.hpBarBg = undefined;
    }
    if (this.hpBar) {
      this.hpBar.destroy();
      this.hpBar = undefined;
    }
  }

  private createUI(): void {
    if (this.team === 'A') {
      this.buildPlayerPlate();
    } else {
      const key = Fighter.getOrCreateEnemyPlate(this.scene, this.defn.displayName);
      this.plate = this.scene.add.image(this.x, this.y + Fighter.NAME_Y, key)
        .setDepth(10)
        .setOrigin(0.5);
    }

    // HP bars
    this.hpBarBg = this.scene.add.rectangle(this.x, this.y + Fighter.HP_Y, 30, 3, 0x222222, 0.9)
      .setOrigin(0.5)
      .setDepth(9)
      .setVisible(false);
    this.hpBar = this.scene.add.rectangle(this.x - 15, this.y + Fighter.HP_Y, 30, 3, 0x55ff77, 1)
      .setOrigin(0, 0.5)
      .setDepth(9)
      .setVisible(false);
  }

  private buildPlayerPlate(): void {
    const scene = this.scene;
    const name = this.name || 'Player';
    const role = this.defn.displayName;

    const tName = scene.add.text(-10000, -10000, name, {
      fontSize: '10px', fontStyle: 'bold', color: '#ffffff'
    });
    const tRole = scene.add.text(-10000, -10000, role, {
      fontSize: '9px', color: '#dddddd'
    });

    const nameW = Math.max(40, Math.ceil(tName.width) + 8);
    const roleW = Math.max(36, Math.ceil(tRole.width) + 8);
    const textBlockW = Math.max(nameW, roleW);
    const A = Fighter.AVATAR;
    const leftW = A.size + A.gap;
    const totalW = leftW + textBlockW;
    const totalH = 12 + 10 + 4;

    const rt = scene.add.renderTexture(-9999, -9999, totalW + 2, totalH + 2).setVisible(false);

    const g = scene.add.graphics();
    g.lineStyle(1, Fighter.COLORS.frame);
    g.fillStyle(Fighter.COLORS.nameFill, Fighter.COLORS.nameAlpha)
      .fillRoundedRect(leftW + 0.5, 0.5, nameW, 12, 2);
    g.strokeRoundedRect(leftW + 0.5, 0.5, nameW, 12, 2);
    g.fillStyle(Fighter.COLORS.roleFill, Fighter.COLORS.roleAlpha)
      .fillRoundedRect(leftW + 0.5, 13.5, roleW, 10, 2);
    g.strokeRoundedRect(leftW + 0.5, 13.5, roleW, 10, 2);
    g.lineStyle(1, Fighter.COLORS.frame)
      .strokeCircle(A.size / 2 + 0.5, A.size / 2 + 0.5, A.size / 2);

    rt.draw(g, 0, 0);
    g.destroy();

    // Avatar or initials
    const pfpKey = this.pfpKey && scene.textures.exists(this.pfpKey) ? this.pfpKey : undefined;
    if (pfpKey) {
      Fighter.ensureMaskTexture(scene, A.size);
      const img = scene.add.image(A.size / 2 + 0.5, A.size / 2 + 0.5, pfpKey)
        .setDisplaySize(A.size, A.size)
        .setOrigin(0.5);
      const maskSprite = scene.add.image(img.x, img.y, `ui_mask_${A.size}`).setVisible(false);
      const mask = new Phaser.Display.Masks.BitmapMask(scene, maskSprite);
      img.setMask(mask);
      rt.draw(img);
      img.destroy();
      maskSprite.destroy();
    } else {
      const initials = (this.name || '?')
        .split(' ')
        .map(s => s[0]).join('').slice(0, 2).toUpperCase();
      const gi = scene.add.graphics();
      gi.fillStyle(0x2b2b2b, 1).fillCircle(A.size / 2 + 0.5, A.size / 2 + 0.5, A.size / 2);
      rt.draw(gi);
      gi.destroy();
      const ti = scene.add.text(A.size / 2 + 0.5, A.size / 2 + 0.5, initials, {
        fontSize: '9px', color: '#ffffff'
      }).setOrigin(0.5);
      rt.draw(ti);
      ti.destroy();
    }

    tName.setPosition(leftW + nameW / 2 + 0.5, 6.5).setOrigin(0.5);
    tRole.setPosition(leftW + roleW / 2 + 0.5, 18.5).setOrigin(0.5);
    rt.draw(tName);
    rt.draw(tRole);
    tName.destroy();
    tRole.destroy();

    const texKey = `plate_p_${this.id}`;
    if (scene.textures.exists(texKey)) scene.textures.remove(texKey);
    rt.saveTexture(texKey);
    rt.destroy();

    this.plate = scene.add.image(this.x, this.y + Fighter.NAME_Y, texKey)
      .setDepth(10)
      .setOrigin(0.5);
  }

  private static getOrCreateEnemyPlate(scene: Phaser.Scene, text: string): string {
    let got = Fighter.enemyPlateCache.get(text);
    if (got) return got;

    const t = scene.add.text(-10000, -10000, text, { fontSize: '10px', color: '#dddddd' });
    const w = Math.max(34, Math.ceil(t.width) + 8);
    const h = 12;
    const rt = scene.add.renderTexture(-9999, -9999, w + 2, h + 2).setVisible(false);

    const g = scene.add.graphics();
    g.lineStyle(1, Fighter.COLORS.frame);
    g.fillStyle(Fighter.COLORS.enemyFill, Fighter.COLORS.enemyAlpha)
      .fillRoundedRect(0.5, 0.5, w, h, 2);
    g.strokeRoundedRect(0.5, 0.5, w, h, 2);

    rt.draw(g, 0, 0);
    g.destroy();

    t.setPosition(w / 2 + 0.5, h / 2 + 0.5).setOrigin(0.5);
    rt.draw(t);
    t.destroy();

    const key = `plate_e_${text}`;
    rt.saveTexture(key);
    rt.destroy();
    Fighter.enemyPlateCache.set(text, key);
    return key;
  }

  private static ensureMaskTexture(scene: Phaser.Scene, size: number): void {
    const key = `ui_mask_${size}`;
    if (scene.textures.exists(key)) return;
    const g = scene.add.graphics();
    g.fillStyle(0xffffff, 1).fillCircle(size / 2, size / 2, size / 2);
    g.generateTexture(key, size, size);
    g.destroy();
  }

  setAvatar(url: string): void {
    this.pfpUrl = url;
    this.pfpKey = `pfp_${this.id}`;
    if (this.scene.textures.exists(this.pfpKey)) {
      this.buildPlayerPlate();
      return;
    }
    
    const loader = this.scene.load;
    const onComplete = (fileKey: string) => {
      if (fileKey === this.pfpKey) this.buildPlayerPlate();
    };
    const onError = (file: any) => {
      if (file && file.key === this.pfpKey) {
        console.warn(`[pfp] failed for ${this.name} -> ${url}`);
        this.buildPlayerPlate();
      }
    };
    loader.once(Phaser.Loader.Events.FILE_COMPLETE, onComplete);
    loader.once(Phaser.Loader.Events.FILE_LOAD_ERROR, onError);
    loader.image(this.pfpKey, url, { crossOrigin: 'anonymous' } as any);
    loader.start();
  }

  // Animation helpers
  private safePlay(key: string): void {
    if (!this.scene?.anims?.exists(key)) return;
    this.anims.play(key, true);
  }

  setAnimIdle(): void { this.safePlay(`${this.kind}_idle`); }
  setAnimRun(): void {
    const runKey = `${this.kind}_run`;
    const walkKey = `${this.kind}_walk`;
    if (this.scene.anims.exists(runKey)) this.safePlay(runKey);
    else this.safePlay(walkKey);
  }
  setAnimAttack(): void {
    const choices = [`${this.kind}_attack2`, `${this.kind}_attack3`, `${this.kind}_attack`]
      .filter(k => this.scene.anims.exists(k));
    if (choices.length) this.safePlay(choices[Math.floor(Math.random() * choices.length)]);
    else this.safePlay(`${this.kind}_attack`);
  }
  setAnimHurt(): void { this.safePlay(`${this.kind}_hurt`); }
  setAnimBlock(): void { this.safePlay(`${this.kind}_block`); }
  setAnimDeath(): void { this.safePlay(`${this.kind}_death`); }

  // Fixed timestep update
  updateFixed(dtMs: number): void {
    if (this._pooled || this._dead) return;

    // Update counters
    if (this.attackCdMs > 0) this.attackCdMs -= dtMs;
    if (this.windupMs > 0) this.windupMs -= dtMs;
    if (this.recoverMs > 0) this.recoverMs -= dtMs;
    if (this.staggerMs > 0) this.staggerMs -= dtMs;
    if (this.aiCdMs > 0) this.aiCdMs -= dtMs;
    if (this.blockCdMs > 0) this.blockCdMs -= dtMs;
    this._uiUpdateMs += dtMs;

    // State transitions
    if (this.windupMs <= 0 && this.state === 'windup') {
      this.state = 'recover';
      this.recoverMs = this.defn.timings?.recoverMs ?? 180;
    }
    if (this.recoverMs <= 0 && this.state === 'recover') {
      this.state = 'idle';
    }
    if (this.blockCdMs <= 0 && this.state === 'block') {
      this.state = 'idle';
    }

    // Apply velocity with damping
    this.vx *= 0.92;
    this.vy *= 0.92;
    this.x += this.vx * (dtMs / 16.67);
    this.y += this.vy * (dtMs / 16.67);

    // Face target
    if (this.target) {
      this.facing = (this.target.x < this.x) ? -1 : 1;
    }
    this.setFlipX(this.facing < 0);

    // Throttled UI updates (every ~100ms)
    if (this._uiUpdateMs >= 100) {
      this.updateUI();
      this._uiUpdateMs = 0;
    }
  }

  private updateUI(): void {
    // Position UI elements
    if (this.x !== this._uiLastX || this.y !== this._uiLastY) {
      const x = this.x, y = this.y;
      if (this.plate) {
        this.plate.setPosition(x, y + Fighter.NAME_Y);
      }
      if (this.hpBarBg) {
        this.hpBarBg.setPosition(x, y + Fighter.HP_Y);
      }
      if (this.hpBar) {
        this.hpBar.setPosition(x - 15, y + Fighter.HP_Y);
      }
      this._uiLastX = x;
      this._uiLastY = y;
    }

    // HP bar updates
    const pct = this.hp / this.maxHP;
    if (Math.abs(pct - this._lastHpPct) > 0.01) {
      if (this.hpBar) {
        this.hpBar.scaleX = pct;
        this.hpBar.fillColor = pct > 0.5 ? 0x55ff77 : pct > 0.25 ? 0xffd866 : 0xff5566;
      }
      
      const vis = this.hp < this.maxHP;
      if (this.hpBar) this.hpBar.setVisible(vis);
      if (this.hpBarBg) this.hpBarBg.setVisible(vis);
      
      this._lastHpPct = pct;
    }
  }

  enter(state: FighterState): void {
    if (this._dead) return;
    this.state = state;
    
    switch (state) {
      case 'idle': this.setAnimIdle(); break;
      case 'chase': this.setAnimRun(); break;
      case 'windup': 
        this.setAnimAttack();
        this.windupMs = this.defn.timings?.windupMs ?? 220;
        break;
      case 'block': 
        this.setAnimBlock();
        this.blockCdMs = this.blockDurationMs;
        break;
    }
  }

  tryBeginBlock(): boolean {
    if (!this.canBlock || this.blockCdMs > 0 || this.state === 'block') return false;
    this.enter('block');
    return true;
  }

  takeDamage(dmg: number): void {
    if (this._dead) return;

    // Reactive block
    if (this.canBlock && this.blockCdMs <= 0 && Math.random() < 0.28) {
      if (this.tryBeginBlock()) {
        dmg = Math.floor(dmg * (1 - this.blockReductionPct));
      }
    }

    const real = Math.max(1, Math.floor(dmg - this.def));
    const newHP = Math.max(0, this.hp - real);
    if (newHP === this.hp) return;
    
    this.hp = newHP;
    this.setAnimHurt();
    this.staggerMs = Math.max(this.staggerMs, 120);

    if (this.hp <= 0) {
      this.die();
    }
  }

  heal(amount: number): void {
    if (this._dead || amount <= 0) return;
    const newHP = Math.min(this.maxHP, this.hp + amount);
    if (newHP === this.hp) return;
    this.hp = newHP;
  }

  die(): void {
    if (this._dead) return;
    this._dead = true;
    this.state = 'dead';
    this.setAnimDeath();
  }

  get isDead(): boolean {
    return this._dead;
  }

  get isPooled(): boolean {
    return this._pooled;
  }
}