import { createGlContext } from './render/gl/context';
import { Renderer } from './render/Renderer';
import { Scene } from './core/scene/Scene';
import { OrbitCamera } from './camera/OrbitCamera';
import { UndoStack } from './core/undo/UndoStack';
import { makeCube } from './core/mesh/primitives';
import { cameraTransformFromView, quatFromBasis } from './tools/cameraToView';
import { Vec3 } from './core/math/vec3';
import { Transform } from './core/math/transform';
import { configureRigFromCamera } from './input/InputManager';
import { cameraFovY } from './core/scene/objectData';
import { APP_VERSION } from './version';
import { InputManager } from './input/InputManager';
import { WorkspaceManager, type EditorFactory, type WorkspaceConfig } from './ui/workspace';
import { OutlinerPanel } from './ui/outliner';
import { PropertiesEditor } from './ui/propertiesEditor';
import { UVEditor } from './ui/uvEditor';
import { ShaderEditor } from './ui/shaderEditor';
import { ImageViewer } from './ui/imageViewer';
import { TimelinePane } from './ui/timeline';
import { GraphEditor } from './ui/graphEditor';
import './ui/renderTab'; // side-effect: registers the Render properties tab (UR16-3, above Object)
import './ui/modifierTab'; // side-effect: registers the Modifiers properties tab
import './ui/materialTab'; // side-effect: registers the Material properties tab (P8-3)
import './ui/lightTab'; // side-effect: registers the Light data tab (P8-1)
import './ui/cameraTab'; // side-effect: registers the Camera data tab (P8-2)
import './ui/worldTab'; // side-effect: registers the World tab (P10-4)
import './ui/textTab'; // side-effect: registers the Text data tab (UR8-2)
import { TextDriver, regenerateTextMesh } from './tools/textObject'; // UR8-2 text mesh regen
import { applyAnimation } from './core/anim/sampler';
import { initRenderEngine } from './renderEngine/init'; // F12 render engine (P8-4)
import { AnimRender } from './renderEngine/animRender'; // 🎞 Render Animation (P16-1)
import { HtmlPlaneDriver } from './tools/htmlPlaneDriver'; // UR7-1 HTML-plane playback
import './core/modifiers/builtins'; // side-effect: registers Mirror + Array modifiers
import { Topbar } from './ui/topbar';
import { Toolbar } from './ui/toolbar';
import './ui/toolbar.css';
import { HelpOverlay } from './ui/helpOverlay';
import { NPanel } from './ui/nPanel';
import { Passepartout } from './ui/passepartout';
import { CursorOverlay } from './ui/cursorOverlay';
import { OriginDots } from './ui/originDots';
import { HtmlPortals } from './ui/htmlPortals'; // UR7-3 live URL web portals
import { loadOverlayPrefs, overlays } from './render/overlayPrefs';
import { loadShadePrefs, shadePrefs } from './render/shadePrefs';
import { ShadingMenu } from './ui/shadingMenu';
import './ui/shadingMenu.css';
import { ViewportHeader } from './ui/viewportHeader';
import { Splash } from './ui/splash';
import { HintBar } from './ui/hintBar';
import { ModeChip } from './ui/modeChip';
import { AxisGizmo, viewSnap } from './ui/axisGizmo';
import { serializeScene, applySceneJson } from './io/sceneJson';
import { decodeTextureDataUrl } from './ui/materialTab';
import { Autosave } from './io/autosave';
import { RestoreToast } from './ui/restoreToast';
import { exportObj, parseObj } from './io/obj';
import { EditableMesh } from './core/mesh/EditableMesh';
import { AddObjectsCommand } from './core/undo/objectCommands';
import { createNodesApi } from './core/nodes/api';
import { sculptState } from './tools/sculptBrushes';
import type { OperatorContext } from './core/operator/Operator';
import './ui/theme.css';
import { applyStoredTheme } from './ui/themes';
import './ui/themes90s'; // side-effect: registers the six 90s themes (P10-3)

// Apply the persisted theme before any UI builds (CSS vars land on :root).
applyStoredTheme();

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const viewportWrap = canvas.parentElement as HTMLElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

const ctx = createGlContext(canvas);
const renderer = new Renderer(ctx);
// Viewport-header shading dropdown (created once; the viewport editor factory
// hands its element to whichever area hosts the 3D viewport).
const shadingMenu = new ShadingMenu(renderer);
const scene = new Scene();
// Full viewport header (mode · orientation · pivot · snap · x-ray · shading);
// wraps the shading menu and is handed to the viewport editor as its headerExtra.
const viewportHeader = new ViewportHeader(scene, shadingMenu);
const camera = new OrbitCamera();
const undo = new UndoStack();

// --- Dirty-state tracking (UR14-1 item 18) ----------------------------------
// The Save button shows a dot whenever the undo position differs from the last
// save/load. markClean() is called on boot (position 0), Save, and any full
// scene replacement (load/restore) — all points where the file becomes the
// source of truth. The frame loop compares undo.position against this snapshot.
let savedUndoPosition = undo.position;
function markClean(): void { savedUndoPosition = undo.position; }

// The classic starting scene: a cube, a camera framing the default viewport
// view, and a spot light — so the scene already has something to look at /
// render (Numpad0 through the camera, F12) the moment it opens.
const cube = scene.add('Cube', makeCube());
const startCamera = scene.addCamera('Camera');
startCamera.transform = cameraTransformFromView(camera.eye, camera.forward, Vec3.Z);
const spot = scene.addLight('Spot', 'spot');
const spotPos = new Vec3(4, -4, 6); // upper-front-right, Blender-ish key light
spot.transform = cameraTransformFromView(spotPos, spotPos.scale(-1).normalize(), Vec3.Z);
scene.selectOnly(cube.id);

const opCtx: OperatorContext = {
  scene,
  camera,
  undo,
  viewportSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
  setStatus: (text) => { statusEl.textContent = text; },
};

// --- Autosave + crash restore (P6-4) ---------------------------------------
// Snapshot the pristine default scene (single Cube + default camera) NOW, before
// anything can mutate it — the boot prompt only fires when a stored autosave
// differs from this. The Autosave instance owns the 30s interval + save-on-hidden.
const pristineScene = serializeScene(scene, camera);
const autosave = new Autosave({ serialize: () => serializeScene(scene, camera) });

// --- Scene save / load (P3-2) ----------------------------------------------
/** Download the current scene as a .vibe.json file. */
function saveScene(): void {
  const json = serializeScene(scene, camera);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scene.vibe.json';
  a.click();
  URL.revokeObjectURL(url);
  // The file is now the source of truth — drop the crash-restore autosave.
  autosave.clear();
  markClean();
  opCtx.setStatus('Saved scene.vibe.json');
}

/** UR16-4: eagerly decode every image material's texImage after a scene load so
 *  the F12/GPU tracers (which read the decoded pixels / atlas) show image + emit
 *  planes' images WITHOUT waiting for the material tab to be opened. The Rendered
 *  viewport uploads the data URL straight to GL and never needs this; before this,
 *  a freshly loaded emit image plane path-traced pure WHITE until it was selected. */
function decodeLoadedTextures(): void {
  for (const m of scene.materials) {
    if (m.texKind === 'image' && m.texDataUrl && !m.texImage) {
      const url = m.texDataUrl;
      decodeTextureDataUrl(url)
        .then((img) => { if (m.texDataUrl === url) m.texImage = img; })
        .catch(() => { /* tracer falls back to white — Rendered viewport unaffected */ });
    }
  }
}

/** Apply a saved scene string: exit edit mode, replace scene, drop undo history. */
function loadSceneJson(json: string): void {
  if (scene.editMode) scene.exitEditMode();
  applySceneJson(json, scene, camera);
  decodeLoadedTextures();
  undo.clear();
  // Loading a file replaces the working scene — the stale autosave no longer applies.
  autosave.clear();
  markClean();
  opCtx.setStatus('Loaded scene');
}

/** Prompt for a .json file and load it (thin, untested DOM plumbing). */
function openScene(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    file.text().then(
      (text) => {
        try {
          loadSceneJson(text);
        } catch (err) {
          opCtx.setStatus(`Load failed: ${(err as Error).message}`);
        }
      },
      () => opCtx.setStatus('Load failed: could not read file'),
    );
  });
  input.click();
}

// --- OBJ export / import (P3-1) ---------------------------------------------
/** Download all visible objects as a world-space Wavefront .obj file. */
function exportObjFile(): void {
  const text = exportObj(scene);
  const blob = new Blob([text], { type: 'model/obj' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scene.obj';
  a.click();
  URL.revokeObjectURL(url);
  opCtx.setStatus('Exported scene.obj');
}

/**
 * Apply a .obj string: parse it, add each object with identity transform (verts
 * are already world-space), select them (last = active), and push ONE undoable
 * AddObjectsCommand for the whole import. Throws on malformed input.
 */
function importObjText(text: string): void {
  const parsed = parseObj(text);
  const added = parsed.map((o) => scene.add(o.name, EditableMesh.fromData(o.positions, o.faces)));
  scene.selection.clear();
  for (const obj of added) scene.selection.add(obj.id);
  scene.activeId = added.at(-1)?.id ?? null;
  undo.push(new AddObjectsCommand('Import OBJ', scene, added));
  opCtx.setStatus(`Imported ${added.length} object${added.length === 1 ? '' : 's'}`);
}

/** Prompt for a .obj file and import it (thin, untested DOM plumbing). */
function importObjFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.obj';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    file.text().then(
      (text) => {
        try {
          importObjText(text);
        } catch (err) {
          opCtx.setStatus(`Import failed: ${(err as Error).message}`);
        }
      },
      () => opCtx.setStatus('Import failed: could not read file'),
    );
  });
  input.click();
}

// Shortcut cheat-sheet (F1 / "?" button). Mounted on <body> so it covers the
// whole window while open; InputManager swallows the keyboard while it is up.
const helpOverlay = new HelpOverlay(document.body);

// Viewport N-panel (P6-2): a slim Item sidebar overlaid on the viewport's right
// edge, toggled with N. Lives inside #viewport-wrap, not a workspace area.
const nPanel = new NPanel(viewportWrap, scene, undo, camera, renderer);

// Passepartout (P10-2): darkens the viewport outside the 16:9 render frame while
// looking through a camera. Driven from the frame loop (like the panels below).
const passepartout = new Passepartout(viewportWrap, renderer, canvas, scene);

// 3D cursor marker (P12): DOM overlay projected from scene.cursor every frame.
const cursorOverlay = new CursorOverlay(viewportWrap, scene, camera, renderer, canvas);

// Overlay prefs (P12-2): restore persisted grid/origin/icon/frustum/cursor
// toggles before the first frame so the initial render honors them, and sync
// the cursor marker's visibility to the stored pref.
loadOverlayPrefs();
loadShadePrefs();
cursorOverlay.visible = overlays.cursor3d;

// Origin dots (P12-2): small orange dot at each selected object's world origin.
const originDots = new OriginDots(viewportWrap, scene, camera, renderer, canvas);

// UR7-3: live URL web portals — one <iframe> per URL plane, overlaid inside
// #viewport-wrap and transform-matched to its plane every frame. Ticked below.
const htmlPortals = new HtmlPortals(viewportWrap, scene, camera, renderer, canvas);

const inputManager = new InputManager(canvas, opCtx, renderer, { save: saveScene, open: openScene }, helpOverlay, nPanel);

// Viewport tool palette (UR3-1): Blender's left-edge T-toolbar. Mode-aware,
// lives inside #viewport-wrap; updated in the frame loop below.
const toolbar = new Toolbar(viewportWrap, scene, undo, inputManager, opCtx.setStatus);

// Modal-key hint bar (UR14-1 item 1) now lives in the full-width bottom status
// bar (#statusbar), left segment; the running version pins to its right.
const statusbar = document.getElementById('statusbar') as HTMLElement;
const hintBar = new HintBar(statusbar, scene, inputManager);
const versionEl = document.createElement('span');
versionEl.id = 'statusbar-version';
versionEl.textContent = `Vibe Blender v${APP_VERSION}`;
statusbar.appendChild(versionEl);
// The mode chip stays a viewport overlay (item 15), re-read state every frame.
const modeChip = new ModeChip(viewportWrap, scene, renderer);

// Orientation gizmo (UR14-4 item 14): top-right axis widget that tracks the
// camera and snaps the view on click. Ticked in the frame loop below.
const axisGizmo = new AxisGizmo(viewportWrap, camera);

// F12 render engine (P8-4): owns its own keydown listener + result window.
// Browsers reserve F12 for devtools, so the topbar Render button drives the
// same toggle through the returned controls.
const renderEngine = initRenderEngine({ scene, camera, setStatus: opCtx.setStatus, host: document.body });

// UR7-1: HTML-plane playback — re-rasterizes animated pages on scrub/playback/
// free-preview, and drives deterministic per-frame rasters for Ctrl+F12. Ticked
// in the frame loop below. Passed the renderer so Ctrl+F12's viewport engine can
// await the GL texture upload too.
const htmlDriver = new HtmlPlaneDriver(scene, renderer);

// UR8-2: text-object mesh regeneration — rebuilds each text object's mesh from
// its payload whenever the payload changes (incl. a sampled text.thickness).
const textDriver = new TextDriver(scene);

// 🎞 Render Animation (P16-1): frame loop → WebM / PNG-zip, modal + Ctrl+F12.
const animRender = new AnimRender({
  scene, camera, renderer, gl: ctx.gl, canvas,
  setStatus: opCtx.setStatus, host: document.body,
  htmlDriver,
});

// First-visit splash inside #viewport-wrap. It auto-dismisses on the first canvas
// pointer event or any key (listeners below); dismiss() is idempotent so these
// fire harmlessly for the rest of the session.
const splash = new Splash(viewportWrap);
const dismissSplash = (): void => splash.dismiss();
canvas.addEventListener('pointerdown', dismissSplash);
window.addEventListener('keydown', dismissSplash);

// Idle hint sitting beside the status readout — a persistent nudge toward the
// shortcut sheet. Kept out of #status so it never collides with tool status text.
const idleHint = document.createElement('div');
idleHint.id = 'idle-hint';
idleHint.textContent = 'F1 — shortcuts';
viewportWrap.append(idleHint);

// --- ?scene=<url> deep link -------------------------------------------------
// Loads a scene file served relative to the app (e.g. ?scene=research/donut.
// vibe.json under the dev server). Skips the autosave-restore prompt: an
// explicit deep link IS the chosen scene. Fetch failures fall through to a
// normal boot with a status message.
// ?shading=<mode> and ?ao=1|0 deep links — set the viewport look at boot
// (screenshots, demos, e2e captures). Not persisted: a link expresses a view,
// not a preference change.
const bootParams = new URLSearchParams(location.search);
const shadingParam = bootParams.get('shading');
if (shadingParam === 'matcap' || shadingParam === 'wireframe'
  || shadingParam === 'studio' || shadingParam === 'rendered') {
  renderer.shadingMode = shadingParam;
}
const aoParam = bootParams.get('ao');
if (aoParam !== null) shadePrefs.ao = aoParam !== '0';
// ?aomode=screen|object and ?aomethod=0..5 — pick the AO estimator at boot.
const aoModeParam = bootParams.get('aomode');
if (aoModeParam === 'screen' || aoModeParam === 'object') shadePrefs.aoMode = aoModeParam;
const aoMethodParam = bootParams.get('aomethod');
if (aoMethodParam !== null && /^[0-5]$/.test(aoMethodParam)) shadePrefs.aoMethod = Number(aoMethodParam);

const sceneParam = bootParams.get('scene');
if (sceneParam) {
  fetch(sceneParam)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((text) => {
      loadSceneJson(text);
      opCtx.setStatus(`Loaded ${sceneParam.split('/').pop()}`);
    })
    .catch((err) => opCtx.setStatus(`Scene link failed: ${(err as Error).message}`));
}

// Crash-restore prompt: if a stored autosave exists and differs from the pristine
// default scene, offer to restore it. Mounted on <body> (non-blocking — see
// theme.css) so it coexists with the splash without racing its dismissal.
const storedAutosave = autosave.load();
if (!sceneParam && storedAutosave && storedAutosave.scene !== pristineScene) {
  new RestoreToast(document.body, {
    onRestore: () => {
      try {
        if (scene.editMode) scene.exitEditMode();
        applySceneJson(storedAutosave.scene, scene, camera);
        decodeLoadedTextures();
        undo.clear();
        markClean();
        opCtx.setStatus('Restored previous session');
      } catch (err) {
        opCtx.setStatus(`Restore failed: ${(err as Error).message}`);
      }
    },
    onDiscard: () => {
      autosave.clear();
      opCtx.setStatus('Discarded autosave');
    },
  });
}
autosave.start();

// --- Workspaces (P4-1) -------------------------------------------------------
// The screen is a grid of areas, each hosting a switchable editor. The 3D
// viewport is a singleton editor wrapping #viewport-wrap (the WebGL canvas
// survives reparenting); panels are created fresh per area.
const editorFactories: EditorFactory[] = [
  {
    type: 'viewport',
    title: '3D Viewport',
    singleton: true,
    // Full Blender-style viewport header (mode · orientation · pivot · snap ·
    // x-ray · shading), spanning the area header and travelling with the editor.
    create: () => ({
      element: viewportWrap,
      headerExtra: viewportHeader.element,
      update: () => viewportHeader.update(),
    }),
  },
  {
    type: 'outliner',
    title: 'Outliner',
    create: () => {
      const panel = new OutlinerPanel(scene, undo);
      return wrapPanel('Outliner', panel);
    },
  },
  {
    type: 'properties',
    title: 'Properties',
    create: () => {
      const editor = new PropertiesEditor({ scene, undo, setStatus: opCtx.setStatus });
      // UR14-3 item 3: the panel header names the active tab ("Properties · Material").
      return wrapPanel(() => `Properties · ${editor.activeTitle}`, editor);
    },
  },
  {
    type: 'uv',
    title: 'UV Editor',
    create: () => new UVEditor({ scene, undo }),
  },
  {
    type: 'shader',
    title: 'Shader Editor',
    create: () => new ShaderEditor({ scene, undo }),
  },
  {
    type: 'image',
    title: 'Image Viewer',
    create: () => new ImageViewer({ scene }),
  },
  {
    type: 'timeline',
    title: 'Timeline',
    create: () => new TimelinePane({ scene }),
  },
  {
    type: 'graph',
    title: 'Graph Editor',
    create: () => new GraphEditor({ scene, undo }),
  },
];

/** Adapt a Panel (element + update) into an editor instance with a title bar.
 *  `title` may be a live thunk (UR14-3 item 3: Properties names its active tab),
 *  refreshed each frame in update() — cheap, only rewrites on change. */
function wrapPanel(title: string | (() => string), panel: { element: HTMLElement; update(): void }) {
  const el = document.createElement('div');
  el.className = 'wsp-panel-host';
  const h = document.createElement('h3');
  h.className = 'panel-title';
  const readTitle = typeof title === 'function' ? title : () => title;
  h.textContent = readTitle();
  el.append(h, panel.element);
  return {
    element: el,
    update: () => {
      panel.update();
      const t = readTitle();
      if (h.textContent !== t) h.textContent = t;
    },
  };
}

const DEFAULT_WORKSPACES: WorkspaceConfig[] = [
  {
    name: 'Layout',
    columns: [
      // Timeline docked under the viewport (Blender's default), bottom 20%.
      { size: 0.78, areas: [{ editor: 'viewport', size: 0.8 }, { editor: 'timeline', size: 0.2 }] },
      { size: 0.22, areas: [{ editor: 'outliner', size: 0.38 }, { editor: 'properties', size: 0.62 }] },
    ],
  },
  {
    name: 'Modeling',
    columns: [
      { size: 0.84, areas: [{ editor: 'viewport', size: 1 }] },
      { size: 0.16, areas: [{ editor: 'properties', size: 1 }] },
    ],
  },
  // NOTE: a dedicated 'UV Editing' workspace is intentionally NOT added — the
  // frozen workspace e2e asserts exactly two tabs. The 'UV Editor' is reachable
  // from any area's editor dropdown instead (like switching any editor type).
];

const workspaceRoot = document.getElementById('workspace-root') as HTMLElement;
const workspaces = new WorkspaceManager(workspaceRoot, editorFactories, DEFAULT_WORKSPACES);

// The header bar fills #topbar and is updated directly in the frame loop
// alongside workspaces.update().
const topbar = new Topbar(scene, {
  saveScene, openScene,
  exportObj: exportObjFile,
  importObj: importObjFile,
  toggleHelp: () => helpOverlay.toggle(),
  toggleRender: () => renderEngine.toggle(),
  toggleRenderAnimation: () => animRender.toggle(),
  undo: () => { const n = undo.undo(); opCtx.setStatus(n ? `Undo: ${n}` : 'Nothing to undo'); },
  redo: () => { const n = undo.redo(); opCtx.setStatus(n ? `Redo: ${n}` : 'Nothing to redo'); },
}, cursorOverlay);
topbar.mountTabs(workspaces.createTabs());

// Debug/test handle (used by e2e smoke tests; harmless in production).
// __app.io exposes the same serialize/apply the buttons use, for e2e.
(window as unknown as Record<string, unknown>).__app = {
  scene, camera, undo, renderer, workspaces, nPanel, cursorOverlay, originDots, shadePrefs,
  input: inputManager,
  htmlDriver,
  // UR14-1 status & hints handles for e2e (text without pixel reads).
  hints: {
    bar: () => hintBar.hintText(),
    chip: () => modeChip.chipText(),
    dirty: () => undo.position !== savedUndoPosition,
  },
  // UR14-4 orientation gizmo handle for e2e: client-space ball centers (for a
  // real click on an axis) + whether a snap tween is in flight.
  gizmo: {
    ball: (key: string) => axisGizmo.ballClientPos(key),
    snapping: () => viewSnap.animating,
  },
  // UR15-1 viewport raytraced-mode handle for e2e: sample count + engine + probe.
  viewportRay: {
    spp: () => renderer.viewportRay.spp,
    engine: () => renderer.viewportRay.engine,
    converged: () => renderer.viewportRay.converged,
    gpuAvailable: () => renderer.viewportRay.gpuAvailable,
    gpuReason: () => renderer.viewportRay.gpuReason,
  },
  // UR8-2 text handle for e2e: force a synchronous mesh rebuild (no RAF wait)
  // and apply-a-frame-then-sync (for keyed text.thickness scrub checks).
  text: {
    driver: textDriver,
    sync: () => textDriver.syncAll(),
    regenerate: (id: number) => { const o = scene.get(id); if (o) regenerateTextMesh(o); },
    setFrame: (f: number) => { scene.frameCurrent = f; applyAnimation(scene, f); textDriver.syncAll(); },
  },
  // UR11-1 curve handle for e2e: inspect + drive curve edit without pixel picks.
  curve: {
    editing: () => scene.curveEdit !== null,
    pointCount: () => (scene.curveEditObject?.curve ?? scene.activeObject?.curve)?.points.length ?? -1,
    selectPoint: (i: number) => {
      const sel = scene.curveEdit;
      if (!sel) return;
      sel.points.clear();
      sel.handles.clear();
      sel.points.add(i);
      sel.touch();
    },
    selectedPoints: () => (scene.curveEdit ? [...scene.curveEdit.points] : []),
    pointCo: (i: number) => (scene.curveEditObject?.curve ?? scene.activeObject?.curve)?.points[i]?.co ?? null,
    cyclic: () => (scene.curveEditObject?.curve ?? scene.activeObject?.curve)?.cyclic ?? null,
  },
  nodes: createNodesApi({ scene, undo }),
  animRender: {
    render: (opts: Parameters<typeof animRender.render>[0]) => animRender.render(opts),
    cancel: () => animRender.cancel(),
    open: () => animRender.openModal(),
    close: () => animRender.closeModal(),
    isRunning: () => animRender.isRunning,
  },
  autosave: {
    saveNow: () => autosave.saveNow(),
    clear: () => autosave.clear(),
  },
  // Active sculpt brush ('none' when not sculpting) — e2e hook (the sculpt name
  // used to live in the topbar chip, now moved out; see viewportHeader).
  sculpt: () => sculptState.tool,
  io: {
    serialize: () => serializeScene(scene, camera),
    apply: (json: string) => loadSceneJson(json),
    exportObj: () => exportObj(scene),
    importObj: (text: string) => importObjText(text),
  },
};

// --- Camera view input sync -------------------------------------------------
// While looking through a camera (Numpad0), the renderer draws from that camera
// (Renderer.resolveView), but every input path — picking, the 3D cursor, and
// G/R/S transforms — unprojects through `camera` (the OrbitCamera). Without this
// they disagree the moment the user has orbited away from the camera: the cursor
// lands nowhere near the mouse and moves don't follow it. Sync the OrbitCamera's
// pose + effective FOV to the active camera's frame each tick so they agree.
// The render ignores `camera` in camera view, so this has NO visual effect on
// the image — only on input. Navigation never orbits `camera` while in camera
// view (it flies the camera or exits first — see InputManager), so we never
// fight the user; we save/restore only the FOV so exiting keeps the user's lens.
let camViewPrevId: number | null = null;
let camViewSavedFovY = camera.fovY;
function syncInputCameraToView(): void {
  const id = renderer.cameraViewId;
  if (id !== camViewPrevId) {
    if (id !== null && camViewPrevId === null) camViewSavedFovY = camera.fovY; // entering
    else if (id === null) camera.fovY = camViewSavedFovY;                      // exiting
    camViewPrevId = id;
  }
  if (id === null) return;
  const camObj = scene.get(id);
  if (!camObj || camObj.kind !== 'camera' || !camObj.camera) return;
  // Pose from the central world matrix (respects parenting + Look At), so input
  // aims exactly like the through-camera view.
  const m = scene.cameraWorldMatrix(camObj).m;
  const pos = new Vec3(m[12], m[13], m[14]);
  const rot = quatFromBasis(new Vec3(m[0], m[1], m[2]), new Vec3(m[4], m[5], m[6]), new Vec3(m[8], m[9], m[10]));
  configureRigFromCamera(camera, new Transform(pos, rot));
  // Effective vertical FOV so OrbitCamera.projMatrix(canvasAspect) matches the
  // renderer's letterboxed camera frame (cameraFrameProjMatrix) — pointer rays
  // then line up with the rendered frame exactly, letterbox/pillarbox included.
  const rs = scene.renderSettings;
  const canvasAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const renderAspect = rs.height > 0 ? rs.width / rs.height : canvasAspect;
  const sy = renderAspect > canvasAspect ? canvasAspect / renderAspect : 1;
  camera.fovY = 2 * Math.atan(Math.tan(cameraFovY(camObj.camera) / 2) / sy);
}

function frame(): void {
  htmlDriver.tick();
  textDriver.tick();
  syncInputCameraToView();
  renderer.render(scene, camera);
  workspaces.update();
  topbar.update();
  topbar.setDirty(undo.position !== savedUndoPosition);
  toolbar.update();
  hintBar.update();
  modeChip.update();
  axisGizmo.update();
  nPanel.update();
  passepartout.update();
  cursorOverlay.update();
  originDots.update();
  htmlPortals.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
