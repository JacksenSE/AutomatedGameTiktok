import Phaser from 'phaser';
import type { Phase, WSOut, WSIn, FighterDTO } from '@shared/types';
import { Fighter } from './Fighter';
import { HUD } from '../ui/HUD';
import { CountdownUI } from '../ui/Countdown';
import { DevUI } from '../ui/DevUI';
import { Projectile } from './Projectile';
import { UNIT_DEFS, UnitKind, UnitDef, Team } from './unitDefs';

export class SceneBattle extends Phaser.Scene {
  // ---- Net / phase ----
  ws!: WebSocket;
  phase: Phase = 'LOBBY';
  private wsUrl = 'ws://localhost:8081';
  private wsRetry = 0;
  private wsMaxRetry = 6;
  private wsConnectedOnce = false;

  // ---- Entities ----
  fighters = new Map<string, Fighter>();
  projectiles: Projectile[] = [];

  // ---- UI ----
  hud!: HUD;
  cd!: CountdownUI;
  dev!: DevUI;

  // ---- Waves ----
  private waveNumber = 0;
  private waveActive = false;
  private waveSpawnsRemaining = 0;
  private waveSpawnTimer?: Phaser.Time.TimerEvent;
  private betweenWaveTimer?: Phaser.Time.TimerEvent;

  // knobs
  private BASE_PER_PLAYER = 3;     // enemies per player baseline
  private WAVE_BONUS = 2;          // flat added enemies per wave
  private BURST_SIZE = 4;          // spawn in small bursts
  private BURST_INTERVAL_MS = 500; // time between bursts
  private STAT_HP_SCALE = 0.06;    // +6% maxHP per wave
  private STAT_ATK_SCALE = 0.04;   // +4% attack per wave
  private STAT_SPD_SCALE = 0.01;   // +1% speed per wave (tiny)

  // ---- Boss tuning ----
  private BOSS_EVERY = 5;
  private BOSS_HP_MULT = 3.0;   // base * this, plus normal wave scaling
  private BOSS_ATK_MULT = 1.5;
  private BOSS_SPD_MULT = 1.1;

  // ---- Separation (simple, stable) ----
  private MIN_SEP = 26;
  private SEP_ITER = 2;
  private SEP_MAX_NEIGHBORS = 6;

  // ---- Misc ----
  private elapsedMs = 0;

  // ---- Leaderboards / Supporters ----
  /** track new deaths so we can credit killers exactly once */
  private seenDead = new Set<string>();
  /** daily (Los Angeles time) slayer board: name -> kills */
  private killsToday = new Map<string, number>();
  private lastDailyKey = '';
  /** per-match supporters (only gifts we can attribute from current WS schema) */
  private supportersMatch = new Map<string, number>(); // displayName -> score
  private heartsTotalMatch = 0;
  /** remember userId -> displayName where available (from 'state'/'joined') */
  private nameByUserId = new Map<string, string>();

  constructor(){ super('battle'); }

  // ------------------- PRELOAD -------------------
  preload(){
    // Background (optional)
    this.load.image('bg_grass', '/assets/bg/grass.png');

    // Required per unit: Idle, Walk, Attack, Hurt, Death (100x100).
    const kinds = Object.keys(UNIT_DEFS) as UnitKind[];
    kinds.forEach(kind=>{
      const base = `assets/characters/${kind}/`;
      const sheet = (key:string, file:string)=> this.load.spritesheet(key, base + file, { frameWidth: 100, frameHeight: 100 });

      sheet(`${kind}_idle_100`,   'Idle.png');
      sheet(`${kind}_walk_100`,   'Walk.png');   // you renamed Run -> Walk
      sheet(`${kind}_attack_100`, 'Attack.png');
      sheet(`${kind}_hurt_100`,   'Hurt.png');
      sheet(`${kind}_death_100`,  'Death.png');
    });

    this.load.on('loaderror', () => {/* swallow optional errors if any appear */});
  }

  // ------------------- CREATE -------------------
  create(){
    // Background / camera
    if (this.textures.exists('bg_grass')) {
      const vw = this.scale.gameSize.width, vh = this.scale.gameSize.height;
      this.textures.get('bg_grass').setFilter(Phaser.Textures.FilterMode.NEAREST);
      const ground = this.add.tileSprite(vw/2, vh/2, vw, vh, 'bg_grass').setDepth(-100);
      this.scale.on('resize', (s: Phaser.Structs.Size) => ground.setSize(s.width, s.height).setPosition(s.width/2, s.height/2));
    } else {
      this.cameras.main.setBackgroundColor('#0c0e13');
    }

    // HUD + Countdown
    this.hud = new HUD(document.getElementById('hud')!);
    this.cd  = new CountdownUI(document.getElementById('hud')!);

    // init daily key
    this.resetDaily(this.dailyKeyLA());

    // Anim keys
    const kinds = Object.keys(UNIT_DEFS) as UnitKind[];
    kinds.forEach(kind=>{
      const mk = (short:string, src:string, fr:number, rep:number)=> {
        if (this.textures.exists(`${kind}_${src}_100`)) {
          this.anims.create({
            key: `${kind}_${short}`,
            frames: this.anims.generateFrameNumbers(`${kind}_${src}_100`),
            frameRate: fr, repeat: rep
          });
        }
      };
      mk('idle',   'idle',   6,  -1);
      mk('walk',   'walk',   8,  -1);
      mk('attack', 'attack', 10,  0);
      mk('hurt',   'hurt',   14,  0);
      mk('death',  'death',  12,  0);
    });

    // WS
    this.connectWS();

    // Dev bootstrap if no WS connects
    this.time.delayedCall(600, () => {
      if (!this.wsConnectedOnce) {
        this.spawnKind('A', 'soldier', { name: 'You' });
        for (let i=1;i<=8;i++) this.spawnKind('A','soldier',{ name: `You${i}`});
        this.phase = 'BATTLE';
        this.onBattleStart();
      }
    });

    // Dev tools overlay
    this.dev = new DevUI(document.body);
    this.dev.onSpawn = (team, kind, count) => { for (let i=0;i<count;i++) this.spawnKind(team, kind); };
    this.dev.onGiftTier = tier => this.simulateGiftTier(tier);
    this.dev.onClear = () => { [...this.fighters.values()].forEach(f=>{ if (f.team==='B') f.die(); }); };

    this.hud.setTop('Phase: LOBBY • Fighters: 0');
  }

  // ------------------- WS -------------------
  private connectWS(){
    try { this.ws = new WebSocket(this.wsUrl); } catch { this.scheduleReconnect(); return; }
    this.ws.onopen = () => { this.wsConnectedOnce = true; this.wsRetry = 0; console.log('[WS] open'); };
    this.ws.onclose = (e) => { if (e.code !== 1000) { if (this.wsRetry === 0) console.warn('[WS] closed, retrying…', e.code); this.scheduleReconnect(); } };
    this.ws.onerror = () => {};
    this.ws.onmessage = (ev) => this.handleWS(JSON.parse(ev.data));
  }
  private scheduleReconnect(){
    if (this.wsRetry >= this.wsMaxRetry) return;
    const backoff = Math.min(5000, 500 * Math.pow(1.6, this.wsRetry++));
    this.time.delayedCall(backoff, () => this.connectWS());
  }
  handleWS(msg: WSOut){
    if (msg.type === 'state'){
      this.phase = msg.payload.phase;
      (msg.payload.fighters as Array<FighterDTO & { avatarUrl?: string }>).forEach(f => {
        this.nameByUserId.set(f.id, f.name);
        this.spawnKind('A', 'soldier', { id:f.id, name:f.name });
      });
      this.updateHud();
      if (this.phase === 'COUNTDOWN') this.runCountdown(3);
      if (this.phase === 'BATTLE') this.onBattleStart();
    }
    if (msg.type === 'phase'){
      this.phase = msg.payload.phase; this.updateHud();
      if (this.phase === 'COUNTDOWN') this.runCountdown(3);
      if (this.phase === 'BATTLE') this.onBattleStart();
    }
    if (msg.type === 'joined'){
      const p = { ...msg.payload, team: 'A' as const } as FighterDTO & { avatarUrl?: string };
      this.nameByUserId.set(p.id, p.name);
      this.spawnKind('A', 'soldier', { id:p.id, name:p.name });
      if (this.phase !== 'BATTLE') { this.phase = 'BATTLE'; this.onBattleStart(); }
    }
    if (msg.type === 'hearts') {
      // We don't have per-user heart attribution in this schema, so just count total.
      this.heartsTotalMatch += Math.max(0, Number(msg.payload.count) || 0);
      this.applyHearts(msg.payload.count);
    }
    if (msg.type === 'gift') {
      const giftType = String(msg.payload.giftType || '').toLowerCase();
      const userId: string | undefined = (msg.payload as any).userId;
      // score gifts by tier to rank supporters
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
  private runCountdown(n: number){
    let t = n; const tick = () => { this.cd.show(t); if (t <= 0) { this.cd.hide(); return; } t--; this.time.delayedCall(1000, tick); }; tick();
  }

  // ------------------- UPDATE -------------------
  update(_time:number, dt:number){
    if (this.phase !== 'BATTLE') return;

    this.elapsedMs += dt;

    // daily reset check (America/Los_Angeles)
    const key = this.dailyKeyLA();
    if (key !== this.lastDailyKey) this.resetDaily(key);

    // prune dead projectiles
    this.projectiles = this.projectiles.filter(p => p.alive);

    const list = [...this.fighters.values()].filter(f => f.body && f.state !== 'dead');
    const teamA = list.filter(f=>f.team==='A');
    const teamB = list.filter(f=>f.team==='B');

    // Hard separation
    for (let iter = 0; iter < this.SEP_ITER; iter++) {
      for (let i = 0; i < list.length; i++) {
        const me = list[i];
        let seen = 0;
        for (let j = i + 1; j < list.length; j++) {
          const o = list[j];
          const dx = o.x - me.x;
          const dy = o.y - me.y;
          const d2 = dx*dx + dy*dy;
          if (d2 === 0) continue;
          if (d2 < this.MIN_SEP * this.MIN_SEP) {
            const d = Math.sqrt(d2);
            const nx = dx / d, ny = dy / d;
            const overlap = this.MIN_SEP - d;
            const push = overlap * 0.5;
            me.setPosition(me.x - nx * push, me.y - ny * push);
            o.setPosition (o.x + nx * push,  o.y + ny * push);
            const mvx = ((me.body as any).velocity?.x) ?? 0;
            const mvy = ((me.body as any).velocity?.y) ?? 0;
            const ovx = ((o.body as any).velocity?.x) ?? 0;
            const ovy = ((o.body as any).velocity?.y) ?? 0;
            me.setVelocity(mvx * 0.95, mvy * 0.95);
            o.setVelocity (ovx * 0.95, ovy * 0.95);
            if (++seen >= this.SEP_MAX_NEIGHBORS) break;
          }
        }
      }
    }

    // --- decision / movement / attacks ---
    list.forEach(me=>{
      const enemiesAll = me.team==='A' ? teamB : teamA;
      const friendsAll = me.team==='A' ? teamA : teamB;
      const enemies = enemiesAll.filter(e => e.body && e.state!=='dead');
      if (!enemies.length) return;

      // target selection (nearest)
      let target = enemies[0]; let best = Number.MAX_VALUE;
      for (const e of enemies){
        const d = Phaser.Math.Distance.Squared(me.x, me.y, e.x, e.y);
        if (d < best){ best = d; target = e; }
      }
      me.target = target;
      const dist = Math.sqrt(best);

      // face
      me.facing = (target.x < me.x) ? -1 : 1;
      me.setFlipX(me.facing < 0).setFlipY(false);

      // stagger pause
      if (me.staggerMs > 0) {
        const bvx = ((me.body as any).velocity?.x) ?? 0;
        const bvy = ((me.body as any).velocity?.y) ?? 0;
        me.setVelocity(bvx * 0.9, bvy * 0.9);
        if (me.state !== 'windup' && me.state !== 'recover') me.setAnimIdle();
        return;
      }
      if (me.state === 'dead') return;

      const defn: UnitDef = (UNIT_DEFS as any)[me.kind];
      const minRange = defn.minRange ?? 0; // OPTIONAL: default 0 for melee
      const inTooClose = dist < minRange;
      const outOfRange = dist > me.range;

      // Movement behavior (kite for ranged/magic/healer via minRange)
      if (inTooClose) {
        const dx = (me.x - target.x) / Math.max(1, dist);
        const dy = (me.y - target.y) / Math.max(1, dist);
        const desiredVx = dx * Math.max(me.speed * 0.9, 0.6);
        const desiredVy = dy * Math.max(me.speed * 0.9, 0.6);
        const bvx = ((me.body as any).velocity?.x) ?? 0;
        const bvy = ((me.body as any).velocity?.y) ?? 0;
        const lerp = Math.min(1, dt / 160);
        me.setVelocity(Phaser.Math.Linear(bvx, desiredVx, lerp), Phaser.Math.Linear(bvy, desiredVy, lerp));
        me.enter('chase');

      } else if (outOfRange && defn.role !== 'healer') {
        const dx = (target.x - me.x) / Math.max(1, dist);
        const dy = (target.y - me.y) / Math.max(1, dist);
        const desiredVx = dx * me.speed;
        const desiredVy = dy * me.speed;
        const bvx = ((me.body as any).velocity?.x) ?? 0;
        const bvy = ((me.body as any).velocity?.y) ?? 0;
        const lerp = Math.min(1, dt / 180);
        const newVx = Phaser.Math.Linear(bvx, desiredVx, lerp);
        const newVy = Phaser.Math.Linear(bvy, desiredVy, lerp);
        me.setVelocity(newVx, newVy);
        const speedNow = Math.hypot(newVx, newVy);
        if (speedNow > 0.05) me.setAnimRun(); else me.setAnimIdle();

      } else {
        const bvx = ((me.body as any).velocity?.x) ?? 0;
        const bvy = ((me.body as any).velocity?.y) ?? 0;
        me.setVelocity(bvx * 0.85, bvy * 0.85);
        if (me.state !== 'windup' && me.state !== 'recover') me.enter('idle');

        if (me.attackCd <= 0 && me.state !== 'windup' && me.state !== 'recover') {
          const role = defn.role;
          const doAfter = (fn: ()=>void) => this.time.delayedCall(me.windupMs, fn);

          if (role === 'melee' && dist <= me.range) {
            me.enter('windup');
            const locked = target;
            doAfter(() => {
              if (!me.body || me.state !== 'windup') return;
              // tag killer BEFORE damage
              (locked as any).__lastHitBy = me.id;
              if (locked && locked.body && locked.state !== 'dead') me.resolveHit(locked);
              me.state = 'recover';
              this.time.delayedCall(me.recoverMs, () => { if (!me.body || me.state === 'dead') return; me.enter('idle'); });
            });

          } else if (role === 'ranged' && dist <= me.range) {
            me.enter('windup');
            const locked = target;
            doAfter(() => {
              if (!me.body || me.state !== 'windup') return;
              if (locked && locked.body && locked.state !== 'dead') this.fireProjectile(me, locked, defn, 'arrow');
              me.state = 'recover';
              this.time.delayedCall(me.recoverMs, () => { if (!me.body || me.state === 'dead') return; me.enter('idle'); });
            });

          } else if (role === 'magic' && dist <= me.range) {
            me.enter('windup');
            const locked = target;
            doAfter(() => {
              if (!me.body || me.state !== 'windup') return;
              if (locked && locked.body && locked.state !== 'dead') this.fireProjectile(me, locked, defn, 'magic');
              me.state = 'recover';
              this.time.delayedCall(me.recoverMs, () => { if (!me.body || me.state === 'dead') return; me.enter('idle'); });
            });

          } else if (role === 'healer') {
            // heal lowest ally in range
            let bestAlly: Fighter | undefined;
            let worstPct = 1;
            for (const ally of friendsAll){
              if (ally === me || ally.state==='dead') continue;
              const d = Phaser.Math.Distance.Between(me.x, me.y, ally.x, ally.y);
              const pct = ally.hp / ally.maxHP;
              if (d <= me.range && pct < worstPct) { worstPct = pct; bestAlly = ally; }
            }
            if (bestAlly && worstPct < 1) {
              me.enter('windup');
              const targetAlly = bestAlly;
              doAfter(() => {
                if (!me.body || me.state !== 'windup') return;
                targetAlly.heal(16 + me.level * 2);
                const ring = this.add.circle(targetAlly.x, targetAlly.y, 20, 0x66ffcc, 0.5).setDepth(4);
                this.tweens.add({ targets:ring, alpha:0, scale:1.8, duration:380, onComplete:()=>ring.destroy() });
                me.state = 'recover';
                this.time.delayedCall(me.recoverMs, () => { if (!me.body || me.state === 'dead') return; me.enter('idle'); });
              });
            }
          }

          const baseCd = (defn.timings?.attackCooldownMs ?? 900);
          me.attackCd = baseCd + Phaser.Math.Between(-180, 220);
        }
      }
    });

    // Projectiles update & collision
    for (const p of this.projectiles) {
      p.update(dt);
      if (!p.alive) continue;

      const victims = [...this.fighters.values()].filter(f=> f.state!=='dead' && f.team !== p.team && f.body);
      for (const v of victims) {
        const d = Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, v.x, v.y);
        if (d <= (p.radius + 14)) {
          // tag killer (projectile owner) BEFORE damage
          const ownerId: string | undefined = (p as any).ownerId;
          if (ownerId) (v as any).__lastHitBy = ownerId;

          if ((p as any).kind === 'magic' && (p as any).aoeRadius) {
            const all = [...this.fighters.values()].filter(f=> f.team !== p.team && f.state!=='dead');
            all.forEach(t=>{
              const dd = Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, t.x, t.y);
              if (dd <= (p as any).aoeRadius!) {
                if (ownerId) (t as any).__lastHitBy = ownerId;
                t.takeDamage((p as any).dmg);
              }
            });
          } else {
            v.takeDamage((p as any).dmg);
          }
          const flash = this.add.rectangle(p.sprite.x, p.sprite.y, 8, 8, 0xffffff, 0.7).setDepth(7);
          this.tweens.add({ targets:flash, alpha:0, scale:2, duration:200, onComplete:()=>flash.destroy() });
          p.destroy();
          break;
        }
      }
    }

    // Detect new deaths to credit kills
    for (const f of this.fighters.values()) {
      if (f.state === 'dead' && !this.seenDead.has(f.id)) {
        this.seenDead.add(f.id);
        this.creditKillIfAny(f);
      }
    }

    // --- Wave progression: start next wave when all enemies are dead and no spawns pending ---
    const playersAlive = teamA.length > 0;
    const enemiesAlive = teamB.length > 0;

    if (this.waveActive) {
      if (!enemiesAlive && this.waveSpawnsRemaining <= 0) {
        this.onWaveCleared();
      }
    }

    // HUD: left stats + right mini boards
    this.renderStatsUI(teamA.length, teamB.length);
  }

  // ------------------- WAVE LOGIC -------------------
  onBattleStart(){
    // give players a little nudge
    this.fighters.forEach(f=>{
      if (!f.body) return;
      const dir = f.team==='A' ? 1 : -1;
      f.setVelocity(0.6*dir, (Math.random()-0.5)*0.3);
      f.enter('chase');
    });

    // Start Wave 1
    this.startNextWave();
  }

  private startNextWave(){
    if (this.waveActive) return;
    this.waveNumber++;
    this.waveActive = true;
    this.waveSpawnsRemaining = this.computeWaveEnemyCount();

    const isBoss = (this.waveNumber % this.BOSS_EVERY) === 0;

    this.hud.showBanner(isBoss ? `Wave ${this.waveNumber} — BOSS!` : `Wave ${this.waveNumber}`);

    // Boss first (doesn't count against burst, but does reduce remaining)
    if (isBoss) {
      this.spawnBossForWave(this.waveNumber);
      // count boss as 2 "slots" worth so waves don’t overfill too much
      this.waveSpawnsRemaining = Math.max(0, this.waveSpawnsRemaining - 2);
    }

    // spawn in bursts
    const spawnBurst = () => {
      if (this.waveSpawnsRemaining <= 0) return;
      const burst = Math.min(this.BURST_SIZE, this.waveSpawnsRemaining);
      for (let i=0;i<burst;i++) this.spawnRandomEnemyForWave(this.waveNumber);
      this.waveSpawnsRemaining -= burst;
      if (this.waveSpawnsRemaining > 0) {
        this.waveSpawnTimer = this.time.delayedCall(this.BURST_INTERVAL_MS, spawnBurst);
      }
    };
    spawnBurst();
  }

  private onWaveCleared(){
    this.waveActive = false;

    // Show clear banner
    this.hud.showBanner(`Wave ${this.waveNumber} Cleared!`);

    // Survivors roll call (players alive)
    const survivors = [...this.fighters.values()]
      .filter(f=>f.team==='A' && f.state!=='dead')
      .map(f=>f.name);
    const list = survivors.slice(0, 6).join(', ') + (survivors.length>6 ? '…' : '');
    this.time.delayedCall(800, () => {
      if (survivors.length) this.hud.showBanner(`Survivors: ${list}`);
      else this.hud.showBanner(`All players fell…`);
    });

    // small breather then next wave
    if (this.betweenWaveTimer) this.betweenWaveTimer.remove(false);
    this.betweenWaveTimer = this.time.delayedCall(2200, () => {
      // only start if players still alive
      if ([...this.fighters.values()].some(f=>f.team==='A' && f.state!=='dead')) {
        this.startNextWave();
      }
    });
  }

  private computeWaveEnemyCount(): number {
    const players = this.playerCount();
    const base = Math.max(1, players) * this.BASE_PER_PLAYER;
    return base + (this.waveNumber - 1) * this.WAVE_BONUS;
  }

  private enemyPoolForWave(wave:number): UnitKind[] {
    // Build enemy list from UNIT_DEFS with side==='enemy'
    const allEnemies = (Object.keys(UNIT_DEFS) as UnitKind[])
      .filter(k => UNIT_DEFS[k].side === 'enemy');

    if (allEnemies.length === 0) return ['orc' as UnitKind]; // fallback

    // Rank by a simple "power score"
    const scored = allEnemies.map(k=>{
      const s = UNIT_DEFS[k].stats;
      const score = (s.atk) + (s.maxHP * 0.2) + (s.range * 0.02) + (s.speed * 10);
      return { k, score };
    }).sort((a,b)=> a.score - b.score);

    // Unlock tougher types gradually
    const unlocked = Math.min(scored.length, 1 + Math.floor((wave-1)/2));
    return scored.slice(0, unlocked).map(o=>o.k);
  }

  private spawnRandomEnemyForWave(wave:number){
    const pool = this.enemyPoolForWave(wave);
    const kind = pool[Phaser.Math.Between(0, pool.length-1)];
    // stat scaling per wave
    const hpScale = 1 + this.STAT_HP_SCALE * (wave-1);
    const atkScale = 1 + this.STAT_ATK_SCALE * (wave-1);
    const speedScale = 1 + this.STAT_SPD_SCALE * (wave-1);
    const level = 1 + Math.floor((wave-1)/2);

    this.spawnKind('B', kind, {
      name: UNIT_DEFS[kind].displayName,
      level,
      hpScale,
      atkScale,
      speedScale,
    });
  }

  private spawnBossForWave(wave:number) {
    // pick a strong type
    const bosses: UnitKind[] = ['elite_orc', 'orc_rider', 'greatsword_skeleton', 'armored_orc'];
    const kind = bosses[Phaser.Math.Between(0, bosses.length-1)];

    // amplify base scaling further for boss
    const baseHp = 1 + this.STAT_HP_SCALE * (wave-1);
    const baseAtk = 1 + this.STAT_ATK_SCALE * (wave-1);
    const baseSpd = 1 + this.STAT_SPD_SCALE * (wave-1);

    const hpScale = baseHp * this.BOSS_HP_MULT;
    const atkScale = baseAtk * this.BOSS_ATK_MULT;
    const speedScale = baseSpd * this.BOSS_SPD_MULT;

    this.spawnKind('B', kind, {
      name: `BOSS ${UNIT_DEFS[kind].displayName}`,
      level: 2 + Math.floor(wave/2),
      hpScale,
      atkScale,
      speedScale,
    });
  }

  private playerCount() { return [...this.fighters.values()].filter(f => f.team === 'A' && f.state !== 'dead').length; }
  private enemyCount()  { return [...this.fighters.values()].filter(f => f.team === 'B' && f.state !== 'dead').length; }

  // ------------------- PROJECTILES -------------------
  private fireProjectile(attacker: Fighter, target: Fighter, defn: UnitDef, pref?: 'arrow'|'magic'){
    const vx = (target.x - attacker.x);
    const vy = (target.y - attacker.y);
    const dist = Math.max(1, Math.hypot(vx, vy));
    const role = defn.role;
    const pdef = defn.projectile ?? {};
    const kind = (pref ?? (pdef.texture ?? (role==='ranged' ? 'arrow' : 'magic'))) as any;

    const speed = pdef.speed ?? (kind==='arrow' ? 520 : 480);
    const nx = vx / dist, ny = vy / dist;
    const texKey = this.pickProjectileTexture(kind);

    const proj = new Projectile(this, texKey, {
      team: attacker.team,
      kind,
      x: attacker.x + nx * 18,
      y: attacker.y + ny * 18,
      vx: nx * speed,
      vy: ny * speed,
      dmg: attacker.atk + attacker.level * 2,
      radius: pdef.radius ?? (kind==='magic' ? 14 : 10),
      maxLifeMs: 2500,
      aoeRadius: pdef.aoeRadius,
      ownerId: attacker.id, // <--- for kill attribution
    } as any);
    (proj as any).ownerId = attacker.id; // ensure field present even if ctor strips extras
    this.projectiles.push(proj);
  }

  private pickProjectileTexture(what: 'arrow'|'magic'|'heal'): string {
    const global = `proj_${what}`;
    if (this.textures.exists(global)) return global;
    const g = this.add.graphics();
    if (what === 'arrow') {
      g.fillStyle(0xffffff, 1); g.fillRect(0, 5, 22, 2);
      g.fillStyle(0x222222, 1); g.fillTriangle(22, 6, 16, 9, 16, 3);
      g.generateTexture(global, 26, 12);
    } else if (what === 'magic') {
      g.fillStyle(0x66ccff, 1); g.fillCircle(8,8,8);
      g.generateTexture(global, 16, 16);
    } else if (what === 'heal') {
      g.fillStyle(0x66ff99, 1); g.fillCircle(8,8,8);
      g.generateTexture(global, 16, 16);
    }
    g.destroy();
    return global;
  }

  // ------------------- SPAWNING (both teams) -------------------
  spawnKind(
    team: Team,
    kind: UnitKind,
    opts?: {
      id?: string; name?: string;
      level?: number;
      hpScale?: number; atkScale?: number; speedScale?: number;
    }
  ){
    const defn = UNIT_DEFS[kind];
    if (!defn) { console.warn('Unknown kind', kind); return; }
    if (team==='A' && defn.side==='enemy') { console.warn('Cannot spawn enemy kind on team A'); return; }
    if (team==='B' && defn.side==='player') { console.warn('Cannot spawn player kind on team B'); return; }

    const baseX = team==='A' ? 380 : 1540;
    const x = baseX + Phaser.Math.Between(-60, 60);
    const y = 520 + Phaser.Math.Between(-60, 60);

    const id = opts?.id ?? `${team}_${kind}_${Math.random().toString(36).slice(2,8)}`;
    const name = opts?.name ?? (defn.displayName);

    const f = new Fighter(this, x, y, id, name, team, kind, defn);

    // Level/scaling for enemies per-wave
    if (opts?.level) f.level = opts.level;
    if (opts?.hpScale && team==='B') {
      f.maxHP = Math.floor(f.maxHP * opts.hpScale);
      f.hp = f.maxHP;
    }
    if (opts?.atkScale && team==='B') {
      f.atk = Math.max(1, Math.floor(f.atk * opts.atkScale));
    }
    if (opts?.speedScale && team==='B') {
      f.speed = f.speed * opts.speedScale;
    }

    this.fighters.set(id, f);
    this.updateHud();
  }

  // ------------------- HEARTS / GIFTS -------------------
  applyHearts(count:number){
    const heal = Math.min(8, 2 + Math.floor(count/30));
    this.fighters.forEach(f=>{
      if (!f.body || f.state==='dead') return;
      if (f.team==='A') {
        f.heal(heal);
        const bvx = (f.body as any).velocity?.x ?? 0;
        const bvy = (f.body as any).velocity?.y ?? 0;
        f.setVelocity(bvx * 0.9 + (Math.random()-0.5)*0.4, bvy * 0.9 + (Math.random()-0.5)*0.4);
      }
    });
  }

  triggerGift(type:string, _userId?:string){
    const t = (type || '').toLowerCase();
    if (t.includes('tier1')) this.simulateGiftTier(1);
    else if (t.includes('tier2')) this.simulateGiftTier(2);
    else if (t.includes('tier3')) this.simulateGiftTier(3);
    else if (t.includes('tier4')) this.simulateGiftTier(4);
  }

  private simulateGiftTier(tier:number){
    const tierMap: Record<number, UnitKind[]> = {
      1: ['soldier', 'swordsman', 'archer'],
      2: ['knight', 'lancer', 'armored_axeman'],
      3: ['wizard', 'priest', 'knight_templar'],
      4: ['werewolf', 'werebear', 'knight_templar'],
    };
    const list = tierMap[tier] ?? ['soldier'];
    const kind = list[Phaser.Math.Between(0, list.length-1)];
    this.spawnKind('A', kind, { name: UNIT_DEFS[kind].displayName });
    this.hud.showBanner(`Gift Tier ${tier}: ${UNIT_DEFS[kind].displayName}!`);
  }

  // ------------------- KILL CREDIT / BOARDS -------------------
  private creditKillIfAny(victim: Fighter){
    const killerId: string | undefined = (victim as any).__lastHitBy;
    if (!killerId) return;
    const killer = this.fighters.get(killerId);
    if (!killer || killer.team !== 'A') return; // only credit players

    const name = killer.name || killerId;

    // daily board
    this.killsToday.set(name, (this.killsToday.get(name) ?? 0) + 1);

    // per-match per-player counter (optional, purely for future use)
    (killer as any).__kills = ((killer as any).__kills ?? 0) + 1;
  }

  private dailyKeyLA(): string {
    // YYYY-MM-DD in America/Los_Angeles
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  }
  private resetDaily(key: string){
    this.lastDailyKey = key;
    this.killsToday.clear();
    // supporters are "this match", not daily; leave them
  }

  private renderStatsUI(players:number, enemies:number){
    // left block
    const left: string[] = [
      `Wave ${Math.max(1,this.waveNumber)}`,
      `Players: ${players}`,
      `Enemies: ${enemies}`,
      `Hearts: ${this.heartsTotalMatch}`,
    ];

    // right block (Top Slayers Today / Top Supporters This Match)
    const topSlayers = [...this.killsToday.entries()].sort((a,b)=> b[1]-a[1]).slice(0,5);
    const slayerLines = topSlayers.map(([n,k],i)=> `${i+1}. ${this.trimName(n, 12)} ${k}`);

    const topSupporters = [...this.supportersMatch.entries()].sort((a,b)=> b[1]-a[1]).slice(0,5);
    const supporterLines = topSupporters.map(([n,s],i)=> `${i+1}. ${this.trimName(n, 12)} ${s}`);

    // We only have hud.setStats([...]) in this project, so concatenate neatly.
    this.hud.setStats([
      ...left,
      '— Slayers (Today) —',
      ... (slayerLines.length ? slayerLines : ['(no kills yet)']),
      '— Supporters (Match) —',
      ... (supporterLines.length ? supporterLines : ['(awaiting gifts)']),
    ]);
  }

  private trimName(n:string, max:number){ return n.length<=max ? n : n.slice(0, max-1)+'…'; }

  // ------------------- WIN / HUD -------------------
  declareWinner(id:string){
    const msg: WSIn = { type: 'winner', payload: { id } } as any;
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
  showWinner(id:string){
    const f = this.fighters.get(id);
    if (!f) return;
    this.hud.showBanner(`Winner: ${f.name} (Team ${f.team})`);
  }
  updateHud(){
    const players = [...this.fighters.values()].filter(f=>f.team==='A' && f.state!=='dead').length;
    const enemies = [...this.fighters.values()].filter(f=>f.team==='B' && f.state!=='dead').length;
    this.hud.setTop(`Phase: ${this.phase} • Wave ${Math.max(1,this.waveNumber)} • Players ${players} • Enemies ${enemies}`);
  }
}
