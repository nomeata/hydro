/**
 * Small game menu: new world, export / import save files.
 */
export interface MenuActions {
  howToPlay(): void;
  achievements(): void;
  newWorld(): void;
  exportSave(): Promise<void>;
  importSave(file: File): Promise<void>;
}

export class Menu {
  private readonly panel: HTMLElement;

  constructor(root: HTMLElement, actions: MenuActions) {
    const button = document.createElement('button');
    button.className = 'menu-button panel';
    button.setAttribute('aria-label', 'Menu');
    button.innerHTML = '<span></span><span></span><span></span>';
    this.panel = document.createElement('div');
    this.panel.className = 'menu panel';
    this.panel.hidden = true;

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.hydro,application/octet-stream';
    file.hidden = true;
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) void actions.importSave(f);
      file.value = '';
    });

    const item = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => {
        this.close();
        fn();
      });
      this.panel.append(b);
    };
    item('How to play', () => actions.howToPlay());
    item('Achievements', () => actions.achievements());
    item('New world', () => {
      if (confirm('Start a new world? The current one will be replaced.')) actions.newWorld();
    });
    item('Save to file', () => void actions.exportSave());
    item('Load from file', () => file.click());

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.panel.hidden = !this.panel.hidden;
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.panel.contains(e.target as Node) && e.target !== button) this.close();
    });
    root.querySelector('.topbar')?.append(button);
    root.append(this.panel, file);
  }

  close(): void {
    this.panel.hidden = true;
  }
}
