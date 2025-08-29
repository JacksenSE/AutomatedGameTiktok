export class CountdownUI {
  el: HTMLDivElement;
  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'countdown';
    Object.assign(this.el.style, {
      position: 'absolute',
      top: '40%',
      left: '50%',
      transform: 'translate(-50%,-50%)',
      fontSize: '120px',
      fontWeight: '900',
      textShadow: '0 4px 16px rgba(0,0,0,0.6)',
      display: 'none',
    });
    root.appendChild(this.el);
    this.hide();
  }
  show(n: number) { this.el.style.display = 'block'; this.el.textContent = String(n); }
  hide() { this.el.style.display = 'none'; }
}
