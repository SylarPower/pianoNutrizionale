'use strict';
/* Smoke browser-like dell'orb: verifica il montaggio UI e la chiusura sicura
 * quando il Worker non è ancora configurato. Non apre microfono o rete. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://sylarpower.github.io/pianoNutrizionale/',
  runScripts: 'outside-only'
});
const window = dom.window;
window.PIANO_AI_CONFIG = { tokenEndpoint: '', model: 'gemini-3.1-flash-live-preview', language: 'it-IT', voiceName: 'Aoede' };
window.PianoDomain = {};
window.appState = {
  user: { email: 'mario@utenti.pianonutrizionale.app' },
  plan: null,
  recipes: [],
  recipesById: {},
  household: null,
  deviceSettings: { portionProfile: 'man' }
};
window.getPortionProfile = () => 'man';
window.MELLER_GUIDE = {};

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/assistant-domain.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/assistant-domain.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/assistant.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/assistant.js' });
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

assert.ok(window.PianoAssistant, 'API globale assistente presente');
window.PianoAssistant.setAvailability(true);
const fab = window.document.getElementById('assistant-fab');
const panel = window.document.getElementById('assistant-panel');
assert.equal(fab.classList.contains('hidden'), false, 'orb visibile con account attivo');
window.PianoAssistant.open();
assert.equal(panel.classList.contains('hidden'), false, 'pannello aperto');
assert.match(window.document.getElementById('assistant-error').textContent, /Worker/);
window.PianoAssistant.close();
assert.equal(panel.classList.contains('hidden'), true, 'pannello chiuso');
window.PianoAssistant.setAvailability(false);
assert.equal(fab.classList.contains('hidden'), true, 'orb nascosto senza account');
console.log('ASSISTANT SMOKE OK — UI montata senza microfono o rete');
