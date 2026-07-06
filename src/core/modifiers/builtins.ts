/**
 * Built-in modifier registrations. Importing this module once (from main.ts)
 * runs each modifier file for its side-effect registerModifier() call. Exports
 * nothing — it exists purely to pull the concrete modifiers into the bundle.
 */
import './mirror';
import './array';
import './subsurf';
