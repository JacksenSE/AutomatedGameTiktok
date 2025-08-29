export class HUD {
  top: HTMLDivElement;
  banner: HTMLDivElement;
  stats: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.top = document.createElement('div');
    this.top.className = 'hud-top';
    this.top.style.pointerEvents = 'none';
    this.top.style.position = 'absolute';
    this.top.style.top = '12px';
    this.top.style.left = '12px';
    this.top.style.fontSize = '20px';
    this.top.style.fontWeight = '600';
    root.appendChild(this.top);

    this.banner = document.createElement('div');
    this.banner.className = 'banner';
    Object.assign(this.banner.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%,-50%)',
      fontSize: '42px',
      fontWeight: '800',
      background: 'rgba(0,0,0,0.35)',
      padding: '12px 18px',
      borderRadius: '10px',
      display: 'none',
    });
    root.appendChild(this.banner);

    this.stats = document.createElement('div');
    this.stats.className = 'stats';
    Object.assign(this.stats.style, {
      position: 'absolute',
      top: '80px',
      left: '12px',
      fontSize: '16px',
      lineHeight: '20px',
      background: 'rgba(0,0,0,0.4)',
      padding: '8px 12px',
      borderRadius: '8px',
      maxWidth: '280px',
    });
    root.appendChild(this.stats);
  }

  setTop(text: string) { this.top.textContent = text; }
  showBanner(text: string) { this.banner.style.display = 'block'; this.banner.textContent = text; }
  hideBanner() { this.banner.style.display = 'none'; }
  setStats(lines: string[]) { this.stats.innerHTML = lines.join('<br>'); }
}
