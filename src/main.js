import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { openPath } from '@tauri-apps/plugin-opener';
import configuredFolders from '../config/folders.json';

const state = { panes: [{ tabs: [], activeTab: 0, selected: null }, { tabs: [], activeTab: 0, selected: null }], activePane: 0, showHidden: false, editing: null, folders: [], contextMenu: null };
const stored = JSON.parse(localStorage.getItem('rove-state') || '{}');
const session = JSON.parse(localStorage.getItem('rove-session') || '{}');
const DOUBLE_CLICK_MS = 400;
let lastEntryClick = { id: null, time: 0 };
let entryClickTimer = null;
let lastWatchedKey = '';
const fsChangeTimers = new Map();
function normalizePath(path) { return path.replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase(); }

function currentTab(pane) { return pane.tabs[pane.activeTab]; }
function extension(name) { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot) : '—'; }
function displayName(name) { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(0, dot) : name; }
function icon(kind) { return kind === 'folder' || kind === 'drive' ? '<span class="folder-icon">▰</span>' : '<span class="file-icon">·</span>'; }
function escapeAttribute(value) { return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function folderIcon(path) { const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() || ''; return ['pictures', 'documents', 'downloads', 'desktop', 'music'].includes(name) ? name : 'folder'; }
function folderLabel(path) { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Home'; }
async function resolveFolderPath(path) { return path.startsWith('~') ? `${await homeDir()}${path.slice(1).replaceAll('/', '\\')}` : path; }
function remember(path, name) { stored[path] = { name, time: Date.now() }; localStorage.setItem('rove-state', JSON.stringify(stored)); }
function saveSession() { localStorage.setItem('rove-session', JSON.stringify({ panes: state.panes.map((pane) => ({ activeTab: pane.activeTab, selected: pane.selected, tabs: pane.tabs.map(({ path, label }) => ({ path, label })) })) })); }
function isEditing(index, entry) { return state.editing?.pane === index && state.editing.entryId === entry.id; }

async function load(path) {
  const entries = await invoke('read_directory', { path, showHidden: state.showHidden });
  return entries.map((entry) => ({ ...entry, id: entry.path, extension: entry.kind === 'file' ? extension(entry.name) : '—', displayName: entry.kind === 'file' ? displayName(entry.name) : entry.name }));
}

async function loadDrives() { return (await invoke('list_drives')).map((entry) => ({ ...entry, id: entry.path, displayName: entry.name, extension: '—' })); }

function render() {
  const activeTab = currentTab(state.panes[state.activePane]);
  const pathValue = activeTab?.path || '';
  const toolbar = state.folders.map((folder) => `<button class="quick-folder" data-folder-path="${escapeAttribute(folder.path)}" title="Open ${escapeAttribute(folder.path)}"><img src="/folder-icons/${folderIcon(folder.path)}.svg" alt=""><span>${escapeAttribute(folder.label)}</span></button>`).join('');
  document.querySelector('#app').innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">R</span><span>ROVE</span><small>FILE EXPLORER</small></div><input class="location-input" id="location-input" value="${escapeAttribute(pathValue)}" placeholder="Enter a folder path" aria-label="Current folder path"><label class="hidden-toggle"><input type="checkbox" id="hidden-toggle" ${state.showHidden ? 'checked' : ''}><span>Show hidden</span></label></header><main class="workspace"><nav class="folder-toolbar" aria-label="Favorite folders">${toolbar}</nav><section class="panes" aria-label="File panes">${state.panes.map(renderPane).join('')}</section></main><footer class="footer"><span><kbd>Enter</kbd> open <kbd>Backspace</kbd> up a level <kbd>Delete</kbd> send to recycle bin</span><span>${state.panes.some((pane) => pane.tabs.length) ? 'Changes persist locally' : 'Select a folder to begin'}</span></footer>${renderContextMenu()}`;
  bindEvents();
  const selectedRow = document.querySelector(`.pane[data-pane="${state.activePane}"] .file-row.selected`);
  selectedRow?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncWatchedPaths();
}

function syncWatchedPaths() {
  const paths = [...new Set(state.panes.map((pane) => currentTab(pane)?.path).filter(Boolean))];
  const key = [...paths].sort().join('|');
  if (key === lastWatchedKey) return;
  lastWatchedKey = key;
  invoke('set_watched_paths', { paths }).catch((error) => console.error('set_watched_paths failed', error));
}

function scheduleFolderReload(changedPath) {
  const key = normalizePath(changedPath);
  clearTimeout(fsChangeTimers.get(key));
  fsChangeTimers.set(key, setTimeout(async () => {
    fsChangeTimers.delete(key);
    let changed = false;
    for (const pane of state.panes) {
      const tab = currentTab(pane);
      if (!tab?.path || normalizePath(tab.path) !== key) continue;
      const selectedName = tab.entries.find((entry) => entry.id === pane.selected)?.name;
      tab.entries = await load(tab.path);
      pane.selected = selectedName ? tab.entries.find((entry) => entry.name === selectedName)?.id || null : pane.selected;
      changed = true;
    }
    if (changed) { saveSession(); render(); }
  }, 200));
}

function renderContextMenu() {
  if (!state.contextMenu) return '';
  const { x, y } = state.contextMenu;
  return `<div class="context-menu" data-context-menu style="left:${x}px; top:${y}px"><button class="danger" data-context-delete>Delete</button></div>`;
}

function renderPane(pane, index) {
  const tab = currentTab(pane); const entries = tab?.entries || []; const selected = pane.selected; const isDriveRoot = tab?.kind === 'drives';
  const headers = isDriveRoot ? '<span>NAME</span><span>TOTAL SIZE</span><span>FREE SPACE</span><span>FILE SYSTEM</span>' : '<span>NAME</span><span>EXTENSION</span><span>SIZE</span><span>MODIFIED</span>';
  const rows = entries.map((entry, entryIndex) => { const editing = isEditing(index, entry); const name = editing ? `<input class="rename-input" data-rename value="${escapeAttribute(entry.name)}" aria-label="Rename folder">` : `<strong>${entry.displayName}</strong>`; return `<button class="file-row ${isDriveRoot ? 'drive-row' : ''} ${selected === entry.id ? 'selected' : ''}" data-entry="${entry.id}" data-index="${entryIndex}"><span class="file-name">${icon(entry.kind)}${name}</span><span>${isDriveRoot ? entry.total : entry.extension}</span><span>${isDriveRoot ? entry.free : entry.size}</span><span>${isDriveRoot ? entry.fileSystem : (entry.modified === '—' ? '—' : new Date(Number(entry.modified) * 1000).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }))}</span></button>`; }).join('') || '<div class="empty-state"><span>⌁</span><strong>This folder is empty</strong><small>Choose another location to keep moving.</small></div>';
  return `<article class="pane ${state.activePane === index ? 'is-active' : ''}" data-pane="${index}"><div class="tabs">${pane.tabs.map((item, tabIndex) => `<button class="tab ${tabIndex === pane.activeTab ? 'active' : ''}" data-tab="${tabIndex}"><span class="tab-dot"></span>${item.label}<span class="tab-close">×</span></button>`).join('')}<button class="new-tab" data-new-tab title="New tab">＋</button></div><div class="pathbar"><button class="nav-button" data-up title="Go up one level" aria-label="Go up one level">↑</button><button class="path-text" data-root-path>${tab?.path || 'This PC'}</button><span class="item-count">${entries.length} ITEMS</span></div><div class="table-wrap"><div class="table-head ${isDriveRoot ? 'drive-head' : ''}">${headers}</div><div class="rows">${rows}</div></div><div class="pane-footer"><span class="selection-label">${selected ? '1 SELECTED' : 'NOTHING SELECTED'}</span><span>${index === 0 ? 'LEFT PANE' : 'RIGHT PANE'}</span></div></article>`;
}

async function navigatePath(path) {
  const pane = state.panes[state.activePane]; const tab = currentTab(pane); const normalized = path.trim();
  if (!tab || !normalized) return;
  const entries = await load(normalized);
  tab.path = normalized; tab.kind = 'folder'; tab.label = normalized.split(/[\\/]/).filter(Boolean).pop() || normalized; tab.entries = entries;
  pane.selected = stored[normalized]?.name ? entries.find((entry) => entry.name === stored[normalized].name)?.id || null : null;
  saveSession(); render();
}

function startRename(index, entry) { state.activePane = index; state.editing = { pane: index, entryId: entry.id, original: entry.name }; render(); const input = document.querySelector('[data-rename]'); input?.focus(); input?.select(); }

function cancelRename() { state.editing = null; render(); }

async function finishRename(index, entry, value) {
  if (!entry) { cancelRename(); return; }
  const newName = value.trim();
  if (!newName || newName === entry.name || /[\\/:*?"<>|]/.test(newName)) { cancelRename(); return; }
  state.editing = null;
  await invoke('rename_entry', { path: entry.path, newName });
  const pane = state.panes[index]; const tab = currentTab(pane); tab.entries = await load(tab.path); pane.selected = tab.entries.find((item) => item.name === newName)?.id || null; saveSession(); render();
}

async function deleteEntry(index, entry) {
  if (!entry || entry.kind === 'drive') return;
  const pane = state.panes[index]; const tab = currentTab(pane);
  await invoke('delete_entry', { path: entry.path });
  tab.entries = await load(tab.path);
  if (pane.selected === entry.id) pane.selected = null;
  state.contextMenu = null;
  saveSession(); render();
}

function deleteSelected(index) {
  const pane = state.panes[index]; const tab = currentTab(pane);
  const entry = tab?.entries.find((item) => item.id === pane.selected);
  if (entry) deleteEntry(index, entry);
}

async function enter(paneIndex, entry) {
  if (!entry) return;
  const pane = state.panes[paneIndex]; const tab = currentTab(pane); remember(tab.path, entry.name);
  if (entry.kind === 'drive' || entry.kind === 'folder') { tab.path = entry.path; tab.kind = entry.kind === 'drive' ? 'folder' : 'folder'; tab.label = entry.displayName; tab.entries = await load(entry.path); pane.selected = stored[entry.path]?.name ? tab.entries.find((child) => child.name === stored[entry.path].name)?.id || null : null; saveSession(); render(); } else { try { await openPath(entry.path); } catch (error) { console.error('openPath failed', entry.path, error); } }
}

async function goUp(index) { const pane = state.panes[index]; const tab = currentTab(pane); if (!tab || !tab.path) return; const trimmed = tab.path.replace(/[\\/]+$/, ''); let parent = /^[A-Za-z]:$/.test(trimmed) || trimmed === '' ? '' : trimmed.replace(/[\\/][^\\/]+$/, '') || ''; if (/^[A-Za-z]:$/.test(parent)) parent += '\\'; if (!parent) { tab.path = ''; tab.kind = 'drives'; tab.label = 'This PC'; tab.entries = await loadDrives(); } else { tab.path = parent; tab.kind = 'folder'; tab.label = parent.split(/[\\/]/).filter(Boolean).pop() || parent; tab.entries = await load(parent); } pane.selected = null; saveSession(); render(); }

function moveSelection(index, direction) { const pane = state.panes[index]; const entries = currentTab(pane)?.entries || []; if (!entries.length) return; const current = entries.findIndex((entry) => entry.id === pane.selected); const next = current < 0 ? (direction > 0 ? 0 : entries.length - 1) : Math.max(0, Math.min(entries.length - 1, current + direction)); pane.selected = entries[next].id; if (currentTab(pane).path) remember(currentTab(pane).path, entries[next].name); saveSession(); render(); }

function bindEvents() {
  document.querySelectorAll('[data-folder-path]').forEach((button) => button.addEventListener('click', async () => { try { await navigatePath(await resolveFolderPath(button.dataset.folderPath)); } catch { button.classList.add('is-unavailable'); } }));
  document.querySelectorAll('.pane').forEach((element) => { const index = Number(element.dataset.pane); const pane = state.panes[index]; element.addEventListener('click', () => { state.activePane = index; render(); });
    element.querySelectorAll('[data-entry]').forEach((row) => {
      let suppressNextClick = false;
      const activate = (event) => {
        event.stopPropagation();
        const entry = currentTab(pane).entries[Number(row.dataset.index)];
        state.activePane = index;
        if (state.editing) return;
        const now = Date.now();
        const isDoubleClick = lastEntryClick.id === entry.id && now - lastEntryClick.time < DOUBLE_CLICK_MS;
        lastEntryClick = { id: entry.id, time: now };
        clearTimeout(entryClickTimer);
        if (isDoubleClick) { lastEntryClick = { id: null, time: 0 }; enter(index, entry); return; }
        if (entry.kind === 'folder' && pane.selected === entry.id) {
          entryClickTimer = setTimeout(() => startRename(index, entry), DOUBLE_CLICK_MS);
        } else {
          pane.selected = entry.id; if (currentTab(pane).path) remember(currentTab(pane).path, entry.name); saveSession(); render();
        }
      };
      // pointerdown fires immediately; the derived `click` event can lag ~200ms behind it on
      // Windows precision touchpads/touchscreens while the OS gesture recognizer rules out a
      // scroll/pan. Act on pointerdown for real pointer input, and keep `click` only as a
      // fallback for keyboard-triggered activation (Tab + Enter/Space), which never fires pointerdown.
      row.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        suppressNextClick = true;
        activate(event);
      });
      row.addEventListener('click', (event) => {
        if (suppressNextClick) { suppressNextClick = false; return; }
        activate(event);
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault(); event.stopPropagation();
        if (state.editing) return;
        const entry = currentTab(pane).entries[Number(row.dataset.index)];
        if (entry.kind === 'drive') return;
        state.activePane = index;
        pane.selected = entry.id;
        if (currentTab(pane).path) remember(currentTab(pane).path, entry.name);
        state.contextMenu = { pane: index, entryId: entry.id, x: event.clientX, y: event.clientY };
        render();
      });
    });
    element.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); state.activePane = index; pane.activeTab = Number(button.dataset.tab); pane.selected = null; saveSession(); render(); }));
    element.querySelector('[data-new-tab]').addEventListener('click', async (event) => { event.stopPropagation(); const current = currentTab(pane); const path = current?.path || ''; pane.tabs.push(path ? { path, kind: 'folder', label: path.split(/[\\/]/).pop(), entries: await load(path) } : { path: '', kind: 'drives', label: 'This PC', entries: await loadDrives() }); pane.activeTab = pane.tabs.length - 1; saveSession(); render(); });
    element.querySelector('[data-up]').addEventListener('click', (event) => { event.stopPropagation(); goUp(index); });
  });
  document.querySelector('#hidden-toggle').addEventListener('change', async (event) => { state.showHidden = event.currentTarget.checked; await Promise.all(state.panes.flatMap((pane) => pane.tabs.filter((tab) => tab.path).map(async (tab) => { tab.entries = await load(tab.path); }))); render(); });
  document.querySelector('#location-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); navigatePath(event.currentTarget.value).catch(() => event.currentTarget.select()); } });
  const renameInput = document.querySelector('[data-rename]'); renameInput?.addEventListener('click', (event) => event.stopPropagation()); renameInput?.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRename(); } if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); const entry = currentTab(state.panes[state.activePane]).entries.find((item) => item.id === state.editing?.entryId); finishRename(state.activePane, entry, event.currentTarget.value).catch(() => cancelRename()); } }); renameInput?.addEventListener('blur', (event) => { const entry = currentTab(state.panes[state.activePane]).entries.find((item) => item.id === state.editing?.entryId); if (entry) finishRename(state.activePane, entry, event.currentTarget.value).catch(() => cancelRename()); });
  const contextMenu = document.querySelector('[data-context-menu]');
  contextMenu?.addEventListener('click', (event) => event.stopPropagation());
  contextMenu?.addEventListener('contextmenu', (event) => event.preventDefault());
  document.querySelector('[data-context-delete]')?.addEventListener('click', () => { const { pane, entryId } = state.contextMenu; const entry = currentTab(state.panes[pane]).entries.find((item) => item.id === entryId); deleteEntry(pane, entry); });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.contextMenu) { state.contextMenu = null; render(); return; }
  const isTyping = event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA';
  const pane = state.panes[state.activePane]; const tab = currentTab(pane);
  if (event.key === 'Delete' && !isTyping) { event.preventDefault(); deleteSelected(state.activePane); return; }
  if (isTyping) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(state.activePane, event.key === 'ArrowUp' ? -1 : 1); }
  if (event.key === 'Enter') { event.preventDefault(); enter(state.activePane, tab?.entries.find((entry) => entry.id === pane.selected)); }
  if (event.key === 'Backspace') { event.preventDefault(); goUp(state.activePane); }
});
document.addEventListener('click', (event) => {
  if (!state.contextMenu || event.target.closest('.context-menu')) return;
  state.contextMenu = null; render();
}, true);
document.addEventListener('contextmenu', (event) => { if (state.contextMenu && !event.target.closest('.context-menu')) { state.contextMenu = null; } }, true);

async function start() {
  state.folders = configuredFolders.map((path) => ({ path, label: folderLabel(path) }));
  const drives = await loadDrives();
  const savedPanes = Array.isArray(session.panes) ? session.panes : [];
  for (let index = 0; index < state.panes.length; index += 1) {
    const saved = savedPanes[index];
    const tabs = saved?.tabs?.length ? await Promise.all(saved.tabs.map(async (item) => item.path ? { ...item, kind: 'folder', entries: await load(item.path) } : { path: '', kind: 'drives', label: 'This PC', entries: drives })) : [{ path: '', kind: 'drives', label: 'This PC', entries: drives }];
    state.panes[index] = { tabs, activeTab: Math.min(saved?.activeTab || 0, tabs.length - 1), selected: saved?.selected || null };
  }
  render();
}

start().catch(() => render());
listen('fs-changed', (event) => scheduleFolderReload(event.payload));
