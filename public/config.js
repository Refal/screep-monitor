// Load-time URL flags: ?demo=1 and ?theme=light|dark.

// ?demo=1 renders synthetic data with no Firestore — for local layout checks.
// ?theme=light|dark forces a theme (same override the viewer's OS would set).
export const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

export const DEMO = params.has("demo");

export const themeOverride = params.get("theme");
