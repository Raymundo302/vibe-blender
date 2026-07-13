import './propRow.css';

/**
 * UR16-2 — shared two-column property row builder. Emits the DOM the
 * `propRow.css` layout expects:
 *
 *   <div class="prop-row">
 *     <button class="prop-socket"> | <span class="prop-socket-spacer">
 *     <span class="prop-row-label">Label</span>
 *     <div class="prop-row-control"> ...controls... </div>
 *   </div>
 *
 * The socket column is ALWAYS present so labels line up across rows whether or
 * not a row carries a socket circle. Pass a `socket` element (typically a
 * `<button class="prop-socket">`) to make the row socketed; omit it for a plain
 * value row (a non-interactive spacer is inserted instead).
 *
 * Kept material-agnostic on purpose — other Properties tabs adopt it in UR14-3.
 */
export interface PropRowOpts {
  label: string;
  controls: HTMLElement[];
  /** Optional socket circle button; omit for a plain (socketless) row. */
  socket?: HTMLElement;
  /** Extra class on the row element (e.g. an identifier for e2e probes). */
  rowClass?: string;
  /** data-* attributes to set on the row (e.g. { channel: 'color' }). */
  data?: Record<string, string>;
}

export function propRow(opts: PropRowOpts): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'prop-row' + (opts.rowClass ? ` ${opts.rowClass}` : '');
  if (opts.data) for (const [k, v] of Object.entries(opts.data)) row.dataset[k] = v;

  if (opts.socket) {
    row.appendChild(opts.socket);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'prop-socket-spacer';
    row.appendChild(spacer);
  }

  const label = document.createElement('span');
  label.className = 'prop-row-label';
  label.textContent = opts.label;
  row.appendChild(label);

  const control = document.createElement('div');
  control.className = 'prop-row-control';
  control.append(...opts.controls);
  row.appendChild(control);

  return row;
}

/** Build a `.prop-socket` circle button whose fill reflects the current input
 *  kind (value = empty ring, image = blue, gradient = ramp). */
export function socketButton(kind: 'value' | 'image' | 'gradient', onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'prop-socket';
  setSocketKind(btn, kind);
  btn.addEventListener('click', (e) => { e.preventDefault(); onClick(btn); });
  return btn;
}

/** Update a socket circle's fill to reflect an input kind. */
export function setSocketKind(btn: HTMLElement, kind: 'value' | 'image' | 'gradient'): void {
  btn.classList.remove('is-filled', 'is-image', 'is-gradient');
  btn.dataset.kind = kind;
  if (kind === 'image') btn.classList.add('is-filled', 'is-image');
  else if (kind === 'gradient') btn.classList.add('is-filled', 'is-gradient');
}
