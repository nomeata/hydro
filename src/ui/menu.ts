/**
 * Small game menu: sound, new world, export / import save files.
 */
/** The sound controls the menu shows (audio/sound.ts). */
export interface SoundControls {
  readonly muted: boolean;
  readonly volume: number;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  onChange(fn: () => void): void;
}

export interface MenuActions {
  howToPlay(): void;
  achievements(): void;
  newWorld(): void;
  exportSave(): Promise<void>;
  importSave(file: File): Promise<void>;
  sound?: SoundControls;
}

export class Menu {
  private readonly panel: HTMLElement;
  private readonly button: HTMLElement;
  private readonly items = new Map<string, HTMLElement>();

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
      this.items.set(label, b);
    };
    item('How to play', () => actions.howToPlay());
    item('Achievements', () => actions.achievements());
    item('New world', () => {
      if (confirm('Start a new world? The current one will be replaced.')) actions.newWorld();
    });
    item('Save to file', () => void actions.exportSave());
    item('Load from file', () => file.click());
    if (actions.sound) this.panel.prepend(soundRow(actions.sound));

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.panel.hidden = !this.panel.hidden;
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.panel.contains(e.target as Node) && e.target !== button) this.close();
    });
    this.button = button;
    root.querySelector('.topbar')?.append(button);
    root.append(this.panel, file);
  }

  /** A small dot on the menu button and the Achievements item: a new idea for this valley. */
  setNews(on: boolean): void {
    this.button.classList.toggle('news', on);
    this.items.get('Achievements')?.classList.toggle('news', on);
  }

  close(): void {
    this.panel.hidden = true;
  }
}

/** Sound on/off and a volume slider (the menu stays open while they are used). */
function soundRow(c: SoundControls): HTMLElement {
  const row = document.createElement('div');
  row.className = 'menu-sound';
  const toggle = document.createElement('button');
  toggle.className = 'sound-toggle';
  toggle.dataset.testid = 'sound-toggle';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '5';
  slider.setAttribute('aria-label', 'Volume');
  slider.dataset.testid = 'sound-volume';
  const sync = () => {
    toggle.textContent = c.muted ? 'Sound off' : 'Sound on';
    toggle.setAttribute('aria-pressed', String(!c.muted));
    slider.value = String(Math.round(c.volume * 100));
    slider.disabled = c.muted;
  };
  toggle.addEventListener('click', () => c.setMuted(!c.muted));
  slider.addEventListener('input', () => c.setVolume(Number(slider.value) / 100));
  c.onChange(sync);
  sync();
  row.append(toggle, slider);
  return row;
}
