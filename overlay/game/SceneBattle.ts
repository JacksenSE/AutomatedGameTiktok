import Phaser from 'phaser';
import type { Phase, WSOut, WSIn, FighterDTO } from '@shared/types';
import { Fighter } from './Fighter';
import { HUD } from '../ui/HUD';
import { CountdownUI } from '../ui/Countdown';
import { DevUI } from '../ui/DevUI';
import { Projectile } from './Projectile';
import { UNIT_DEFS, UnitKind, UnitDef, Team } from './unitDefs';
import { ObjectPool } from '../core/ObjectPool';
import { SpatialHash } from '../core/SpatialHash';

function cropToAspectOnce(
  scene: Phaser.Scene,
  srcKey: string,
  outKey: string
): string {
  if (scene.textures.exists(outKey)) return outKey;

  const tex = scene.textures.get(srcKey);
  const img = tex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
  const srcW = img.width as number;
  const srcH = img.height as number;

  const vw = scene.scale.gameSize.width;
  const vh = scene.scale.gameSize.height;
  const targetAspect = vw / vh;
  const srcAspect = srcW / srcH;

  let cropW: number, cropH: number, cropX: number, cropY: number;
  if (srcAspect > targetAspect) {
    cropH = srcH;
    cropW = Math.round(cropH * targetAspect);
    cropX = Math.round((srcW - cropW) / 2);
    cropY = 0;
  } else {
    cropW = srcW;
    cropH = Math.round(cropW / targetAspect);
    cropX = 0;
    cropY = Math.round((srcH - cropH) / 2);
  }

  const rt = scene.add.renderTexture(0, 0, cropW, cropH).setVisible(false);
  rt.draw(srcKey, -cropX, -cropY);
  rt.saveTexture(outKey);
  rt.destroy();

  return outKey;
}

export class SceneBattle extends Phaser.Scene {
  // ---- Net / phase ----
  ws!: WebSocket;
  phase: Phase = 'LOBBY';
  private wsUrl: string;
  private wsRetry = 0;
  private wsMaxRetry = 6;
  private wsConnectedOnce = false;

  // ---- Object Pools ----
  private fighterPool!: ObjectPool<Fighter>;
  private projectilePool!: ObjectPool<Projectile>;

  // ---- Spatial Hash ----
  private spatialHash!: SpatialHash<Fighter>;

  // ---- Active entities (pooled) ----
  private activeFighters: Fighter[] = [];
  private activeProjectiles: Projectile[] = [];
  private fighterMap = new Map<string, Fighter>();

  // ---- Fixed timestep ----
  private readonly FIXED_DT = 16.67; // 60 FPS
  private accumulator = 0;
  private readonly MAX_STEPS = 5; // Prevent spiral of death

  // ---- Reusable arrays (zero allocation) ----
  private tempFighters: Fighter[] = [];
  private tempEnemies: Fighter[] = [];
  private tempAllies: Fighter[] = [];
  private tempTargets: Fighter[] = [];

  // ---- UI ----
  hud!: HUD;
  cd!: CountdownUI;
  dev!: DevUI;

  // ---- Waves ----
  private waveNumber = 0;
  private waveActive = false;
  private waveSpawnsRemaining = 0;
  private waveSpawnCdMs = 0;
  private betweenWaveCdMs = 0;

  // Wave tuning
  private BASE_PER_PLAYER = 3;
  private WAVE_BONUS = 2;
  private BURST_SIZE = 4;
  private BURST_INTERVAL_MS = 500;
  private STAT_HP_SCALE = 0.06;
  private STAT_ATK_SCALE = 0.04;
  private STAT_SPD_SCALE = 0.01;

  // Boss tuning
  private BOSS_EVERY = 5;
  private BOSS_HP_MULT = 3.0;
  private BOSS_ATK_MULT = 1.5;
  private BOSS_SPD_MULT = 1.1;

  // Separation
  private MIN_SEP = 26;
  private SEP_ITER = 1;
  private SEP_MAX_NEIGHBORS = 3;

  // Misc
  private elapsedMs = 0;

  // Leaderboards
  private seenDead = new Set<string>();
  private killsToday = new Map<string, number>();
  private lastDailyKey = '';
  private supportersMatch = new Map<string, number>();
  private heartsTotalMatch = 0;
  private nameByUserId = new Map<string, string>();

  constructor() {
    super('battle');
    
    // WebSocket URL
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    this.wsUrl = `${protocol}//${hostname}:8081`;
  }

  preload(): void {
    // Background
    this.load.image('arena_raw', 'assets/bg/arena_raw.png');

    // Load character spritesheets with error handling
    const kinds = Object.keys(UNIT_DEFS) as UnitKind[];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const base = `assets/characters/${kind}/`;
      
      // Only load if assets exist
      const sheets = [
        { key: `${kind}_idle_100`, file: 'Idle.png' },
        { key: `${kind}_walk_100`, file: 'Walk.png' },
        { key: `${kind}_attack_100`, file: 'Attack.png' },
        { key: `${kind}_hurt_100`, file: 'Hurt.png' },
        { key: `${kind}_death_100`, file: 'Death.png' }
      ];
      
      for (let j = 0; j < sheets.length; j++) {
        const sheet = sheets[j];
        this.load.spritesheet(sheet.key, base + sheet.file, { 
          frameWidth: 100, 
          frameHeight: 100 
        });
      }
    }

    this.load.on('loaderror', (file: any) => {
      console.warn('Failed to load asset:', file.key, file.src);
    });
  }

  create(): void {
    // Initialize pools
    this.fighterPool = new ObjectPool(
      () => new Fighter(this),
      (fighter) => fighter.reset(),
      (fighter) => fighter.destroy(),
      100 // Initial pool size
    );

    this.projectilePool = new ObjectPool(
      () => new Projectile(this),
      (projectile) => projectile.reset(),
      (projectile) => projectile.destroy(),
      200 // Initial pool size
    );

    // Initialize spatial hash
    this.spatialHash = new SpatialHash<Fighter>(64);

    // Background
    const makeBg = () => {
      const vw = this.scale.gameSize.width;
      const vh = this.scale.gameSize.height;
      const croppedKey = cropToAspectOnce(this, 'arena_raw', 'arena_cropped');
      
      if ((this as any).__arenaBg) (this as any).__arenaBg.destroy();
      
      const bg = this.add.image(vw / 2, vh / 2, croppedKey)
        .setOrigin(0.5, 0.5)
        .setDisplaySize(vw, vh)
        .setScrollFactor(0)
        .setDepth(-100);
      
      (this as any).__arenaBg = bg;
    };

    makeBg();
    this.scale.on('resize', () => makeBg());

    // UI
    this.hud = new HUD(document.getElementById('hud')!);
    this.cd = new CountdownUI(document.getElementById('hud')!);

    // Initialize daily tracking
    this.resetDaily(this.dailyKeyLA());

    // Create animations
    this.createAnimations();

    // WebSocket
    this.connectWS();

    // Dev bootstrap
    this.time.delayedCall(600, () => {
      if (!this.wsConnectedOnce) {
        this.spawnKind('A', 'soldier', { name: 'You' });
        for (let i = 1; i <= 8; i++) {
          this.spawnKind('A', 'soldier', { name: `You${i}` });
        }
        this.phase = 'BATTLE';
        this.onBattleStart();
      }
    });

    // Dev tools
    this.dev = new DevUI(document.body);
    this.dev.onSpawn = (team, kind, count) => {
      for (let i = 0; i < count; i++) {
        this.spawnKind(team, kind);
      }
    };
    this.dev.onGiftTier = tier => this.simulateGiftTier(tier);
    this.dev.onClear = () => {
      for (let i = 0; i < this.activeFighters.length; i++) {
        const f = this.activeFighters[i];
        if (f.team === 'B') f.die();
      }
    };

    this.hud.setTop('Phase: LOBBY • Fighters: 0');
  }

  private createAnimations(): void {
    const kinds = Object.keys(UNIT_DEFS) as UnitKind[];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const animations = [
        { key: `${kind}_idle`, src: `${kind}_idle_100`, frameRate: 6, repeat: -1 },
        { key: `${kind}_walk`, src: `${kind}_walk_100`, frameRate: 8, repeat: -1 },
        { key: `${kind}_attack`, src: `${kind}_attack_100`, frameRate: 10, repeat: 0 },
        { key: `${kind}_hurt`, src: `${kind}_hurt_100`, frameRate: 14, repeat: 0 },
        { key: `${kind}_death`, src: `${kind}_death_100`, frameRate: 12, repeat: 0 }
      ];
      
      for (let j = 0; j < animations.length; j++) {
        const anim = animations[j];
        if (this.textures.exists(anim.src)) {
          this.anims.create({
            key: anim.key,
            frames: this.anims.generateFrameNumbers(anim.src),
            frameRate: anim.frameRate,
            repeat: anim.repeat
          });
        }
      }
    }
  }

  // WebSocket
  private connectWS(): void {
    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    
    this.ws.onopen = () => {
      this.wsConnectedOnce = true;
      this.wsRetry = 0;
      console.log('[WS] open');
    };
    
    this.ws.onclose = (e) => {
      if (e.code !== 1000) {
        if (this.wsRetry === 0) console.warn('[WS] closed, retrying…', e.code);
        this.scheduleReconnect();
      }
    };
    
    this.ws.onerror = () => {};
    this.ws.onmessage = (ev) => this.handleWS(JSON.parse(ev.data));
  }

  private scheduleReconnect(): void {
    if (this.wsRetry >= this.wsMaxRetry) return;
    const backoff = Math.min(5000, 500 * Math.pow(1.6, this.wsRetry++));
    this.time.delayedCall(backoff, () => this.connectWS());
  }

  handleWS(msg: WSOut): void {
    if (msg.type === 'state') {
      this.phase = msg.payload.phase;
      const fighters = msg.payload.fighters as Array<FighterDTO & { avatarUrl?: string }>;
      for (let i = 0; i < fighters.length; i++) {
        const f = fighters[i];
        this.nameByUserId.set(f.id, f.name);
        this.spawnKind('A', 'soldier', { id: f.id, name: f.name });
      }
      this.updateHud();
      if (this.phase === 'COUNTDOWN') this.runCountdown(3);
      if (this.phase === 'BATTLE') this.onBattleStart();
    }
    if (msg.type === 'phase') {
      this.phase = msg.payload.phase;
      this.updateHud();
      if (this.phase === 'COUNTDOWN') this.runCountdown(3);
      if (this.phase === 'BATTLE') this.onBattleStart();
    }
    if (msg.type === 'joined') {
      const p = { ...msg.payload, team: 'A' as const } as FighterDTO & { avatarUrl?: string };
      this.nameByUserId.set(p.id, p.name);
      this.spawnKind('A', 'soldier', { id: p.id, name: p.name });
      if (this.phase !== 'BATTLE') {
        this.phase = 'BATTLE';
        this.onBattleStart();
      }
    }
    if (msg.type === 'hearts') {
      this.heartsTotalMatch += Math.max(0, Number(msg.payload.count) || 0);
      this.applyHearts(msg.payload.count);
    }
    if (msg.type === 'gift') {
      const giftType = String(msg.payload.giftType || '').toLowerCase();
      const userId: string | undefined = (msg.payload as any).userId;
      const score = giftType.includes('tier4') ? 10
                  : giftType.includes('tier3') ? 6
                  : giftType.includes('tier2') ? 3
                  : giftType.includes('tier1') ? 1 : 1;
      const name = (userId && this.nameByUserId.get(userId)) || (userId ?? 'Anonymous');
      this.supportersMatch.set(name, (this.supportersMatch.get(name) ?? 0) + score);
      this.triggerGift(giftType, userId);
    }
    if (msg.type === 'winner') this.showWinner(msg.payload.id);
  }

  private runCountdown(n: number): void {
    let t = n;
    const tick = () => {
      this.cd.show(t);
      if (t <= 0) {
        this.cd.hide();
        return;
      }
      t--;
      this.time.delayedCall(1000, tick);
    };
    tick();
  }

  // Fixed timestep update
  update(_time: number, delta: number): void {
    if (this.phase !== 'BATTLE') return;

    this.accumulator += delta;
    let steps = 0;

    // Fixed timestep simulation
    while (this.accumulator >= this.FIXED_DT && steps < this.MAX_STEPS) {
      this.fixedUpdate(this.FIXED_DT);
      this.accumulator -= this.FIXED_DT;
      steps++;
    }

    // Clamp accumulator to prevent spiral of death
    if (this.accumulator > this.FIXED_DT * this.MAX_STEPS) {
      this.accumulator = this.FIXED_DT;
    }
  }

  private fixedUpdate(dtMs: number): void {
    this.elapsedMs += dtMs;

    // Daily reset check
    const key = this.dailyKeyLA();
    if (key !== this.lastDailyKey) this.resetDaily(key);

    // Update wave timers
    if (this.waveSpawnCdMs > 0) this.waveSpawnCdMs -= dtMs;
    if (this.betweenWaveCdMs > 0) this.betweenWaveCdMs -= dtMs;

    // Clear temp arrays
    this.tempFighters.length = 0;
    this.tempEnemies.length = 0;
    this.tempAllies.length = 0;
    this.tempTargets.length = 0;

    // Collect active fighters
    for (let i = 0; i < this.activeFighters.length; i++) {
      const f = this.activeFighters[i];
      if (!f.isDead && !f.isPooled) {
        this.tempFighters.push(f);
        if (f.team === 'A') this.tempAllies.push(f);
        else this.tempEnemies.push(f);
      }
    }

    // Update spatial hash
    this.spatialHash.clear();
    for (let i = 0; i < this.tempFighters.length; i++) {
      this.spatialHash.insert(this.tempFighters[i]);
    }

    // Update fighters
    for (let i = 0; i < this.tempFighters.length; i++) {
      this.updateFighter(this.tempFighters[i], dtMs);
    }

    // Separation (optimized)
    this.applySeparation();

    // Update projectiles
    for (let i = 0; i < this.activeProjectiles.length; i++) {
      const p = this.activeProjectiles[i];
      if (p.alive) {
        p.updateFixed(dtMs);
        if (p.alive) {
          this.checkProjectileCollisions(p);
        }
      }
    }

    // Clean up dead projectiles
    this.cleanupProjectiles();

    // Detect new deaths
    this.processDeaths();

    // Wave logic
    this.updateWaves(dtMs);

    // Update HUD
    this.renderStatsUI(this.tempAllies.length, this.tempEnemies.length);
  }

  private updateFighter(fighter: Fighter, dtMs: number): void {
    fighter.updateFixed(dtMs);

    // Skip AI if on cooldown or staggered
    if (fighter.aiCdMs > 0 || fighter.staggerMs > 0) return;
    if (fighter.state === 'dead' || fighter.state === 'windup' || fighter.state === 'recover') return;

    // Reset AI cooldown
    fighter.aiCdMs = 120 + Math.floor(Math.random() * 40 - 20);

    // Find enemies
    const enemies = fighter.team === 'A' ? this.tempEnemies : this.tempAllies;
    if (enemies.length === 0) return;

    // Find nearest target
    let target = enemies[0];
    let bestDistSq = Number.MAX_VALUE;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const dx = e.x - fighter.x;
      const dy = e.y - fighter.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        target = e;
      }
    }

    fighter.target = target;
    fighter.targetId = target.id;
    const dist = Math.sqrt(bestDistSq);

    // Face target
    fighter.facing = (target.x < fighter.x) ? -1 : 1;

    const defn = fighter.defn;
    const minRange = defn.minRange ?? 0;
    const inTooClose = dist < minRange;
    const outOfRange = dist > fighter.range;

    // Movement AI
    if (inTooClose) {
      // Kite away
      const dx = (fighter.x - target.x) / Math.max(1, dist);
      const dy = (fighter.y - target.y) / Math.max(1, dist);
      fighter.vx = dx * fighter.speed * 0.9;
      fighter.vy = dy * fighter.speed * 0.9;
      fighter.enter('chase');
    } else if (outOfRange && defn.role !== 'healer') {
      // Chase
      const dx = (target.x - fighter.x) / Math.max(1, dist);
      const dy = (target.y - fighter.y) / Math.max(1, dist);
      fighter.vx = dx * fighter.speed;
      fighter.vy = dy * fighter.speed;
      fighter.enter('chase');
    } else {
      // In range, slow down
      fighter.vx *= 0.85;
      fighter.vy *= 0.85;
      if (fighter.state !== 'windup' && fighter.state !== 'recover') {
        fighter.enter('idle');
      }

      // Attack logic
      if (fighter.attackCdMs <= 0 && fighter.state === 'idle') {
        this.tryAttack(fighter, target, defn);
      }
    }
  }

  private tryAttack(fighter: Fighter, target: Fighter, defn: UnitDef): void {
    const role = defn.role;
    
    if (role === 'melee') {
      fighter.enter('windup');
      (target as any).__lastHitBy = fighter.id;
      // Damage will be applied when windup completes
      
    } else if (role === 'ranged' || role === 'magic') {
      fighter.enter('windup');
      this.fireProjectile(fighter, target, defn, role === 'ranged' ? 'arrow' : 'magic');
      
    } else if (role === 'healer') {
      // Find wounded ally
      const allies = fighter.team === 'A' ? this.tempAllies : this.tempEnemies;
      let bestAlly: Fighter | undefined;
      let worstPct = 1;
      
      for (let i = 0; i < allies.length; i++) {
        const ally = allies[i];
        if (ally === fighter || ally.isDead) continue;
        const dx = ally.x - fighter.x;
        const dy = ally.y - fighter.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const pct = ally.hp / ally.maxHP;
        if (d <= fighter.range && pct < worstPct) {
          worstPct = pct;
          bestAlly = ally;
        }
      }
      
      if (bestAlly && worstPct < 1) {
        fighter.enter('windup');
        bestAlly.heal(16 + fighter.level * 2);
        // Visual effect
        const ring = this.add.circle(bestAlly.x, bestAlly.y, 20, 0x66ffcc, 0.5).setDepth(4);
        this.tweens.add({
          targets: ring,
          alpha: 0,
          scale: 1.8,
          duration: 380,
          onComplete: () => ring.destroy()
        });
      }
    }

    const baseCd = defn.timings?.attackCooldownMs ?? 900;
    fighter.attackCdMs = baseCd + Math.floor(Math.random() * 400 - 180);
  }

  private applySeparation(): void {
    for (let iter = 0; iter < this.SEP_ITER; iter++) {
      for (let i = 0; i < this.tempFighters.length; i++) {
        const me = this.tempFighters[i];
        const neighbors = this.spatialHash.queryRadius(me.x, me.y, this.MIN_SEP);
        let seen = 0;
        
        for (let j = 0; j < neighbors.length; j++) {
          const other = neighbors[j];
          if (other.id === me.id) continue;
          
          const dx = other.x - me.x;
          const dy = other.y - me.y;
          const distSq = dx * dx + dy * dy;
          
          if (distSq > 0 && distSq < this.MIN_SEP * this.MIN_SEP) {
            const dist = Math.sqrt(distSq);
            const nx = dx / dist;
            const ny = dy / dist;
            const overlap = this.MIN_SEP - dist;
            const push = overlap * 0.5;
            
            me.x -= nx * push;
            me.y -= ny * push;
            other.x += nx * push;
            other.y += ny * push;
            
            me.vx *= 0.95;
            me.vy *= 0.95;
            other.vx *= 0.95;
            other.vy *= 0.95;
            
            if (++seen >= this.SEP_MAX_NEIGHBORS) break;
          }
        }
      }
    }
  }

  private fireProjectile(
    attacker: Fighter,
    target: Fighter,
    defn: UnitDef,
    kind: 'arrow' | 'magic'
  ): void {
    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const nx = dx / dist;
    const ny = dy / dist;

    const pdef = defn.projectile ?? {};
    const speed = pdef.speed ?? (kind === 'arrow' ? 520 : 480);

    const proj = this.projectilePool.acquire();
    proj.init(
      attacker.x + nx * 18,
      attacker.y + ny * 18,
      attacker.team,
      kind,
      nx * speed,
      ny * speed,
      attacker.atk + attacker.level * 2,
      attacker.id,
      pdef.radius ?? (kind === 'magic' ? 14 : 10),
      2500,
      pdef.aoeRadius
    );

    this.activeProjectiles.push(proj);
  }

  private checkProjectileCollisions(projectile: Projectile): void {
    const victims = projectile.team === 'A' ? this.tempEnemies : this.tempAllies;
    
    for (let i = 0; i < victims.length; i++) {
      const victim = victims[i];
      if (victim.isDead) continue;
      
      const dx = victim.x - projectile.x;
      const dy = victim.y - projectile.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist <= (projectile.radius + 14)) {
        // Tag killer before damage
        (victim as any).__lastHitBy = projectile.ownerId;
        
        if (projectile.kind === 'magic' && projectile.aoeRadius) {
          // AOE damage
          const aoeTargets = this.spatialHash.queryRadius(
            projectile.x, 
            projectile.y, 
            projectile.aoeRadius
          );
          
          for (let j = 0; j < aoeTargets.length; j++) {
            const t = aoeTargets[j];
            if (t.team !== projectile.team && !t.isDead) {
              (t as any).__lastHitBy = projectile.ownerId;
              t.takeDamage(projectile.dmg);
            }
          }
        } else {
          victim.takeDamage(projectile.dmg);
        }
        
        // Visual effect
        const flash = this.add.rectangle(projectile.x, projectile.y, 8, 8, 0xffffff, 0.7).setDepth(7);
        this.tweens.add({
          targets: flash,
          alpha: 0,
          scale: 2,
          duration: 200,
          onComplete: () => flash.destroy()
        });
        
        projectile.kill();
        break;
      }
    }
  }

  private cleanupProjectiles(): void {
    for (let i = this.activeProjectiles.length - 1; i >= 0; i--) {
      const p = this.activeProjectiles[i];
      if (!p.alive) {
        this.activeProjectiles.splice(i, 1);
        this.projectilePool.release(p);
      }
    }
  }

  private processDeaths(): void {
    for (let i = 0; i < this.activeFighters.length; i++) {
      const f = this.activeFighters[i];
      if (f.isDead && !this.seenDead.has(f.id)) {
        this.seenDead.add(f.id);
        this.creditKillIfAny(f);
        
        // Schedule cleanup
        const despawnMs = f.defn.timings?.deathDespawnMs?.[0] ?? 1000;
        this.time.delayedCall(despawnMs, () => {
          this.despawnFighter(f.id);
        });
      }
    }
  }

  private updateWaves(dtMs: number): void {
    const playersAlive = this.tempAllies.length > 0;
    const enemiesAlive = this.tempEnemies.length > 0;

    if (this.waveActive) {
      // Spawn enemies in bursts
      if (this.waveSpawnsRemaining > 0 && this.waveSpawnCdMs <= 0) {
        const burst = Math.min(this.BURST_SIZE, this.waveSpawnsRemaining);
        for (let i = 0; i < burst; i++) {
          this.spawnRandomEnemyForWave(this.waveNumber);
        }
        this.waveSpawnsRemaining -= burst;
        this.waveSpawnCdMs = this.BURST_INTERVAL_MS;
      }

      // Check wave completion
      if (!enemiesAlive && this.waveSpawnsRemaining <= 0) {
        this.onWaveCleared();
      }
    } else if (this.betweenWaveCdMs <= 0 && playersAlive) {
      this.startNextWave();
    }
  }

  onBattleStart(): void {
    // Give players initial velocity
    for (let i = 0; i < this.activeFighters.length; i++) {
      const f = this.activeFighters[i];
      const dir = f.team === 'A' ? 1 : -1;
      f.vx = 0.6 * dir;
      f.vy = (Math.random() - 0.5) * 0.3;
      f.enter('chase');
    }

    this.startNextWave();
  }

  private startNextWave(): void {
    if (this.waveActive) return;
    this.waveNumber++;
    this.waveActive = true;
    this.waveSpawnsRemaining = this.computeWaveEnemyCount();
    this.waveSpawnCdMs = 0;

    const isBoss = (this.waveNumber % this.BOSS_EVERY) === 0;
    this.hud.showBanner(isBoss ? `Wave ${this.waveNumber} — BOSS!` : `Wave ${this.waveNumber}`);

    if (isBoss) {
      this.spawnBossForWave(this.waveNumber);
      this.waveSpawnsRemaining = Math.max(0, this.waveSpawnsRemaining - 2);
    }
  }

  private onWaveCleared(): void {
    this.waveActive = false;
    this.hud.showBanner(`Wave ${this.waveNumber} Cleared!`);

    const survivors = this.tempAllies.map(f => f.name);
    const list = survivors.slice(0, 6).join(', ') + (survivors.length > 6 ? '…' : '');
    
    this.time.delayedCall(800, () => {
      if (survivors.length) {
        this.hud.showBanner(`Survivors: ${list}`);
      } else {
        this.hud.showBanner(`All players fell…`);
      }
    });

    this.betweenWaveCdMs = 2200;
  }

  private computeWaveEnemyCount(): number {
    const players = this.tempAllies.length;
    const base = Math.max(1, players) * this.BASE_PER_PLAYER;
    return base + (this.waveNumber - 1) * this.WAVE_BONUS;
  }

  spawnKind(
    team: Team,
    kind: UnitKind,
    opts?: {
      id?: string;
      name?: string;
      level?: number;
      hpScale?: number;
      atkScale?: number;
      speedScale?: number;
    }
  ): void {
    const defn = UNIT_DEFS[kind];
    if (!defn) {
      console.warn('Unknown kind', kind);
      return;
    }
    if (team === 'A' && defn.side === 'enemy') {
      console.warn('Cannot spawn enemy kind on team A');
      return;
    }
    if (team === 'B' && defn.side === 'player') {
      console.warn('Cannot spawn player kind on team B');
      return;
    }

    const baseX = team === 'A' ? 380 : 1540;
    const x = baseX + Math.floor(Math.random() * 120 - 60);
    const y = 520 + Math.floor(Math.random() * 120 - 60);

    const id = opts?.id ?? `${team}_${kind}_${Math.random().toString(36).slice(2, 8)}`;
    const name = opts?.name ?? defn.displayName;

    const fighter = this.fighterPool.acquire();
    fighter.init(x, y, id, name, team, kind, defn);

    if (team === 'A') {
      fighter.setAvatar('assets/dev/pfp.png');
    }

    // Apply scaling for enemies
    if (opts?.level) fighter.level = opts.level;
    if (opts?.hpScale && team === 'B') {
      fighter.maxHP = Math.floor(fighter.maxHP * opts.hpScale);
      fighter.hp = fighter.maxHP;
    }
    if (opts?.atkScale && team === 'B') {
      fighter.atk = Math.max(1, Math.floor(fighter.atk * opts.atkScale));
    }
    if (opts?.speedScale && team === 'B') {
      fighter.speed = fighter.speed * opts.speedScale;
    }

    this.activeFighters.push(fighter);
    this.fighterMap.set(id, fighter);
    this.updateHud();
  }

  private despawnFighter(id: string): void {
    const fighter = this.fighterMap.get(id);
    if (!fighter) return;

    // Remove from active list
    const idx = this.activeFighters.indexOf(fighter);
    if (idx >= 0) {
      this.activeFighters.splice(idx, 1);
    }

    this.fighterMap.delete(id);
    this.fighterPool.release(fighter);
  }

  private spawnRandomEnemyForWave(wave: number): void {
    const pool = this.enemyPoolForWave(wave);
    const kind = pool[Math.floor(Math.random() * pool.length)];
    
    const hpScale = 1 + this.STAT_HP_SCALE * (wave - 1);
    const atkScale = 1 + this.STAT_ATK_SCALE * (wave - 1);
    const speedScale = 1 + this.STAT_SPD_SCALE * (wave - 1);
    const level = 1 + Math.floor((wave - 1) / 2);

    this.spawnKind('B', kind, {
      name: UNIT_DEFS[kind].displayName,
      level,
      hpScale,
      atkScale,
      speedScale,
    });
  }

  private spawnBossForWave(wave: number): void {
    const bosses: UnitKind[] = ['elite_orc', 'orc_rider', 'greatsword_skeleton', 'armored_orc'];
    const kind = bosses[Math.floor(Math.random() * bosses.length)];

    const baseHp = 1 + this.STAT_HP_SCALE * (wave - 1);
    const baseAtk = 1 + this.STAT_ATK_SCALE * (wave - 1);
    const baseSpd = 1 + this.STAT_SPD_SCALE * (wave - 1);

    const hpScale = baseHp * this.BOSS_HP_MULT;
    const atkScale = baseAtk * this.BOSS_ATK_MULT;
    const speedScale = baseSpd * this.BOSS_SPD_MULT;

    this.spawnKind('B', kind, {
      name: `BOSS ${UNIT_DEFS[kind].displayName}`,
      level: 2 + Math.floor(wave / 2),
      hpScale,
      atkScale,
      speedScale,
    });
  }

  private enemyPoolForWave(wave: number): UnitKind[] {
    const allEnemies = (Object.keys(UNIT_DEFS) as UnitKind[])
      .filter(k => UNIT_DEFS[k].side === 'enemy');

    if (allEnemies.length === 0) return ['orc' as UnitKind];

    const scored = allEnemies.map(k => {
      const s = UNIT_DEFS[k].stats;
      const score = s.atk + (s.maxHP * 0.2) + (s.range * 0.02) + (s.speed * 10);
      return { k, score };
    }).sort((a, b) => a.score - b.score);

    const unlocked = Math.min(scored.length, 1 + Math.floor((wave - 1) / 2));
    return scored.slice(0, unlocked).map(o => o.k);
  }

  // Gift/Hearts handling
  applyHearts(count: number): void {
    const heal = Math.min(8, 2 + Math.floor(count / 30));
    for (let i = 0; i < this.activeFighters.length; i++) {
      const f = this.activeFighters[i];
      if (f.team === 'A' && !f.isDead) {
        f.heal(heal);
        f.vx += (Math.random() - 0.5) * 0.4;
        f.vy += (Math.random() - 0.5) * 0.4;
      }
    }
  }

  triggerGift(type: string, _userId?: string): void {
    const t = (type || '').toLowerCase();
    if (t.includes('tier1')) this.simulateGiftTier(1);
    else if (t.includes('tier2')) this.simulateGiftTier(2);
    else if (t.includes('tier3')) this.simulateGiftTier(3);
    else if (t.includes('tier4')) this.simulateGiftTier(4);
  }

  private simulateGiftTier(tier: number): void {
    const tierMap: Record<number, UnitKind[]> = {
      1: ['soldier', 'swordsman', 'archer'],
      2: ['knight', 'lancer', 'armored_axeman'],
      3: ['wizard', 'priest', 'knight_templar'],
      4: ['werewolf', 'werebear', 'knight_templar'],
    };
    const list = tierMap[tier] ?? ['soldier'];
    const kind = list[Math.floor(Math.random() * list.length)];
    this.spawnKind('A', kind, { name: UNIT_DEFS[kind].displayName });
    this.hud.showBanner(`Gift Tier ${tier}: ${UNIT_DEFS[kind].displayName}!`);
  }

  // Kill tracking
  private creditKillIfAny(victim: Fighter): void {
    const killerId: string | undefined = (victim as any).__lastHitBy;
    if (!killerId) return;
    const killer = this.fighterMap.get(killerId);
    if (!killer || killer.team !== 'A') return;

    const name = killer.name || killerId;
    this.killsToday.set(name, (this.killsToday.get(name) ?? 0) + 1);
    (killer as any).__kills = ((killer as any).__kills ?? 0) + 1;
  }

  private dailyKeyLA(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  }

  private resetDaily(key: string): void {
    this.lastDailyKey = key;
    this.killsToday.clear();
  }

  private renderStatsUI(players: number, enemies: number): void {
    const left: string[] = [
      `Wave ${Math.max(1, this.waveNumber)}`,
      `Players: ${players}`,
      `Enemies: ${enemies}`,
      `Hearts: ${this.heartsTotalMatch}`,
      `FPS: ${Math.round(this.game.loop.actualFps)}`,
      `Objects: ${this.activeFighters.length + this.activeProjectiles.length}`,
    ];

    const topSlayers = [...this.killsToday.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const slayerLines = topSlayers.map(([n, k], i) => `${i + 1}. ${this.trimName(n, 12)} ${k}`);

    const topSupporters = [...this.supportersMatch.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const supporterLines = topSupporters.map(([n, s], i) => `${i + 1}. ${this.trimName(n, 12)} ${s}`);

    this.hud.setStats([
      ...left,
      '— Slayers (Today) —',
      ...(slayerLines.length ? slayerLines : ['(no kills yet)']),
      '— Supporters (Match) —',
      ...(supporterLines.length ? supporterLines : ['(awaiting gifts)']),
    ]);
  }

  private trimName(n: string, max: number): string {
    return n.length <= max ? n : n.slice(0, max - 1) + '…';
  }

  // Winner handling
  declareWinner(id: string): void {
    const msg: WSIn = { type: 'winner', payload: { id } } as any;
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  showWinner(id: string): void {
    const f = this.fighterMap.get(id);
    if (!f) return;
    this.hud.showBanner(`Winner: ${f.name} (Team ${f.team})`);
  }

  updateHud(): void {
    const players = this.tempAllies.length;
    const enemies = this.tempEnemies.length;
    this.hud.setTop(`Phase: ${this.phase} • Wave ${Math.max(1, this.waveNumber)} • Players ${players} • Enemies ${enemies}`);
  }
}