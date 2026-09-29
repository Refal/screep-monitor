// Tiny DOM/format helpers used everywhere.

export const $ = id => document.getElementById(id);

export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const fmtInt = new Intl.NumberFormat("en");

export function setStatus(text) { $("status").textContent = text; }

export const sleep = ms => new Promise(r => setTimeout(r, ms));
