import { isSectionCollapsed, setSectionCollapsed } from './uiPrefs';

/**
 * UR14-3 item 9 — turn an existing `.properties-group`-style block into a
 * collapsible disclosure section (the pattern proved by the shading dropdown).
 *
 * Given the section element and its title element, this:
 *  - wraps every sibling AFTER the title into a `.properties-section-body`;
 *  - prepends a rotating caret to the title and makes it a click toggle;
 *  - restores + persists the collapsed state under `prefId` (via uiPrefs).
 *
 * The title element's existing children/text are preserved (the caret is
 * inserted before them). Input references held by callers stay valid — only the
 * DOM nesting changes, never the input elements themselves.
 */
export function makeCollapsible(section: HTMLElement, title: HTMLElement, prefId: string): void {
  if (section.dataset.collapsibleReady === '1') return;
  section.dataset.collapsibleReady = '1';

  // Move everything after the title into a body wrapper.
  const body = document.createElement('div');
  body.className = 'properties-section-body';
  let node = title.nextSibling;
  while (node) {
    const next = node.nextSibling;
    body.appendChild(node);
    node = next;
  }
  section.appendChild(body);

  // Caret + clickable header.
  const caret = document.createElement('span');
  caret.className = 'properties-section-caret';
  caret.textContent = '▾';
  title.insertBefore(caret, title.firstChild);
  title.classList.add('properties-section-header');
  title.setAttribute('role', 'button');
  title.setAttribute('tabindex', '0');

  const apply = (collapsed: boolean): void => {
    section.classList.toggle('is-collapsed', collapsed);
    body.style.display = collapsed ? 'none' : '';
    caret.textContent = collapsed ? '▸' : '▾';
    title.setAttribute('aria-expanded', String(!collapsed));
  };

  const toggle = (): void => {
    const next = !section.classList.contains('is-collapsed');
    apply(next);
    setSectionCollapsed(prefId, next);
  };

  title.addEventListener('click', toggle);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  apply(isSectionCollapsed(prefId));
}
