import './style.css';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir, sep } from '@tauri-apps/api/path';
import { openPath } from '@tauri-apps/plugin-opener';
import configuredFolders from '../config/folders.json';

const SEP = sep();
const isWindows = SEP === '\\';
const COMPUTER_LABEL = isWindows ? 'This PC' : 'This Mac';
const state = { panes: [{ tabs: [], activeTab: 0 }, { tabs: [], activeTab: 0 }], activePane: 0, showHidden: false, editing: null, folders: [], contextMenu: null };
const stored = JSON.parse(localStorage.getItem('rove-state') || '{}');
const session = JSON.parse(localStorage.getItem('rove-session') || '{}');
const DOUBLE_CLICK_MS = 400;
let lastEntryClick = { id: null, time: 0 };
let entryClickTimer = null;
let lastWatchedKey = '';
let scrollSelectionIntoView = false;
const fsChangeTimers = new Map();
function normalizePath(path) { return path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }

function currentTab(pane) { return pane.tabs[pane.activeTab]; }
function extension(name) { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot) : '—'; }
function displayName(name) { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(0, dot) : name; }
function icon(kind) { return kind === 'folder' || kind === 'drive' ? '<span class="folder-icon">▰</span>' : '<span class="file-icon">·</span>'; }
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.avif']);
function isImageFile(name) { return IMAGE_EXTENSIONS.has(extension(name).toLowerCase()); }
const extensionIconCache = new Map();
function fetchExtensionIcon(ext) {
  extensionIconCache.set(ext, null);
  invoke('get_extension_icon', { extension: ext }).then((dataUri) => {
    extensionIconCache.set(ext, dataUri || 'none');
    if (dataUri) document.querySelectorAll(`[data-icon-ext="${ext}"]`).forEach((el) => { el.outerHTML = `<img class="file-type-icon" src="${escapeAttribute(dataUri)}" alt="">`; });
  }).catch(() => extensionIconCache.set(ext, 'none'));
}
function renderFileIcon(entry) {
  if (entry.kind !== 'file') return icon(entry.kind);
  const ext = extension(entry.name).toLowerCase();
  const cached = extensionIconCache.get(ext);
  if (cached && cached !== 'none') return `<img class="file-type-icon" src="${escapeAttribute(cached)}" alt="">`;
  if (!extensionIconCache.has(ext)) fetchExtensionIcon(ext);
  return `<span class="file-icon" data-icon-ext="${escapeAttribute(ext)}">·</span>`;
}
function escapeAttribute(value) { return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function folderIcon(path) { const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() || ''; return ['pictures', 'documents', 'downloads', 'desktop', 'music'].includes(name) ? name : 'folder'; }
function folderLabel(path) { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Home'; }
function pathSegments(path) {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  if (!isWindows && path.startsWith('/')) {
    let acc = '';
    return parts.map((part) => { acc += `/${part}`; return { label: part, path: acc }; });
  }
  let acc = '';
  return parts.map((part, i) => {
    acc = i === 0 ? (/^[A-Za-z]:$/.test(part) ? `${part}\\` : part) : (acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`);
    return { label: part, path: acc };
  });
}
async function resolveFolderPath(path) {
  if (!path.startsWith('~')) return path;
  const rest = path.slice(1).split(/[\\/]+/).filter(Boolean);
  const home = (await homeDir()).replace(/[\\/]+$/, '');
  return [home, ...rest].join(SEP);
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function remember(path, name) { stored[path] = { name, time: Date.now() }; localStorage.setItem('rove-state', JSON.stringify(stored)); }
function saveSession() { localStorage.setItem('rove-session', JSON.stringify({ panes: state.panes.map((pane) => ({ activeTab: pane.activeTab, tabs: pane.tabs.map(({ path, label, selected }) => ({ path, label, selected })) })) })); }
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
  const canGoBack = (activeTab?.historyIndex ?? 0) > 0;
  const canGoForward = !!activeTab && activeTab.historyIndex < (activeTab.history?.length ?? 1) - 1;
  const navHistory = `<button class="nav-history-button" data-go-back title="Back" aria-label="Go back" ${canGoBack ? '' : 'disabled'}>←</button><button class="nav-history-button" data-go-forward title="Forward" aria-label="Go forward" ${canGoForward ? '' : 'disabled'}>→</button><span class="toolbar-separator" aria-hidden="true"></span>`;
  document.querySelector('#app').innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">R</span><span>ROVE</span><small>FILE EXPLORER</small></div><input class="location-input" id="location-input" value="${escapeAttribute(pathValue)}" placeholder="Enter a folder path" aria-label="Current folder path"><label class="hidden-toggle"><input type="checkbox" id="hidden-toggle" ${state.showHidden ? 'checked' : ''}><span>Show hidden</span></label></header><main class="workspace"><nav class="folder-toolbar" aria-label="Favorite folders">${navHistory}${toolbar}</nav><section class="panes" aria-label="File panes">${state.panes.map(renderPane).join('')}</section></main><footer class="footer"><span><kbd>Enter</kbd> open <kbd>Backspace</kbd> up a level <kbd>Delete</kbd> send to recycle bin</span></footer>${renderContextMenu()}`;
  bindEvents();
  if (scrollSelectionIntoView) {
    const selectedRow = document.querySelector(`.pane[data-pane="${state.activePane}"] .file-row.selected, .pane[data-pane="${state.activePane}"] .thumb-card.selected`);
    selectedRow?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    scrollSelectionIntoView = false;
  }
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
      const selectedName = tab.entries.find((entry) => entry.id === tab.selected)?.name;
      tab.entries = await load(tab.path);
      tab.selected = selectedName ? tab.entries.find((entry) => entry.name === selectedName)?.id || null : tab.selected;
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

function renderTreeNode(node, depth, treeState, isRoot) {
  const hasChildren = node.children.length > 0;
  const isExpanded = treeState.expanded.has(node.path);
  const isSelected = treeState.selected === node.path;
  const row = `<div class="tree-row ${isSelected ? 'selected' : ''}" data-tree-node="${escapeAttribute(node.path)}" style="padding-left:${depth * 18 + 12}px"><span class="tree-caret ${hasChildren ? 'has-children' : ''}" data-tree-caret>${hasChildren ? (isExpanded ? '▾' : '▸') : ''}</span><span class="tree-name">${escapeAttribute(isRoot ? node.path : node.name)}</span><span class="tree-stat">${node.fileCount.toLocaleString()} file${node.fileCount === 1 ? '' : 's'}</span><span class="tree-stat">${formatBytes(node.totalSize)}</span></div>`;
  const childrenHtml = hasChildren && isExpanded ? node.children.map((child) => renderTreeNode(child, depth + 1, treeState, false)).join('') : '';
  return row + childrenHtml;
}

function renderTreeBody(tab) {
  const treeState = tab.treeState;
  if (!treeState) return '';
  if (treeState.status === 'loading') {
    return `<div class="tree-progress"><div class="spinner" aria-hidden="true"></div><p>Scanning… ${treeState.scannedFolders.toLocaleString()} folders, ${treeState.scannedFiles.toLocaleString()} files so far</p><button class="tree-cancel" data-tree-cancel>Cancel</button></div>`;
  }
  if (treeState.status === 'error') {
    return `<div class="tree-progress"><p>Couldn't compute folder stats.</p><button class="tree-cancel" data-tree-cancel>Close</button></div>`;
  }
  if (treeState.status === 'done' && treeState.tree) {
    return `<div class="tree-rows">${renderTreeNode(treeState.tree, 0, treeState, true)}</div>`;
  }
  return '';
}

function renderThumbnails(entries, selected, index) {
  if (!entries.length) return '<div class="empty-state"><span>⌁</span><strong>This folder is empty</strong><small>Choose another location to keep moving.</small></div>';
  const cards = entries.map((entry, entryIndex) => {
    const editing = isEditing(index, entry);
    const thumb = entry.kind === 'file' && isImageFile(entry.name)
      ? `<img class="thumb-img" src="${escapeAttribute(convertFileSrc(entry.path))}" alt="" loading="lazy">`
      : icon(entry.kind);
    const label = editing
      ? `<input class="rename-input thumb-rename" data-rename value="${escapeAttribute(entry.name)}" aria-label="Rename">`
      : `<span class="thumb-name">${escapeAttribute(entry.displayName)}</span>`;
    return `<button class="thumb-card ${selected === entry.id ? 'selected' : ''}" data-entry="${entry.id}" data-index="${entryIndex}"><div class="thumb-box">${thumb}</div>${label}</button>`;
  }).join('');
  return `<div class="thumb-grid">${cards}</div>`;
}

function renderPane(pane, index) {
  const tab = currentTab(pane); const entries = tab?.entries || []; const selected = tab?.selected; const isDriveRoot = tab?.kind === 'drives';
  const view = tab?.view || 'details';
  const headers = isDriveRoot ? '<span>NAME</span><span>TOTAL SIZE</span><span>FREE SPACE</span><span>FILE SYSTEM</span>' : '<span>NAME</span><span>EXTENSION</span><span>SIZE</span><span>MODIFIED</span>';
  const rows = entries.map((entry, entryIndex) => { const editing = isEditing(index, entry); const name = editing ? `<input class="rename-input" data-rename value="${escapeAttribute(entry.name)}" aria-label="Rename">` : `<strong>${entry.displayName}</strong>`; return `<button class="file-row ${isDriveRoot ? 'drive-row' : ''} ${selected === entry.id ? 'selected' : ''}" data-entry="${entry.id}" data-index="${entryIndex}"><span class="file-name">${renderFileIcon(entry)}${name}</span><span>${isDriveRoot ? entry.total : entry.extension}</span><span>${isDriveRoot ? entry.free : entry.size}</span><span>${isDriveRoot ? entry.fileSystem : (entry.modified === '—' ? '—' : new Date(Number(entry.modified) * 1000).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }))}</span></button>`; }).join('') || '<div class="empty-state"><span>⌁</span><strong>This folder is empty</strong><small>Choose another location to keep moving.</small></div>';
  const breadcrumb = tab?.path
    ? pathSegments(tab.path).map((segment, segIndex) => `${segIndex > 0 ? '<span class="path-sep">/</span>' : ''}<button class="path-segment" data-breadcrumb="${escapeAttribute(segment.path)}">${escapeAttribute(segment.label)}</button>`).join('')
    : `<span class="path-segment path-segment-static">${COMPUTER_LABEL}</span>`;
  const body = view === 'tree'
    ? `<div class="table-wrap tree-wrap">${renderTreeBody(tab)}</div>`
    : view === 'thumbnails'
      ? `<div class="table-wrap thumb-wrap">${renderThumbnails(entries, selected, index)}</div>`
      : `<div class="table-wrap"><div class="table-head ${isDriveRoot ? 'drive-head' : ''}">${headers}</div><div class="rows">${rows}</div></div>`;
  const viewSelect = tab?.path ? `<select class="view-select" data-view-select aria-label="Pane view"><option value="details" ${view === 'details' ? 'selected' : ''}>Details</option><option value="tree" ${view === 'tree' ? 'selected' : ''}>Tree View</option><option value="thumbnails" ${view === 'thumbnails' ? 'selected' : ''}>Thumbnails</option></select>` : '';
  return `<article class="pane ${state.activePane === index ? 'is-active' : ''}" data-pane="${index}"><div class="tabs">${pane.tabs.map((item, tabIndex) => `<button class="tab ${tabIndex === pane.activeTab ? 'active' : ''}" data-tab="${tabIndex}"><span class="tab-dot"></span>${item.label}<span class="tab-close">×</span></button>`).join('')}<button class="new-tab" data-new-tab title="New tab">＋</button></div><div class="pathbar"><button class="nav-button" data-up title="Go up one level" aria-label="Go up one level">↑</button><div class="path-text">${breadcrumb}</div><span class="item-count">${entries.length} ITEMS</span></div>${body}<div class="pane-footer"><span class="selection-label">${selected ? '1 SELECTED' : 'NOTHING SELECTED'}</span>${viewSelect}</div></article>`;
}

const HISTORY_LIMIT = 25;
function pushHistory(tab, path) {
  if (!tab.history) { tab.history = [path]; tab.historyIndex = 0; return; }
  if (tab.history[tab.historyIndex] === path) return;
  tab.history = tab.history.slice(0, tab.historyIndex + 1);
  tab.history.push(path);
  if (tab.history.length > HISTORY_LIMIT) tab.history.shift();
  tab.historyIndex = tab.history.length - 1;
}

async function navigateTabTo(index, path, { recordHistory = true, historyIndex } = {}) {
  const pane = state.panes[index]; const tab = currentTab(pane);
  if (!tab) return;
  state.activePane = index;
  const entries = path ? await load(path) : await loadDrives();
  tab.path = path; tab.kind = path ? 'folder' : 'drives'; tab.label = path ? (path.split(/[\\/]/).filter(Boolean).pop() || path) : COMPUTER_LABEL; tab.entries = entries;
  tab.selected = path && stored[path]?.name ? entries.find((entry) => entry.name === stored[path].name)?.id || null : null;
  if (recordHistory) pushHistory(tab, path); else if (historyIndex !== undefined) tab.historyIndex = historyIndex;
  saveSession(); render();
}

function goBack(index) {
  const tab = currentTab(state.panes[index]);
  if (!tab?.history || tab.historyIndex <= 0) return;
  navigateTabTo(index, tab.history[tab.historyIndex - 1], { recordHistory: false, historyIndex: tab.historyIndex - 1 });
}

function goForward(index) {
  const tab = currentTab(state.panes[index]);
  if (!tab?.history || tab.historyIndex >= tab.history.length - 1) return;
  navigateTabTo(index, tab.history[tab.historyIndex + 1], { recordHistory: false, historyIndex: tab.historyIndex + 1 });
}

async function navigatePath(path) {
  const normalized = path.trim();
  if (!currentTab(state.panes[state.activePane]) || !normalized) return;
  await navigateTabTo(state.activePane, normalized);
}

function startRename(index, entry) { state.activePane = index; state.editing = { pane: index, entryId: entry.id, original: entry.name }; render(); const input = document.querySelector('[data-rename]'); input?.focus(); input?.select(); }

function cancelRename() { state.editing = null; render(); }

async function finishRename(index, entry, value) {
  if (!entry) { cancelRename(); return; }
  const newName = value.trim();
  if (!newName || newName === entry.name || /[\\/:*?"<>|]/.test(newName)) { cancelRename(); return; }
  state.editing = null;
  await invoke('rename_entry', { path: entry.path, newName });
  const pane = state.panes[index]; const tab = currentTab(pane); tab.entries = await load(tab.path); tab.selected = tab.entries.find((item) => item.name === newName)?.id || null; saveSession(); render();
}

async function deleteEntry(index, entry) {
  if (!entry || entry.kind === 'drive') return;
  const pane = state.panes[index]; const tab = currentTab(pane);
  await invoke('delete_entry', { path: entry.path });
  tab.entries = await load(tab.path);
  if (tab.selected === entry.id) tab.selected = null;
  state.contextMenu = null;
  saveSession(); render();
}

function deleteSelected(index) {
  const pane = state.panes[index]; const tab = currentTab(pane);
  if (tab?.view === 'tree') { if (tab.treeState?.selected) deleteTreeNode(index, tab.treeState.selected); return; }
  const entry = tab?.entries.find((item) => item.id === tab.selected);
  if (entry) deleteEntry(index, entry);
}

function removeTreeNode(node, targetPath) {
  const childIndex = node.children.findIndex((child) => child.path === targetPath);
  if (childIndex !== -1) {
    const [removed] = node.children.splice(childIndex, 1);
    node.fileCount -= removed.fileCount;
    node.totalSize -= removed.totalSize;
    return removed;
  }
  for (const child of node.children) {
    const removed = removeTreeNode(child, targetPath);
    if (removed) {
      node.fileCount -= removed.fileCount;
      node.totalSize -= removed.totalSize;
      return removed;
    }
  }
  return null;
}

async function deleteTreeNode(index, path) {
  const tab = currentTab(state.panes[index]);
  if (!tab?.treeState?.tree || path === tab.treeState.tree.path) return;
  await invoke('delete_entry', { path });
  removeTreeNode(tab.treeState.tree, path);
  if (tab.treeState.selected === path) tab.treeState.selected = null;
  state.contextMenu = null;
  render();
}

async function navigateToPath(index, path) {
  await navigateTabTo(index, path);
}

async function enter(paneIndex, entry) {
  if (!entry) return;
  const tab = currentTab(state.panes[paneIndex]); remember(tab.path, entry.name);
  if (entry.kind === 'drive' || entry.kind === 'folder') { await navigateTabTo(paneIndex, entry.path); } else { try { await openPath(entry.path); } catch (error) { console.error('openPath failed', entry.path, error); } }
}

async function goUp(index) {
  const tab = currentTab(state.panes[index]); if (!tab || !tab.path) return;
  const trimmed = tab.path.replace(/[\\/]+$/, '');
  let parent;
  if (!isWindows && tab.path.startsWith('/')) {
    if (trimmed === '') { parent = ''; }
    else { const lastSlash = trimmed.lastIndexOf('/'); parent = lastSlash <= 0 ? '/' : trimmed.slice(0, lastSlash); }
  } else {
    parent = /^[A-Za-z]:$/.test(trimmed) || trimmed === '' ? '' : trimmed.replace(/[\\/][^\\/]+$/, '') || '';
    if (/^[A-Za-z]:$/.test(parent)) parent += '\\';
  }
  await navigateTabTo(index, parent);
}

function moveSelection(index, direction) { const pane = state.panes[index]; const tab = currentTab(pane); const entries = tab?.entries || []; if (!entries.length) return; const current = entries.findIndex((entry) => entry.id === tab.selected); const next = current < 0 ? (direction > 0 ? 0 : entries.length - 1) : Math.max(0, Math.min(entries.length - 1, current + direction)); tab.selected = entries[next].id; if (tab.path) remember(tab.path, entries[next].name); saveSession(); scrollSelectionIntoView = true; render(); }

function startTreeView(index) {
  const tab = currentTab(state.panes[index]);
  if (!tab?.path) return;
  const requestId = `tree-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tab.view = 'tree';
  tab.treeState = { requestId, status: 'loading', scannedFiles: 0, scannedFolders: 0, tree: null, expanded: new Set([tab.path]), selected: null };
  render();
  invoke('compute_tree_stats', { requestId, path: tab.path }).catch((error) => {
    if (tab.treeState?.requestId !== requestId) return;
    tab.treeState = { ...tab.treeState, status: 'error', error: String(error) };
    render();
  });
}

function cancelTreeView(index) {
  const tab = currentTab(state.panes[index]);
  if (tab?.treeState?.requestId) invoke('cancel_tree_stats', { requestId: tab.treeState.requestId }).catch(() => {});
  if (tab) { tab.view = 'details'; tab.treeState = null; }
  render();
}

function setPaneView(index, view) {
  const tab = currentTab(state.panes[index]);
  if (!tab) return;
  if (tab.view === 'tree' && tab.treeState?.requestId) invoke('cancel_tree_stats', { requestId: tab.treeState.requestId }).catch(() => {});
  tab.treeState = null;
  if (view === 'tree') { startTreeView(index); return; }
  tab.view = view;
  render();
}

function toggleTreeNode(index, path) {
  const expanded = currentTab(state.panes[index])?.treeState?.expanded;
  if (!expanded) return;
  if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
  render();
}

function findTabByTreeRequest(requestId) {
  for (const pane of state.panes) for (const tab of pane.tabs) if (tab.treeState?.requestId === requestId) return tab;
  return null;
}

function bindEvents() {
  document.querySelectorAll('[data-folder-path]').forEach((button) => button.addEventListener('click', async () => { try { await navigatePath(await resolveFolderPath(button.dataset.folderPath)); } catch { button.classList.add('is-unavailable'); } }));
  document.querySelectorAll('.pane').forEach((element) => { const index = Number(element.dataset.pane); const pane = state.panes[index]; element.addEventListener('click', () => { state.activePane = index; render(); });
    element.querySelectorAll('[data-entry]').forEach((row) => {
      let suppressNextClick = false;
      const activate = (event) => {
        event.stopPropagation();
        const tab = currentTab(pane);
        const entry = tab.entries[Number(row.dataset.index)];
        state.activePane = index;
        if (state.editing) return;
        const now = Date.now();
        const isDoubleClick = lastEntryClick.id === entry.id && now - lastEntryClick.time < DOUBLE_CLICK_MS;
        lastEntryClick = { id: entry.id, time: now };
        clearTimeout(entryClickTimer);
        if (isDoubleClick) { lastEntryClick = { id: null, time: 0 }; enter(index, entry); return; }
        if (entry.kind !== 'drive' && tab.selected === entry.id) {
          entryClickTimer = setTimeout(() => startRename(index, entry), DOUBLE_CLICK_MS);
        } else {
          tab.selected = entry.id; if (tab.path) remember(tab.path, entry.name); saveSession(); render();
        }
      };
      // pointerdown fires immediately; the derived `click` event can lag ~200ms behind it on
      // Windows precision touchpads/touchscreens while the OS gesture recognizer rules out a
      // scroll/pan. Act on pointerdown for real pointer input, and keep `click` only as a
      // fallback for keyboard-triggered activation (Tab + Enter/Space), which never fires pointerdown.
      row.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        // Prevent the browser's default focus-on-mousedown behavior: focusing the button
        // inside the scrollable list triggers a native scroll-into-view, which is what was
        // causing the clicked row to jump to the bottom of the pane.
        event.preventDefault();
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
        const tab = currentTab(pane);
        const entry = tab.entries[Number(row.dataset.index)];
        if (entry.kind === 'drive') return;
        state.activePane = index;
        tab.selected = entry.id;
        if (tab.path) remember(tab.path, entry.name);
        state.contextMenu = { pane: index, kind: 'file', entryId: entry.id, x: event.clientX, y: event.clientY };
        render();
      });
    });
    element.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); state.activePane = index; pane.activeTab = Number(button.dataset.tab); saveSession(); render(); }));
    element.querySelector('[data-new-tab]').addEventListener('click', async (event) => { event.stopPropagation(); const current = currentTab(pane); const path = current?.path || ''; pane.tabs.push(path ? { path, kind: 'folder', label: path.split(/[\\/]/).pop(), entries: await load(path), selected: null, history: [path], historyIndex: 0 } : { path: '', kind: 'drives', label: COMPUTER_LABEL, entries: await loadDrives(), selected: null, history: [''], historyIndex: 0 }); pane.activeTab = pane.tabs.length - 1; saveSession(); render(); });
    element.querySelector('[data-up]').addEventListener('click', (event) => { event.stopPropagation(); goUp(index); });
    element.querySelectorAll('[data-breadcrumb]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); navigateToPath(index, button.dataset.breadcrumb); }));
    const viewSelectEl = element.querySelector('[data-view-select]');
    viewSelectEl?.addEventListener('mousedown', (event) => event.stopPropagation());
    viewSelectEl?.addEventListener('click', (event) => event.stopPropagation());
    viewSelectEl?.addEventListener('change', (event) => { event.stopPropagation(); setPaneView(index, event.currentTarget.value); });
    element.querySelector('[data-tree-cancel]')?.addEventListener('click', (event) => { event.stopPropagation(); cancelTreeView(index); });
    element.querySelectorAll('[data-tree-node]').forEach((row) => {
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        state.activePane = index;
        const path = row.dataset.treeNode;
        if (event.target.closest('[data-tree-caret]')) { toggleTreeNode(index, path); return; }
        const tab = currentTab(pane);
        if (tab?.treeState) tab.treeState.selected = path;
        render();
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault(); event.stopPropagation();
        const tab = currentTab(pane);
        if (!tab?.treeState?.tree) return;
        const path = row.dataset.treeNode;
        if (path === tab.treeState.tree.path) return;
        state.activePane = index;
        tab.treeState.selected = path;
        state.contextMenu = { pane: index, kind: 'tree', path, x: event.clientX, y: event.clientY };
        render();
      });
    });
  });
  document.querySelector('[data-go-back]')?.addEventListener('click', () => goBack(state.activePane));
  document.querySelector('[data-go-forward]')?.addEventListener('click', () => goForward(state.activePane));
  document.querySelector('#hidden-toggle').addEventListener('change', async (event) => { state.showHidden = event.currentTarget.checked; await Promise.all(state.panes.flatMap((pane) => pane.tabs.filter((tab) => tab.path).map(async (tab) => { tab.entries = await load(tab.path); }))); render(); });
  document.querySelector('#location-input').addEventListener('keydown', (event) => { if (event.key !== 'Enter') return; event.preventDefault(); const input = event.currentTarget; navigatePath(input.value).catch(() => input.select()); });
  const renameInput = document.querySelector('[data-rename]'); renameInput?.addEventListener('click', (event) => event.stopPropagation()); renameInput?.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRename(); } if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); const entry = currentTab(state.panes[state.activePane]).entries.find((item) => item.id === state.editing?.entryId); finishRename(state.activePane, entry, event.currentTarget.value).catch(() => cancelRename()); } }); renameInput?.addEventListener('blur', (event) => { const entry = currentTab(state.panes[state.activePane]).entries.find((item) => item.id === state.editing?.entryId); if (entry) finishRename(state.activePane, entry, event.currentTarget.value).catch(() => cancelRename()); });
  const contextMenu = document.querySelector('[data-context-menu]');
  contextMenu?.addEventListener('click', (event) => event.stopPropagation());
  contextMenu?.addEventListener('contextmenu', (event) => event.preventDefault());
  document.querySelector('[data-context-delete]')?.addEventListener('click', () => {
    const menu = state.contextMenu;
    if (!menu) return;
    if (menu.kind === 'tree') { deleteTreeNode(menu.pane, menu.path); return; }
    const entry = currentTab(state.panes[menu.pane]).entries.find((item) => item.id === menu.entryId);
    deleteEntry(menu.pane, entry);
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.contextMenu) { state.contextMenu = null; render(); return; }
  const isTyping = event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA';
  const pane = state.panes[state.activePane]; const tab = currentTab(pane);
  if (event.key === 'Delete' && !isTyping) { event.preventDefault(); deleteSelected(state.activePane); return; }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goBack(state.activePane); return; }
  if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); goForward(state.activePane); return; }
  if (isTyping) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(state.activePane, event.key === 'ArrowUp' ? -1 : 1); }
  if (event.key === 'Enter') { event.preventDefault(); enter(state.activePane, tab?.entries.find((entry) => entry.id === tab.selected)); }
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
    const tabs = saved?.tabs?.length ? await Promise.all(saved.tabs.map(async (item) => item.path ? { ...item, kind: 'folder', entries: await load(item.path), history: [item.path], historyIndex: 0 } : { path: '', kind: 'drives', label: COMPUTER_LABEL, entries: drives, selected: item.selected ?? null, history: [''], historyIndex: 0 })) : [{ path: '', kind: 'drives', label: COMPUTER_LABEL, entries: drives, selected: null, history: [''], historyIndex: 0 }];
    state.panes[index] = { tabs, activeTab: Math.min(saved?.activeTab || 0, tabs.length - 1) };
  }
  render();
}

start().catch(() => render());
listen('fs-changed', (event) => scheduleFolderReload(event.payload));
listen('tree-progress', (event) => {
  const tab = findTabByTreeRequest(event.payload.requestId);
  if (!tab || tab.treeState.status !== 'loading') return;
  tab.treeState.scannedFiles = event.payload.scannedFiles;
  tab.treeState.scannedFolders = event.payload.scannedFolders;
  render();
});
listen('tree-done', (event) => {
  const tab = findTabByTreeRequest(event.payload.requestId);
  if (!tab) return;
  tab.treeState.status = 'done';
  tab.treeState.tree = event.payload.tree;
  render();
});
