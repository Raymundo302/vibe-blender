import type { Renderer, ShadingMode } from '../render/Renderer';
import { shadePrefs, saveShadePrefs, AO_RADIUS_RANGE, AO_STRENGTH_RANGE, AO_SAMPLES_RANGE } from '../render/shadePrefs';

/**
 * Viewport-header shading dropdown (right side of the 3D Viewport area header,
 * Blender's shading popover): pick the solid mode (matcap / wireframe /
 * studio / rendered) and toggle the shading options — Ambient Occlusion,
 * Wireframe overlay (shaded modes), Hidden Line (wireframe mode). The Z-cycle
 * keybind keeps working; update() re-labels the button every frame so the two
 * stay in sync.
 */

const MODES: { mode: ShadingMode; label: string; icon: string }[] = [
  { mode: 'matcap', label: 'Matcap', icon: '⬤' },
  { mode: 'wireframe', label: 'Wireframe', icon: '◇' },
  { mode: 'studio', label: 'Studio', icon: '◐' },
  { mode: 'rendered', label: 'Rendered', icon: '✦' },
];

export class ShadingMenu {
  readonly element: HTMLElement;
  private readonly button: HTMLButtonElement;
  private openRoot: HTMLDivElement | null = null;
  private lastLabel = '';

  constructor(private readonly renderer: Renderer) {
    this.element = document.createElement('div');
    this.element.className = 'shading-menu';
    this.button = document.createElement('button');
    this.button.className = 'shading-menu-btn';
    this.button.title = 'Viewport shading (Z cycles)';
    this.button.addEventListener('click', () => this.toggle());
    this.element.append(this.button);
    this.update();
  }

  /** Called every frame by the app loop: keep the label on the current mode. */
  update(): void {
    const m = MODES.find((x) => x.mode === this.renderer.shadingMode) ?? MODES[0];
    const label = `${m.icon} ${m.label} ▾`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.button.textContent = label;
    }
  }

  private toggle(): void {
    if (this.openRoot) {
      this.close();
      return;
    }
    const root = document.createElement('div');
    root.className = 'topbar-menu shading-menu-pop';
    document.body.appendChild(root);
    this.openRoot = root;

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    };
    const onOutside = (e: PointerEvent): void => {
      if (!root.contains(e.target as Node) && e.target !== this.button) this.close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onOutside, true);
    this.cleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onOutside, true);
    };

    const heading = document.createElement('div');
    heading.className = 'topbar-menu-heading';
    heading.textContent = 'Viewport Shading';
    root.appendChild(heading);

    for (const m of MODES) {
      const row = document.createElement('button');
      row.className = `topbar-menu-row shading-menu-mode${this.renderer.shadingMode === m.mode ? " topbar-menu-active" : ""}`;
      row.dataset.mode = m.mode;
      row.textContent = `${this.renderer.shadingMode === m.mode ? '●' : '○'}  ${m.icon} ${m.label}`;
      row.addEventListener('click', () => {
        this.renderer.shadingMode = m.mode;
        this.update();
        this.close();
      });
      root.appendChild(row);
    }

    const optHeading = document.createElement('div');
    optHeading.className = 'topbar-menu-heading';
    optHeading.textContent = 'Options';
    root.appendChild(optHeading);

    const checks: { key: keyof typeof shadePrefs; label: string; title: string }[] = [
      { key: 'ao', label: 'Ambient Occlusion', title: 'Screen-space AO in the shaded modes' },
      { key: 'wireOverlay', label: 'Wireframe', title: 'Draw the edge wireframe over the shaded modes' },
      { key: 'wireHiddenLine', label: 'Hidden Line (wireframe)', title: 'In Wireframe mode: hide backfacing wires and wires behind geometry' },
    ];
    // AO's tuner sliders live right under its checkbox and grey out with it.
    const aoSliders: HTMLInputElement[] = [];
    const syncSliderState = (): void => {
      for (const el of aoSliders) {
        el.disabled = !shadePrefs.ao;
        (el.closest('.shading-menu-slider') as HTMLElement).classList.toggle('is-disabled', !shadePrefs.ao);
      }
    };
    const sliderRow = (
      key: 'aoRadius' | 'aoStrength' | 'aoSamples', label: string,
      range: { min: number; max: number }, step: number, title: string,
    ): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'shading-menu-slider';
      row.dataset.shadeSlider = key;
      row.title = title;
      const text = document.createElement('span');
      text.className = 'shading-menu-slider-label';
      text.textContent = label;
      const value = document.createElement('span');
      value.className = 'shading-menu-slider-value';
      const fmt = (v: number): string => key === 'aoSamples' ? String(Math.round(v)) : v.toFixed(2);
      value.textContent = fmt(shadePrefs[key]);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(range.min);
      input.max = String(range.max);
      input.step = String(step);
      input.value = String(shadePrefs[key]);
      input.addEventListener('input', () => {
        shadePrefs[key] = Number(input.value);
        value.textContent = fmt(shadePrefs[key]);
        saveShadePrefs();
      });
      aoSliders.push(input);
      row.append(text, input, value);
      return row;
    };

    for (const c of checks) {
      const row = document.createElement('label');
      row.className = 'topbar-menu-check';
      row.dataset.shadePref = c.key;
      row.title = c.title;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = shadePrefs[c.key] as boolean;
      box.addEventListener('change', () => {
        (shadePrefs[c.key] as boolean) = box.checked;
        saveShadePrefs();
        if (c.key === 'ao') syncSliderState();
      });
      const text = document.createElement('span');
      text.textContent = c.label;
      row.append(box, text);
      root.appendChild(row);
      if (c.key === 'ao') {
        root.appendChild(sliderRow('aoRadius', 'Radius', AO_RADIUS_RANGE, 0.05,
          'AO sample radius (world units) — bigger reaches broader creases'));
        root.appendChild(sliderRow('aoStrength', 'Strength', AO_STRENGTH_RANGE, 0.05,
          'AO darkening amount — 0 off, 1 default, 2 doubled'));
        root.appendChild(sliderRow('aoSamples', 'Samples', AO_SAMPLES_RANGE, 16,
          'AO samples per pixel — more is cleaner, fewer is faster'));
      }
    }
    syncSliderState();

    // Position under the button, right-aligned to it.
    requestAnimationFrame(() => {
      const r = this.button.getBoundingClientRect();
      root.style.top = `${r.bottom + 4}px`;
      root.style.left = `${Math.max(4, r.right - root.offsetWidth)}px`;
    });
  }

  private cleanup: (() => void) | null = null;

  private close(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.openRoot?.remove();
    this.openRoot = null;
  }
}
