import {
  createUiState, describeClassification, isSelected, isSourceHighlighted, jumpToLive,
  noteIncomingContent, notePaneScroll, reconcileKeyedRows, replaceSourceHighlights,
  resolveSourceRangeIds, selectionCount, setAllSelected, toggleSelected
} from './ui/ui-state.mjs';
import { createAudioCapture } from './ui/audio-capture.mjs';

(() => {
  'use strict';

  const ui = createUiState();
  const desktop = window.argus || null;
  const state = { session: null, transcript: [], derived: [], services: new Map(), pending: new Set(), handledCommands: new Set(), ready: false, newSession: false };
  let events;
  let unsubscribeProjection;

  const els = {
    template: document.querySelector('#rowTemplate'), transcriptList: document.querySelector('#transcriptList'), derivedList: document.querySelector('#derivedList'),
    transcriptScroll: document.querySelector('#transcriptScroll'), derivedScroll: document.querySelector('#derivedScroll'), transcriptCount: document.querySelector('#transcriptCount'), derivedCount: document.querySelector('#derivedCount'),
    recordButton: document.querySelector('#recordButton'), stopButton: document.querySelector('#stopButton'), closeSessionButton: document.querySelector('#closeSessionButton'), captureStatus: document.querySelector('#captureStatus'), captureStatusText: document.querySelector('#captureStatusText'), sessionStateDot: document.querySelector('#sessionStateDot'), elapsedTime: document.querySelector('#elapsedTime'), sessionIdentity: document.querySelector('#sessionIdentity'),
    saveStatus: document.querySelector('#saveStatus'), saveStatusText: document.querySelector('#saveStatusText'), transcriptJump: document.querySelector('#transcriptJump'), derivedJump: document.querySelector('#derivedJump'), transcriptNewCount: document.querySelector('#transcriptNewCount'), derivedNewCount: document.querySelector('#derivedNewCount'),
    sessionDrawer: document.querySelector('#sessionDrawer'), closeModal: document.querySelector('#closeModal'), drawerState: document.querySelector('#drawerState'), drawerDuration: document.querySelector('#drawerDuration'), drawerEntries: document.querySelector('#drawerEntries'), finalTranscriptCount: document.querySelector('#finalTranscriptCount'), finalDerivedCount: document.querySelector('#finalDerivedCount'), toastRegion: document.querySelector('#toastRegion'), serviceStatusList: document.querySelector('#serviceStatusList'),
    includeTimestamps: document.querySelector('#includeTimestamps'), sessionDetailsButton: document.querySelector('#sessionDetailsButton'), openFolderButton: document.querySelector('#openFolderButton'), drawerFolderButton: document.querySelector('#drawerFolderButton'), copyPathButton: document.querySelector('#copyPathButton'), confirmCloseButton: document.querySelector('#confirmCloseButton')
  };

  assertRequiredBindings(els);

  const capture = desktop ? createAudioCapture({
    sendAudioChunk: (chunk) => desktop.sendAudioChunk(chunk),
    sendAudioFlush: (payload) => desktop.sendAudioFlush(payload),
    reportFailure: (error) => { void desktop.reportCaptureFailure(error.message); showToast(`Microphone unavailable · ${error.message}`, 'error'); }
  }) : null;

  const kindConfig = {
    transcript: { list: 'transcriptList', scroll: 'transcriptScroll', count: 'transcriptCount', label: 'transcript entry' },
    derived: { list: 'derivedList', scroll: 'derivedScroll', count: 'derivedCount', label: 'logged item' }
  };

  function receive(message, { bootstrap = false } = {}) {
    if (!message || typeof message.message_type !== 'string' || !message.payload) return;
    switch (message.message_type) {
      case 'ui.session-status': state.session = message.payload; renderSession(); break;
      case 'ui.transcript-row': upsert('transcript', message.payload, bootstrap); break;
      case 'ui.logged-item-row': upsert('derived', message.payload, bootstrap); break;
      case 'ui.service-status':
        state.services.set(message.payload.capability, message.payload);
        renderServices();
        if (message.payload.capability === 'classification') renderRows('derived');
        break;
      case 'ui.command-result': handleCommandResult(message.payload); break;
      default: break;
    }
  }

  function upsert(kind, item, bootstrap) {
    const id = kind === 'transcript' ? item.segment_id : item.item_id;
    const collection = state[kind];
    if (kind === 'transcript' && !item.provisional) {
      for (let index = collection.length - 1; index >= 0; index -= 1) if (collection[index].provisional) collection.splice(index, 1);
    }
    const index = collection.findIndex((entry) => (kind === 'transcript' ? entry.segment_id : entry.item_id) === id);
    const wasPresent = index >= 0;
    if (wasPresent) collection[index] = { ...collection[index], ...item };
    else collection.push({ ...item });
    collection.sort((a, b) => kind === 'transcript' ? a.sequence - b.sequence : a.logged_at.localeCompare(b.logged_at));
    renderRows(kind, !bootstrap && !wasPresent);
    updateCounts();
    if (!bootstrap && !wasPresent) {
      noteIncomingContent(ui, kind);
      updateJumpButton(kind);
      if (ui.panes[kind].followingLive) scrollToLive(kind, false);
    }
  }

  function renderRows(kind, animate = false) {
    const list = els[kindConfig[kind].list];
    const activeElement = document.activeElement;
    reconcileKeyedRows({
      list,
      items: state[kind],
      itemId: (item) => kind === 'transcript' ? item.segment_id : item.item_id,
      createRow: (item) => createRow(kind, item, animate),
      updateRow: (row, item, options) => updateRow(kind, row, item, options),
      preserveRow: (row) => Boolean(activeElement && row.contains(activeElement))
    });
  }

  function createRow(kind, item, animate) {
    const row = els.template.content.firstElementChild.cloneNode(true);
    const checkbox = row.querySelector('input');
    const time = row.querySelector('time');
    const sourceRange = row.querySelector('.source-range');
    const sourceIdentity = row.querySelector('.source-identity');
    const provenance = row.querySelector('.row-provenance');
    const editable = row.querySelector('.editable-text');
    const copyButton = row.querySelector('.row-copy');
    const suggestion = row.querySelector('.classification-suggestion');
    const id = kind === 'transcript' ? item.segment_id : item.item_id;
    const pending = state.pending.has(`${kind}:${id}`);
    const editableAllowed = kind === 'transcript' ? !item.provisional && !item.read_only && state.session?.state !== 'closed' : state.session?.state !== 'closed';

    row.dataset.id = id;
    row.dataset.kind = kind;
    row.argusItem = item;
    row.classList.toggle('selected', isSelected(ui, kind, id));
    row.classList.toggle('new-row', animate);
    row.classList.toggle('pending', pending);
    row.classList.toggle('read-only', !editableAllowed);
    row.classList.toggle('source-highlight', kind === 'transcript' && isSourceHighlighted(ui, id));
    checkbox.checked = isSelected(ui, kind, id);
    checkbox.setAttribute('aria-label', `Select ${kindConfig[kind].label} at ${item.start_time || item.logged_at}`);
    time.dateTime = item.start_time || item.logged_at;
    time.textContent = item.start_time || item.logged_at;
    editable.textContent = item.text;
    editable.contentEditable = editableAllowed ? 'true' : 'false';
    editable.setAttribute('aria-label', `${editableAllowed ? 'Edit' : 'Read-only'} ${kindConfig[kind].label} at ${item.start_time || item.logged_at}`);
    if (!editableAllowed) editable.setAttribute('aria-readonly', 'true');

    if (kind === 'derived') {
      row.classList.add('derived-row');
      sourceRange.hidden = false;
      const source = item.source;
      const validSource = source && source.first_segment_id && source.last_segment_id && source.start_time && source.end_time;
      if (validSource) {
        sourceRange.querySelector('.source-start').textContent = source.start_time;
        sourceRange.querySelector('.source-end').textContent = source.end_time;
        sourceIdentity.textContent = `${source.first_segment_id} → ${source.last_segment_id}`;
        sourceRange.title = `Show exact source range ${source.first_segment_id} (${source.start_time}) through ${source.last_segment_id} (${source.end_time})`;
        sourceRange.setAttribute('aria-label', `Show exact source range ${source.first_segment_id} at ${source.start_time} through ${source.last_segment_id} at ${source.end_time}`);
        sourceRange.addEventListener('click', () => showSourceContext(row.argusItem));
        provenance.hidden = false;
      } else {
        row.classList.add('degraded');
        sourceRange.disabled = true;
        sourceRange.querySelector('.source-start').textContent = 'Source unavailable';
        sourceRange.querySelector('.source-end').textContent = '';
        sourceIdentity.textContent = 'Exact provenance rejected';
        provenance.hidden = false;
      }
      const classification = describeClassification(item.classification_suggestion, state.services.get('classification'));
      suggestion.hidden = false;
      suggestion.classList.add(classification.state);
      suggestion.textContent = classification.text;
      suggestion.title = classification.title;
    }

    if (item.review_flags?.length) {
      row.classList.add('review-needed');
      editable.title = item.review_flags.map((flag) => `${flag.reason}: ${flag.candidates.join(', ')}`).join(' · ');
    }
    checkbox.addEventListener('change', () => {
      toggleSelected(ui, kind, id, checkbox.checked);
      row.classList.toggle('selected', checkbox.checked);
      updateSelectionUI(kind);
    });
    editable.addEventListener('focus', () => {
      row.classList.add('editing');
      row.argusEditBase = row.argusItem;
    });
    editable.addEventListener('blur', () => {
      row.classList.remove('editing');
      const editBase = row.argusEditBase || row.argusItem;
      row.argusEditBase = null;
      const nextText = editable.innerText.trim();
      if (!nextText) { editable.textContent = editBase.text; showToast('Empty entries are restored', 'error'); return; }
      if (nextText !== editBase.text) submitEdit(kind, editBase, nextText);
    });
    editable.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') editable.blur(); });
    copyButton.addEventListener('click', () => sendCopy(kind, [id], copyButton));
    return row;
  }

  function updateRow(kind, row, item, { preserveEditor = false } = {}) {
    const checkbox = row.querySelector('input');
    const time = row.querySelector('time');
    const sourceRange = row.querySelector('.source-range');
    const sourceIdentity = row.querySelector('.source-identity');
    const provenance = row.querySelector('.row-provenance');
    const editable = row.querySelector('.editable-text');
    const suggestion = row.querySelector('.classification-suggestion');
    const id = kind === 'transcript' ? item.segment_id : item.item_id;
    const pending = state.pending.has(`${kind}:${id}`);
    const editableAllowed = kind === 'transcript' ? !item.provisional && !item.read_only && state.session?.state !== 'closed' : state.session?.state !== 'closed';
    const displayTime = item.start_time || item.logged_at;

    row.argusItem = item;
    row.dataset.id = id;
    row.dataset.kind = kind;
    row.classList.toggle('selected', isSelected(ui, kind, id));
    row.classList.toggle('new-row', false);
    row.classList.toggle('pending', pending);
    row.classList.toggle('read-only', !editableAllowed);
    row.classList.toggle('source-highlight', kind === 'transcript' && isSourceHighlighted(ui, id));
    checkbox.checked = isSelected(ui, kind, id);
    checkbox.setAttribute('aria-label', `Select ${kindConfig[kind].label} at ${displayTime}`);
    time.dateTime = displayTime;
    time.textContent = displayTime;
    if (!preserveEditor) {
      editable.textContent = item.text;
      editable.contentEditable = editableAllowed ? 'true' : 'false';
    }
    editable.setAttribute('aria-label', `${editableAllowed ? 'Edit' : 'Read-only'} ${kindConfig[kind].label} at ${displayTime}`);
    if (editableAllowed) editable.removeAttribute('aria-readonly');
    else editable.setAttribute('aria-readonly', 'true');

    row.classList.remove('degraded', 'review-needed');
    editable.removeAttribute('title');
    if (kind === 'derived') {
      const source = item.source;
      const validSource = source && source.first_segment_id && source.last_segment_id && source.start_time && source.end_time;
      if (validSource) {
        sourceRange.hidden = false;
        sourceRange.disabled = false;
        sourceRange.querySelector('.source-start').textContent = source.start_time;
        sourceRange.querySelector('.source-end').textContent = source.end_time;
        sourceIdentity.textContent = `${source.first_segment_id} → ${source.last_segment_id}`;
        sourceRange.title = `Show exact source range ${source.first_segment_id} (${source.start_time}) through ${source.last_segment_id} (${source.end_time})`;
        sourceRange.setAttribute('aria-label', `Show exact source range ${source.first_segment_id} at ${source.start_time} through ${source.last_segment_id} at ${source.end_time}`);
        provenance.hidden = false;
      } else {
        row.classList.add('degraded');
        sourceRange.hidden = false;
        sourceRange.disabled = true;
        sourceRange.querySelector('.source-start').textContent = 'Source unavailable';
        sourceRange.querySelector('.source-end').textContent = '';
        sourceIdentity.textContent = 'Exact provenance rejected';
        provenance.hidden = false;
      }
      const classification = describeClassification(item.classification_suggestion, state.services.get('classification'));
      suggestion.hidden = false;
      suggestion.className = `classification-suggestion ${classification.state}`;
      suggestion.textContent = classification.text;
      suggestion.title = classification.title;
    }
    if (item.review_flags?.length) {
      row.classList.add('review-needed');
      editable.title = item.review_flags.map((flag) => `${flag.reason}: ${flag.candidates.join(', ')}`).join(' · ');
    }
  }

  function updateCounts() {
    const transcriptCount = state.transcript.length;
    const loggedCount = state.derived.length;
    els.transcriptCount.textContent = `${transcriptCount} ${transcriptCount === 1 ? 'entry' : 'entries'}`;
    els.derivedCount.textContent = `${loggedCount} ${loggedCount === 1 ? 'item' : 'items'}`;
    els.drawerEntries.textContent = `${transcriptCount} transcript · ${loggedCount} logged`;
    els.finalTranscriptCount.textContent = transcriptCount;
    els.finalDerivedCount.textContent = loggedCount;
    updateSelectionUI('transcript');
    updateSelectionUI('derived');
  }

  function updateSelectionUI(kind) {
    const count = selectionCount(ui, kind);
    const button = document.querySelector(`.batch-copy-button[data-kind="${kind}"]`);
    const selectAll = document.querySelector(`.select-all-button[data-kind="${kind}"]`);
    button.disabled = count === 0;
    button.querySelector('.selected-count').textContent = count;
    selectAll.textContent = count === state[kind].length && count > 0 ? 'Clear all' : 'Select all';
  }

  function renderSession() {
    if (!state.session) return;
    const recording = state.session.state === 'recording';
    const closed = state.session.state === 'closed';
    els.sessionIdentity.textContent = `Session ${state.session.session_id}`;
    els.recordButton.classList.toggle('active', recording);
    els.recordButton.disabled = recording;
    els.stopButton.disabled = !recording || closed;
    els.closeSessionButton.disabled = closed;
    els.recordButton.title = closed ? 'Start a new session' : recording ? 'Recording from the physical microphone' : 'Start recording for this session';
    els.recordButton.querySelector('span:last-child').textContent = recording ? 'Recording' : closed ? 'New Session' : (desktop && !state.newSession ? 'Resume' : 'Record');
    els.captureStatus.className = `capture-status ${recording ? 'recording' : closed ? 'closed' : ''}`;
    els.captureStatusText.textContent = recording ? 'Listening · Processing live audio' : closed ? 'Session finalized' : 'Session stopped · Ready to resume';
    els.sessionStateDot.className = `session-state-dot ${recording ? 'recording' : closed ? 'closed' : ''}`;
    els.drawerState.textContent = recording ? 'Recording · Live' : closed ? 'Finalized · Complete' : 'Stopped · Ready to resume';
    els.elapsedTime.textContent = formatElapsed(state.session.elapsed_seconds);
    els.drawerDuration.textContent = formatDuration(state.session.duration_seconds);
  }

  function renderServices() {
    els.serviceStatusList.textContent = '';
    for (const service of state.services.values()) {
      const chip = document.createElement('span');
      chip.className = `service-chip ${service.status}`;
      chip.title = service.message;
      chip.textContent = `${service.capability}: ${service.status}`;
      els.serviceStatusList.append(chip);
    }
  }

  function setBridgeStatus(status, message) {
    const previous = state.services.get('bridge');
    state.services.set('bridge', { capability: 'bridge', status, message, retryable: status !== 'available', updated_at: new Date().toISOString() });
    renderServices();
    return previous?.status;
  }

  async function submitEdit(kind, item, text) {
    const id = kind === 'transcript' ? item.segment_id : item.item_id;
    const command = kind === 'transcript' ? 'transcript.edit' : 'logged-item.edit';
    const payload = { command_id: createCommandId(), session_id: item.session_id, command, expected_revision: item.revision, text, ...(kind === 'transcript' ? { segment_id: id } : { item_id: id }) };
    state.pending.add(`${kind}:${id}`);
    renderRows(kind);
    els.saveStatus.classList.add('saving');
    els.saveStatusText.textContent = 'Waiting for owner…';
    await postCommand(payload);
  }

  async function sendCopy(kind, ids, button) {
    const commandKind = kind === 'derived' ? 'logged-item' : kind;
    const payload = { command_id: createCommandId(), session_id: state.session.session_id, command: 'copy', kind: commandKind, item_ids: ids, include_timestamps: ui.includeTimestamps };
    await postCommand(payload, button);
  }

  async function postCommand(payload, button) {
    if (button) button.classList.add('pending');
    try {
      if (desktop) {
        const result = await desktop.command(payload);
        if (result?.message_type) handleCommandResult(result.payload);
        else showToast('Electron host rejected the command', 'error');
        return;
      }
      const response = await fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (result.message_type) handleCommandResult(result.payload);
      else showToast(result.error || 'Bridge rejected the command', 'error');
    } catch (error) {
      showToast(`Bridge unavailable · ${error.message}`, 'error');
      renderAll();
    } finally { if (button) setTimeout(() => button.classList.remove('pending'), 600); }
  }

  function handleCommandResult(result) {
    if (!result || state.handledCommands.has(result.command_id)) return;
    state.handledCommands.add(result.command_id);
    const kind = result.command === 'transcript.edit' ? 'transcript' : result.command === 'logged-item.edit' ? 'derived' : null;
    if (kind) {
      state.pending.delete(`${kind}:${result.resource_id}`);
      if (result.status === 'rejected') renderRows(kind);
    }
    els.saveStatus.classList.remove('saving');
    els.saveStatusText.textContent = result.status === 'accepted' ? 'Owner accepted change' : 'Owner rejected change';
    showToast(result.message, result.status === 'accepted' ? 'success' : 'error');
    if (result.status === 'accepted' && desktop && result.command === 'session.new') {
      state.transcript = [];
      state.derived = [];
      state.pending.clear();
      ui.selected.transcript.clear();
      ui.selected.derived.clear();
      ui.sourceHighlights.clear();
      ui.panes.transcript = { followingLive: true, unseen: 0 };
      ui.panes.derived = { followingLive: true, unseen: 0 };
      state.newSession = false;
      renderAll();
      showToast('New session started', 'success');
      void capture.start(result.session_id).catch(() => {});
    } else if (result.status === 'accepted' && desktop && (result.command === 'session.record' || result.command === 'session.resume')) {
      state.newSession = false;
      void capture.start(result.session_id).catch(() => {});
    }
  }

  async function sendSessionCommand(command) {
    if (!state.session) return;
    const requestedCommand = desktop && command === 'session.record' && state.session.state === 'closed' ? 'session.new' : command;
    const actualCommand = desktop && requestedCommand === 'session.record' && !state.newSession ? 'session.resume' : requestedCommand;
    if (desktop && (actualCommand === 'session.stop' || actualCommand === 'session.close')) await capture.stop();
    await postCommand({ command_id: createCommandId(), session_id: state.session.session_id, command: actualCommand });
  }

  function showSourceContext(item) {
    const source = item.source;
    const sourceIds = resolveSourceRangeIds(state.transcript, source);
    replaceSourceHighlights(ui, sourceIds);
    renderRows('transcript');
    const sourceRows = [...els.transcriptList.querySelectorAll('.data-row')].filter((row) => sourceIds.includes(row.dataset.id));
    if (!sourceRows.length) { showToast('Exact source provenance is unavailable', 'error'); return; }
    sourceRows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    notePaneScroll(ui, 'transcript', { distanceFromBottom: 1000 });
    updateJumpButton('transcript');
    showToast(`Showing ${source.first_segment_id} → ${source.last_segment_id}`, 'success');
  }

  function selectedIds(kind) {
    return state[kind].filter((item) => isSelected(ui, kind, kind === 'transcript' ? item.segment_id : item.item_id)).map((item) => kind === 'transcript' ? item.segment_id : item.item_id);
  }

  function handlePaneScroll(kind) {
    const scroll = els[kindConfig[kind].scroll];
    notePaneScroll(ui, kind, { distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight });
    updateJumpButton(kind);
  }

  function updateJumpButton(kind) {
    const button = els[`${kind}Jump`];
    const count = els[`${kind}NewCount`];
    button.hidden = ui.panes[kind].followingLive;
    count.textContent = ui.panes[kind].unseen;
    count.hidden = ui.panes[kind].unseen === 0;
  }

  function scrollToLive(kind, smooth = true) {
    const scroll = els[kindConfig[kind].scroll];
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    jumpToLive(ui, kind);
    updateJumpButton(kind);
  }

  function renderAll() { renderRows('transcript'); renderRows('derived'); updateCounts(); renderSession(); renderServices(); }

  function showToast(message, tone = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${tone}`;
    toast.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg><span></span>';
    toast.querySelector('span').textContent = message;
    els.toastRegion.append(toast);
    setTimeout(() => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 220); }, 2600);
  }

  function openDrawer() { els.sessionDrawer.classList.add('open'); els.sessionDrawer.setAttribute('aria-hidden', 'false'); document.querySelector('.drawer-panel .icon-button').focus(); }
  function closeDrawer() { els.sessionDrawer.classList.remove('open'); els.sessionDrawer.setAttribute('aria-hidden', 'true'); }
  function openCloseModal() { if (state.session?.state === 'closed') return; els.closeModal.classList.add('open'); els.closeModal.setAttribute('aria-hidden', 'false'); document.querySelector('[data-close-modal]').focus(); }
  function closeCloseModal() { els.closeModal.classList.remove('open'); els.closeModal.setAttribute('aria-hidden', 'true'); }
  function createCommandId() { return `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function formatElapsed(total) { const hours = Math.floor(total / 3600).toString().padStart(2, '0'); const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, '0'); const seconds = (total % 60).toString().padStart(2, '0'); return `${hours}:${minutes}:${seconds}`; }
  function formatDuration(total) { const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const seconds = total % 60; return `${hours ? `${hours}h ` : ''}${minutes}m ${seconds}s`; }

  async function load() {
    if (desktop) {
      setBridgeStatus('degraded', 'Connecting to the Electron host.');
      try {
        const bootstrap = await desktop.bootstrap();
        state.newSession = Boolean(bootstrap.new_session);
        bootstrap.projections.forEach((message) => receive(message, { bootstrap: true }));
        unsubscribeProjection = desktop.onProjection((message) => receive(message));
        state.ready = true;
        setBridgeStatus('available', 'Electron host connected; governed projections and commands are live.');
        els.saveStatusText.textContent = 'Electron host connected · projections current';
      } catch (error) {
        setBridgeStatus('unavailable', `Electron host unavailable · ${error.message}`);
        showToast('Electron host unavailable', 'error');
      }
      return;
    }
    setBridgeStatus('degraded', 'Connecting to the local Argus UI bridge.');
    try {
      const response = await fetch('/api/bootstrap');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bootstrap = await response.json();
      bootstrap.projections.forEach((message) => receive(message, { bootstrap: true }));
      state.ready = true;
      events = new EventSource('/api/events');
      ['ui.session-status', 'ui.transcript-row', 'ui.logged-item-row', 'ui.service-status', 'ui.command-result'].forEach((type) => events.addEventListener(type, (event) => receive(JSON.parse(event.data))));
      events.addEventListener('open', () => {
        state.ready = true;
        setBridgeStatus('available', 'Local bridge connected; projections and commands are live.');
        els.saveStatusText.textContent = 'Bridge connected · projections current';
      });
      events.addEventListener('error', () => {
        const previous = setBridgeStatus('unavailable', 'Local bridge disconnected; the browser will retry automatically. Stop in the UI does not stop the bridge.');
        state.ready = false;
        els.saveStatusText.textContent = 'Bridge disconnected · retrying';
        if (previous !== 'unavailable') showToast('Local bridge disconnected · retrying', 'error');
      });
      els.saveStatusText.textContent = 'Bridge projections loaded · connecting live events';
    } catch (error) {
      setBridgeStatus('unavailable', `Local bridge unavailable · ${error.message}. Start it with npm.cmd run demo:ui.`);
      showToast('Loopback bridge unavailable', 'error');
    }
  }

  document.querySelectorAll('.select-all-button').forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.kind;
    const ids = state[kind].map((item) => kind === 'transcript' ? item.segment_id : item.item_id);
    setAllSelected(ui, kind, ids, selectionCount(ui, kind) !== ids.length);
    renderRows(kind); updateSelectionUI(kind);
  }));
  document.querySelectorAll('.batch-copy-button').forEach((button) => button.addEventListener('click', () => sendCopy(button.dataset.kind, selectedIds(button.dataset.kind), button)));
  document.querySelectorAll('.jump-live').forEach((button) => button.addEventListener('click', () => scrollToLive(button.dataset.kind)));
  document.querySelectorAll('[data-close-drawer]').forEach((button) => button.addEventListener('click', closeDrawer));
  document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeCloseModal));
  els.recordButton.addEventListener('click', () => sendSessionCommand('session.record'));
  els.stopButton.addEventListener('click', () => sendSessionCommand('session.stop'));
  els.closeSessionButton.addEventListener('click', openCloseModal);
  els.transcriptScroll.addEventListener('scroll', () => handlePaneScroll('transcript'), { passive: true });
  els.derivedScroll.addEventListener('scroll', () => handlePaneScroll('derived'), { passive: true });
  els.includeTimestamps.addEventListener('change', () => { ui.includeTimestamps = els.includeTimestamps.checked; showToast(ui.includeTimestamps ? 'Copied text will include timestamps' : 'Copied text will omit timestamps'); });
  els.sessionDetailsButton.addEventListener('click', openDrawer);
  els.openFolderButton.addEventListener('click', () => postCommand({ command_id: createCommandId(), session_id: state.session.session_id, command: 'open-folder' }));
  els.drawerFolderButton.addEventListener('click', () => postCommand({ command_id: createCommandId(), session_id: state.session.session_id, command: 'open-folder' }));
  els.copyPathButton.addEventListener('click', () => postCommand({ command_id: createCommandId(), session_id: state.session.session_id, command: 'copy-session-path' }));
  els.confirmCloseButton.addEventListener('click', () => { closeCloseModal(); sendSessionCommand('session.close'); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeDrawer(); closeCloseModal(); } });
  window.addEventListener('beforeunload', () => { events?.close(); unsubscribeProjection?.(); void capture?.stop(); });
  load();
})();

function assertRequiredBindings(bindings) {
  const missing = Object.entries(bindings).filter(([, element]) => !element).map(([name]) => name);
  if (missing.length) throw new Error(`Argus UI startup failed: missing required element binding(s): ${missing.join(', ')}`);
}
