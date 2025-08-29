// A tiny developer overlay to spawn units, simulate gifts/joins, and debug quickly.

import type { UnitKind, Team } from '../game/unitDefs';

export class DevUI {
  root: HTMLDivElement;
  onSpawn?: (team: Team, kind: UnitKind, count: number) => void;
  onGiftTier?: (tier: number) => void;
  onClear?: () => void;

  constructor(container?: HTMLElement){
    this.root = document.createElement('div');
    this.root.style.position = 'absolute';
    this.root.style.right = '10px';
    this.root.style.top = '10px';
    this.root.style.background = 'rgba(0,0,0,0.6)';
    this.root.style.color = '#fff';
    this.root.style.padding = '8px';
    this.root.style.borderRadius = '8px';
    this.root.style.font = '12px/1.2 system-ui, sans-serif';
    this.root.style.zIndex = '99999';
    this.root.style.width = '260px';

    this.root.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">Dev Tools</div>
      <label>Team:
        <select id="dev-team">
          <option value="A">A (Players)</option>
          <option value="B">B (NPCs)</option>
        </select>
      </label>
      <br/>
      <label>Kind:
        <input id="dev-kind" placeholder="soldier / wizard / orc" style="width:150px"/>
      </label>
      <br/>
      <label>Count:
        <input id="dev-count" type="number" value="1" min="1" max="20" style="width:60px"/>
      </label>
      <br/>
      <button id="dev-spawn">Spawn</button>
      <hr/>
      <div>Gift tiers:</div>
      <button data-tier="1">Tier 1</button>
      <button data-tier="2">Tier 2</button>
      <button data-tier="3">Tier 3</button>
      <button data-tier="4">Tier 4</button>
      <hr/>
      <button id="dev-clear">Clear NPCs</button>
    `;

    (container ?? document.body).appendChild(this.root);

    const $ = (id:string)=> this.root.querySelector(id) as HTMLElement;

    $('#dev-spawn')?.addEventListener('click', () => {
      const team = ($('#dev-team') as HTMLSelectElement).value as Team;
      const kind = ($('#dev-kind') as HTMLInputElement).value.trim().toLowerCase() as UnitKind;
      const count = parseInt(($('#dev-count') as HTMLInputElement).value || '1', 10);
      this.onSpawn?.(team, kind, isNaN(count) ? 1 : count);
    });

    this.root.querySelectorAll('button[data-tier]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const tier = parseInt((btn as HTMLButtonElement).dataset.tier!,10);
        this.onGiftTier?.(tier);
      });
    });

    $('#dev-clear')?.addEventListener('click', () => this.onClear?.());
  }
}
