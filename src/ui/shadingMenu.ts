import type { Renderer, ShadingMode } from '../render/Renderer';
import { shadePrefs, saveShadePrefs, AO_METHODS, AO_RADIUS_RANGE, AO_STRENGTH_RANGE, AO_SAMPLES_RANGE, CAVITY_RANGE, WIRE_MIN_PX_RANGE, WIRE_MAX_PX_RANGE } from '../render/shadePrefs';
import type { AoMode } from '../render/shadePrefs';

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
  /** Viewport status chip — "Raytraced · GPU · 37 spp" while in Rendered → Ray. */
  private readonly chip: HTMLSpanElement;
  private openRoot: HTMLDivElement | null = null;
  private lastLabel = '';
  private lastChip = '';

  constructor(private readonly renderer: Renderer) {
    this.element = document.createElement('div');
    this.element.className = 'shading-menu';
    this.chip = document.createElement('span');
    this.chip.className = 'shading-ray-chip';
    this.chip.dataset.testid = 'ray-chip';
    this.chip.style.display = 'none';
    this.button = document.createElement('button');
    this.button.className = 'shading-menu-btn';
    this.button.title = 'Viewport shading (Z cycles)';
    this.button.addEventListener('click', () => this.toggle());
    this.element.append(this.chip, this.button);
    this.update();
  }

  /** Called every frame by the app loop: keep the label on the current mode and
   *  refresh the raytraced status chip. */
  update(): void {
    const m = MODES.find((x) => x.mode === this.renderer.shadingMode) ?? MODES[0];
    const label = `${m.icon} ${m.label} ▾`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.button.textContent = label;
    }
    const ray = this.renderer.viewportRay;
    if (this.renderer.shadingMode === 'rendered' && shadePrefs.renderedMode === 'ray') {
      const txt = `Raytraced · ${ray.engineLabel} · ${ray.spp} spp`;
      if (txt !== this.lastChip) { this.lastChip = txt; this.chip.textContent = txt; }
      if (this.chip.style.display === 'none') this.chip.style.display = '';
    } else if (this.chip.style.display !== 'none') {
      this.chip.style.display = 'none';
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

    const modeRows: { mode: ShadingMode; row: HTMLButtonElement; icon: string; label: string }[] = [];
    for (const m of MODES) {
      const row = document.createElement('button');
      row.className = `topbar-menu-row shading-menu-mode${this.renderer.shadingMode === m.mode ? " topbar-menu-active" : ""}`;
      row.dataset.mode = m.mode;
      row.textContent = `${this.renderer.shadingMode === m.mode ? '●' : '○'}  ${m.icon} ${m.label}`;
      row.addEventListener('click', () => {
        this.renderer.shadingMode = m.mode;
        this.update();
        // Keep the popover open so the options (esp. the per-mode Hidden Line
        // checkbox) can be seen updating for the newly selected mode.
        for (const r of modeRows) {
          const on = r.mode === m.mode;
          r.row.classList.toggle('topbar-menu-active', on);
          r.row.textContent = `${on ? '●' : '○'}  ${r.icon} ${r.label}`;
        }
        resyncHiddenLine();
        resyncRenderedSub();
      });
      modeRows.push({ mode: m.mode, row, icon: m.icon, label: m.label });
      root.appendChild(row);
    }

    // --- Rendered sub-choice (UR15-1): Mode Live|Raytraced + Engine GPU|CPU ---
    // Shown beneath the mode rows only while Rendered is the active mode. A small
    // select-row family matching the AO section bodies' indent.
    const renderedSub = document.createElement('div');
    renderedSub.className = 'shading-section-body shading-rendered-sub';
    renderedSub.dataset.renderedSub = '';

    const subSelectRow = (
      label: string, dataAttr: string, title: string,
      fill: (sel: HTMLSelectElement) => void, onChange: (sel: HTMLSelectElement) => void,
    ): { row: HTMLElement; select: HTMLSelectElement } => {
      const row = document.createElement('label');
      row.className = 'shading-menu-select-row';
      row.title = title;
      const text = document.createElement('span');
      text.className = 'shading-menu-slider-label';
      text.textContent = label;
      const select = document.createElement('select');
      select.className = 'shading-menu-select';
      select.dataset[dataAttr] = '';
      fill(select);
      select.addEventListener('change', () => { onChange(select); saveShadePrefs(); });
      row.append(text, select);
      return { row, select };
    };

    const modeChoice = subSelectRow('Mode', 'renderedMode',
      'Rendered viewport: Live rasterized shading, or the real path tracer accumulating live',
      (sel) => {
        for (const [value, txt] of [['live', 'Live'], ['ray', 'Raytraced']]) {
          const o = document.createElement('option');
          o.value = value; o.textContent = txt;
          sel.appendChild(o);
        }
        sel.value = shadePrefs.renderedMode;
      },
      (sel) => { shadePrefs.renderedMode = sel.value === 'ray' ? 'ray' : 'live'; resyncRenderedSub(); },
    );
    renderedSub.appendChild(modeChoice.row);

    const engineChoice = subSelectRow('Engine', 'rayEngine',
      'Path-tracer backend: GPU (WebGL2) or CPU (main thread)',
      (sel) => {
        // GPU listed first + default; CPU is the fallback.
        for (const [value, txt] of [['gpu', 'GPU'], ['cpu', 'CPU']]) {
          const o = document.createElement('option');
          o.value = value; o.textContent = txt;
          sel.appendChild(o);
        }
      },
      (sel) => { shadePrefs.rayEngine = sel.value === 'cpu' ? 'cpu' : 'gpu'; },
    );
    renderedSub.appendChild(engineChoice.row);

    const resyncRenderedSub = (): void => {
      const isRendered = this.renderer.shadingMode === 'rendered';
      renderedSub.style.display = isRendered ? '' : 'none';
      if (!isRendered) return;
      modeChoice.select.value = shadePrefs.renderedMode;
      const isRay = shadePrefs.renderedMode === 'ray';
      engineChoice.row.style.display = isRay ? '' : 'none';
      // Reflect GPU availability: disable the GPU option with the probe reason,
      // and auto-select CPU when the GPU probe fails (pref preserved).
      const gpuAvail = this.renderer.viewportRay.gpuAvailable;
      const gpuOpt = engineChoice.select.querySelector('option[value="gpu"]') as HTMLOptionElement | null;
      if (gpuOpt) {
        gpuOpt.disabled = !gpuAvail;
        gpuOpt.title = gpuAvail ? '' : (this.renderer.viewportRay.gpuReason ?? 'GPU tracer unavailable');
      }
      engineChoice.select.title = gpuAvail
        ? 'Path-tracer backend: GPU (WebGL2) or CPU (main thread)'
        : `GPU tracer unavailable: ${this.renderer.viewportRay.gpuReason ?? 'unknown'} — using CPU`;
      engineChoice.select.value = (!gpuAvail && shadePrefs.rayEngine === 'gpu') ? 'cpu' : shadePrefs.rayEngine;
    };
    root.appendChild(renderedSub);
    resyncRenderedSub();

    const optHeading = document.createElement('div');
    optHeading.className = 'topbar-menu-heading';
    optHeading.textContent = 'Options';
    root.appendChild(optHeading);

    // The Hidden Line checkbox is PER shading mode: it shows/sets the CURRENT
    // mode's entry and is re-synced when the mode changes (mode-row clicks).
    let hiddenLineBox: HTMLInputElement | null = null;
    const resyncHiddenLine = (): void => {
      if (hiddenLineBox) hiddenLineBox.checked = shadePrefs.hiddenLine[this.renderer.shadingMode];
    };
    // AO's tuner sliders + selects grey out with its checkbox.
    const aoSliders: HTMLInputElement[] = [];
    const aoSelects: { el: HTMLSelectElement; row: HTMLElement }[] = [];
    const syncSliderState = (): void => {
      for (const el of aoSliders) {
        el.disabled = !shadePrefs.ao;
        (el.closest('.shading-menu-slider') as HTMLElement).classList.toggle('is-disabled', !shadePrefs.ao);
      }
      for (const { el, row } of aoSelects) {
        el.disabled = !shadePrefs.ao;
        row.classList.toggle('is-disabled', !shadePrefs.ao);
      }
    };

    type NumKey = 'aoRadius' | 'aoStrength' | 'aoSamples' | 'cavityRidge' | 'cavityValley' | 'wireMinPx' | 'wireMaxPx';
    const sliderRow = (
      key: NumKey, label: string,
      range: { min: number; max: number }, step: number, title: string,
      opts: { attr: 'shadeSlider' | 'wireSlider'; greyWithAo?: boolean } = { attr: 'shadeSlider' },
    ): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'shading-menu-slider';
      if (opts.attr === 'shadeSlider') row.dataset.shadeSlider = key;
      else row.dataset.wireSlider = key;
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
      if (opts.greyWithAo) aoSliders.push(input);
      row.append(text, input, value);
      return row;
    };

    // 0..1 rgb <-> #rrggbb hex for the <input type=color> controls.
    const toHex = (c: number): string =>
      Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
    const colorRow = (
      key: 'wireColor' | 'intersectColor', label: string, title: string,
    ): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'shading-menu-color-row';
      row.dataset.shadeColor = key;
      row.title = title;
      const text = document.createElement('span');
      text.className = 'shading-menu-slider-label';
      text.textContent = label;
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'shading-menu-color';
      const rgb = shadePrefs[key];
      input.value = `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
      input.addEventListener('input', () => {
        const h = input.value;
        shadePrefs[key] = [
          parseInt(h.slice(1, 3), 16) / 255,
          parseInt(h.slice(3, 5), 16) / 255,
          parseInt(h.slice(5, 7), 16) / 255,
        ];
        saveShadePrefs();
      });
      row.append(text, input);
      return row;
    };

    // A plain indented toggle (checkbox) that writes a boolean pref.
    const toggleRow = (
      key: 'wireProximity', label: string, title: string,
    ): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'topbar-menu-check shading-menu-subcheck';
      row.dataset.wireToggle = key;
      row.title = title;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = shadePrefs[key];
      box.addEventListener('change', () => { shadePrefs[key] = box.checked; saveShadePrefs(); });
      const text = document.createElement('span');
      text.textContent = label;
      row.append(box, text);
      return row;
    };

    // A collapsible disclosure section: a header row (▸/▾ + the feature's enable
    // checkbox + label) and a body of controls, hidden when collapsed. The
    // expanded state persists per section in shadePrefs.sections.
    const makeSection = (
      id: 'ao' | 'cavity' | 'wire' | 'intersect',
      prefKey: 'ao' | 'cavity' | 'wireOverlay' | 'intersections',
      label: string, title: string,
      buildBody: (body: HTMLElement) => void,
    ): void => {
      const section = document.createElement('div');
      section.className = 'shading-section';
      section.dataset.section = id;
      const header = document.createElement('div');
      header.className = 'topbar-menu-check shading-section-header';
      header.dataset.shadePref = prefKey;
      header.title = title;
      const caret = document.createElement('span');
      caret.className = 'shading-disc';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = shadePrefs[prefKey] as boolean;
      box.addEventListener('click', (e) => e.stopPropagation()); // don't toggle the section
      box.addEventListener('change', () => {
        (shadePrefs[prefKey] as boolean) = box.checked;
        saveShadePrefs();
        if (prefKey === 'ao') syncSliderState();
      });
      const text = document.createElement('span');
      text.textContent = label;
      header.append(caret, box, text);
      const body = document.createElement('div');
      body.className = 'shading-section-body';
      const setExpanded = (v: boolean): void => {
        caret.textContent = v ? '▾' : '▸';
        body.style.display = v ? '' : 'none';
      };
      setExpanded(shadePrefs.sections[id]);
      header.addEventListener('click', (e) => {
        if (e.target === box) return;
        const nv = !shadePrefs.sections[id];
        shadePrefs.sections[id] = nv;
        saveShadePrefs();
        setExpanded(nv);
      });
      buildBody(body);
      section.append(header, body);
      root.appendChild(section);
    };

    // --- Ambient Occlusion section ---
    makeSection('ao', 'ao', 'Ambient Occlusion',
      'Screen-space AO in the shaded modes', (body) => {
        const selectRow = (
          label: string, dataAttr: 'shadeMode' | 'shadeMethod', title: string,
          fill: (sel: HTMLSelectElement) => void, onChange: (sel: HTMLSelectElement) => void,
        ): { row: HTMLElement; select: HTMLSelectElement } => {
          const row = document.createElement('label');
          row.className = 'shading-menu-select-row';
          row.title = title;
          const text = document.createElement('span');
          text.className = 'shading-menu-slider-label';
          text.textContent = label;
          const select = document.createElement('select');
          select.className = 'shading-menu-select';
          if (dataAttr === 'shadeMode') select.dataset.shadeMode = '';
          else select.dataset.shadeMethod = '';
          fill(select);
          select.addEventListener('change', () => { onChange(select); saveShadePrefs(); });
          aoSelects.push({ el: select, row });
          row.append(text, select);
          return { row, select };
        };

        const mode = selectRow('Mode', 'shadeMode',
          'AO estimator family — Screen-space GTAO or object-space SDF march',
          (sel) => {
            for (const [value, text] of [['screen', 'Screen (GTAO)'], ['object', 'Object (SDF)']]) {
              const o = document.createElement('option');
              o.value = value; o.textContent = text;
              sel.appendChild(o);
            }
            sel.value = shadePrefs.aoMode;
          },
          (sel) => { shadePrefs.aoMode = sel.value as AoMode; updateMethodVisibility(); },
        );
        body.appendChild(mode.row);

        const method = selectRow('Method', 'shadeMethod',
          'Object-AO estimator (used when Mode = Object)',
          (sel) => {
            AO_METHODS.forEach((m, i) => {
              const o = document.createElement('option');
              o.value = String(i); o.textContent = m.label; o.title = m.desc;
              sel.appendChild(o);
            });
            sel.value = String(shadePrefs.aoMethod);
          },
          (sel) => { shadePrefs.aoMethod = Number(sel.value); },
        );
        body.appendChild(method.row);

        const updateMethodVisibility = (): void => {
          method.row.style.display = shadePrefs.aoMode === 'object' ? '' : 'none';
        };
        updateMethodVisibility();

        body.appendChild(sliderRow('aoRadius', 'Radius', AO_RADIUS_RANGE, 0.05,
          'AO sample radius (world units) — bigger reaches broader creases',
          { attr: 'shadeSlider', greyWithAo: true }));
        body.appendChild(sliderRow('aoStrength', 'Strength', AO_STRENGTH_RANGE, 0.05,
          'AO darkening amount — 0 off, 1 default, 2 doubled',
          { attr: 'shadeSlider', greyWithAo: true }));
        body.appendChild(sliderRow('aoSamples', 'Samples', AO_SAMPLES_RANGE, 16,
          'AO samples per pixel — more is cleaner, fewer is faster',
          { attr: 'shadeSlider', greyWithAo: true }));
      });

    // --- Cavity section (UR13-1) ---
    makeSection('cavity', 'cavity', 'Cavity',
      'Screen-space curvature — ridges brighten, valleys/creases darken', (body) => {
        body.appendChild(sliderRow('cavityRidge', 'Ridge', CAVITY_RANGE, 0.05,
          'Convex-edge brightening amount (0 = off)'));
        body.appendChild(sliderRow('cavityValley', 'Valley', CAVITY_RANGE, 0.05,
          'Concave-crease darkening amount (0 = off)'));
      });

    // --- Wireframe section ---
    makeSection('wire', 'wireOverlay', 'Wireframe',
      'Draw the edge wireframe over the shaded modes', (body) => {
        body.appendChild(colorRow('wireColor', 'Color',
          'Wire line color — drives wireframe mode + the overlay (the edit cage keeps its own colors)'));
        body.appendChild(toggleRow('wireProximity', 'Thick to Thin',
          'Scale wire width by proximity (off = a constant width = the Thick value)'));
        body.appendChild(sliderRow('wireMinPx', 'Thin', WIRE_MIN_PX_RANGE, 0.1,
          'Minimum wire half-width in pixels (near-far proximity floor)',
          { attr: 'wireSlider' }));
        body.appendChild(sliderRow('wireMaxPx', 'Thick', WIRE_MAX_PX_RANGE, 0.1,
          'Maximum wire half-width in pixels (also the constant width when Thick to Thin is off)',
          { attr: 'wireSlider' }));
      });

    // --- Intersections section ---
    makeSection('intersect', 'intersections', 'Intersections',
      'Draw light grey lines where meshes intersect each other', (body) => {
        body.appendChild(colorRow('intersectColor', 'Color',
          'Intersection line core color (the soft rim stays as-is)'));
      });

    // --- Hidden Line (plain per-mode checkbox, not a collapsible section) ---
    {
      const row = document.createElement('label');
      row.className = 'topbar-menu-check';
      row.dataset.shadePref = 'hiddenLine';
      row.title = 'Hide wires + cage behind geometry (off = see the full mesh through it). Per shading mode.';
      const box = document.createElement('input');
      box.type = 'checkbox';
      hiddenLineBox = box;
      box.checked = shadePrefs.hiddenLine[this.renderer.shadingMode];
      box.addEventListener('change', () => {
        shadePrefs.hiddenLine[this.renderer.shadingMode] = box.checked;
        saveShadePrefs();
      });
      const text = document.createElement('span');
      text.textContent = 'Hidden Line';
      row.append(box, text);
      root.appendChild(row);
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
