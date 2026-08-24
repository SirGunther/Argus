(() => {
  'use strict';

  const STORAGE_KEY = 'argus-active-assistant-poc-v1';
  const sessionPath = 'C:\\Users\\you\\Documents\\Argus\\sessions\\AA-260811-042';

  const starterTranscript = [
    ['16:23:08', 'Let’s look at the account provisioning flow first.'],
    ['16:23:22', 'The handoff from sales is creating the customer record, but not assigning an owner.'],
    ['16:23:41', 'I need to check whether this value is being reset.'],
    ['16:23:58', 'Actually, this may be happening before the API call.'],
    ['16:24:16', 'The webhook receives the workspace ID correctly.'],
    ['16:24:33', 'There is a transform between the webhook and the create-user request.'],
    ['16:24:48', 'I should inspect that next.'],
    ['16:25:04', 'Also make a note to add the missing owner field to our integration test.'],
    ['16:25:26', 'If the transform is clean, compare the staging payload with production.'],
    ['16:25:47', 'That should tell us whether this is an environment-specific configuration issue.']
  ];

  const starterDerived = [
    ['16:23:25', '16:23:08', '16:23:22', 'Customer records are created without an assigned owner.'],
    ['16:23:46', '16:23:22', '16:23:41', 'Investigate whether the owner value resets before the API call.'],
    ['16:24:36', '16:23:58', '16:24:33', 'A payload transform runs between the webhook and create-user request.'],
    ['16:24:51', '16:24:16', '16:24:48', 'Inspect the webhook-to-request transform.'],
    ['16:25:08', '16:24:48', '16:25:04', 'Add the owner field to the integration test.'],
    ['16:25:30', '16:25:04', '16:25:26', 'Compare staging and production payloads if the transform is clean.'],
    ['16:25:51', '16:25:26', '16:25:47', 'Possible environment-specific configuration issue.']
  ];

  const liveSamples = [
    {
      transcript: 'Let me trace where the owner ID is first introduced into the request.',
      derived: 'Trace where the owner ID enters the request.'
    },
    {
      transcript: 'The mapping file has a fallback, but it points to the legacy team identifier.',
      derived: 'The mapping fallback uses a legacy team identifier.'
    },
    {
      transcript: 'We should replace that fallback and cover the empty-owner case.',
      derived: 'Replace the legacy fallback and test the empty-owner case.'
    },
    {
      transcript: 'Keep the original payload in the debug log while we validate the change.',
      derived: 'Retain original payloads in debug logs during validation.'
    },
    {
      transcript: 'After that, run the provisioning test against both environments.',
      derived: 'Run provisioning tests against staging and production.'
    }
  ];

  const createId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initialState = {
    status: 'stopped',
    elapsedSeconds: 18 * 60 + 42,
    includeTimestamps: true,
    transcript: starterTranscript.map(([time, text], index) => ({ id: `t-${index}`, time, text, selected: false })),
    derived: starterDerived.map(([time, sourceStart, sourceEnd, text], index) => ({ id: `d-${index}`, time, sourceStart, sourceEnd, text, selected: false }))
  };

  let state = loadState();
  let liveTimer = null;
  let elapsedTimer = null;
  let sampleIndex = 0;
  let saveTimer = null;
  let sourceHighlightTimer = null;
  const paneState = {
    transcript: { atBottom: true, unseen: 0 },
    derived: { atBottom: true, unseen: 0 }
  };

  const els = {
    template: document.querySelector('#rowTemplate'),
    transcriptList: document.querySelector('#transcriptList'),
    derivedList: document.querySelector('#derivedList'),
    transcriptScroll: document.querySelector('#transcriptScroll'),
    derivedScroll: document.querySelector('#derivedScroll'),
    transcriptCount: document.querySelector('#transcriptCount'),
    derivedCount: document.querySelector('#derivedCount'),
    recordButton: document.querySelector('#recordButton'),
    stopButton: document.querySelector('#stopButton'),
    closeSessionButton: document.querySelector('#closeSessionButton'),
    captureStatus: document.querySelector('#captureStatus'),
    captureStatusText: document.querySelector('#captureStatusText'),
    sessionStateDot: document.querySelector('#sessionStateDot'),
    elapsedTime: document.querySelector('#elapsedTime'),
    includeTimestamps: document.querySelector('#includeTimestamps'),
    saveStatus: document.querySelector('#saveStatus'),
    saveStatusText: document.querySelector('#saveStatusText'),
    transcriptJump: document.querySelector('#transcriptJump'),
    derivedJump: document.querySelector('#derivedJump'),
    transcriptNewCount: document.querySelector('#transcriptNewCount'),
    derivedNewCount: document.querySelector('#derivedNewCount'),
    sessionDrawer: document.querySelector('#sessionDrawer'),
    closeModal: document.querySelector('#closeModal'),
    drawerState: document.querySelector('#drawerState'),
    drawerDuration: document.querySelector('#drawerDuration'),
    drawerEntries: document.querySelector('#drawerEntries'),
    finalTranscriptCount: document.querySelector('#finalTranscriptCount'),
    finalDerivedCount: document.querySelector('#finalDerivedCount'),
    toastRegion: document.querySelector('#toastRegion')
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.transcript) && Array.isArray(saved.derived)) {
        const restored = { ...initialState, ...saved, status: saved.status === 'recording' ? 'stopped' : saved.status };
        restored.derived = restored.derived.map((item, index) => ({
          ...item,
          sourceStart: item.sourceStart || initialState.derived[index]?.sourceStart || item.time,
          sourceEnd: item.sourceEnd || initialState.derived[index]?.sourceEnd || item.time
        }));
        return restored;
      }
    } catch (error) {
      console.warn('Unable to restore the local prototype state.', error);
    }
    return structuredClone(initialState);
  }

  function persist(showIndicator = true) {
    clearTimeout(saveTimer);
    if (showIndicator) {
      els.saveStatus.classList.add('saving');
      els.saveStatusText.textContent = 'Saving changes…';
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    saveTimer = setTimeout(() => {
      els.saveStatus.classList.remove('saving');
      els.saveStatusText.textContent = 'All changes saved';
    }, 350);
  }

  function renderAll() {
    renderRows('transcript');
    renderRows('derived');
    updateCounts();
    updateSessionUI();
    els.includeTimestamps.checked = state.includeTimestamps;
    requestAnimationFrame(() => {
      scrollToLive('transcript', false);
      scrollToLive('derived', false);
    });
  }

  function renderRows(kind) {
    const list = els[`${kind}List`];
    list.textContent = '';
    state[kind].forEach((item) => list.append(createRow(kind, item, false)));
  }

  function createRow(kind, item, animate = true) {
    const row = els.template.content.firstElementChild.cloneNode(true);
    const checkbox = row.querySelector('input');
    const time = row.querySelector('time');
    const sourceRange = row.querySelector('.source-range');
    const editable = row.querySelector('.editable-text');
    const copyButton = row.querySelector('.row-copy');

    row.dataset.id = item.id;
    row.dataset.kind = kind;
    row.classList.toggle('selected', item.selected);
    row.classList.toggle('new-row', animate);
    checkbox.checked = item.selected;
    checkbox.setAttribute('aria-label', `Select ${kind === 'transcript' ? 'transcript entry' : 'logged item'} at ${item.time}`);
    time.dateTime = item.time;
    time.textContent = item.time;
    editable.textContent = item.text;
    editable.setAttribute('aria-label', `Edit ${kind === 'transcript' ? 'transcript entry' : 'logged item'} at ${item.time}`);

    if (kind === 'derived') {
      row.classList.add('derived-row');
      sourceRange.hidden = false;
      sourceRange.querySelector('.source-start').textContent = item.sourceStart;
      sourceRange.querySelector('.source-end').textContent = item.sourceEnd;
      sourceRange.title = `Show transcript context from ${item.sourceStart} through ${item.sourceEnd}`;
      sourceRange.setAttribute('aria-label', `Show source transcript from ${item.sourceStart} through ${item.sourceEnd}`);
      sourceRange.addEventListener('click', () => showSourceContext(item));
    }

    checkbox.addEventListener('change', () => {
      item.selected = checkbox.checked;
      row.classList.toggle('selected', item.selected);
      updateSelectionUI(kind);
      persist(false);
    });

    editable.addEventListener('focus', () => row.classList.add('editing'));
    editable.addEventListener('blur', () => {
      row.classList.remove('editing');
      const nextText = editable.innerText.trim();
      if (!nextText) {
        editable.textContent = item.text;
        showToast('Empty entries are restored');
        return;
      }
      if (nextText !== item.text) {
        item.text = nextText;
        persist();
      }
    });
    editable.addEventListener('input', () => {
      const nextText = editable.innerText;
      if (nextText.trim()) {
        item.text = nextText;
        persist();
      }
    });
    editable.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') editable.blur();
    });

    copyButton.addEventListener('click', async () => {
      const copied = formatItem(item);
      await copyText(copied);
      copyButton.classList.add('copied');
      setTimeout(() => copyButton.classList.remove('copied'), 1100);
      showToast('Entry copied');
    });

    return row;
  }

  function updateCounts() {
    const tLength = state.transcript.length;
    const dLength = state.derived.length;
    els.transcriptCount.textContent = `${tLength} ${tLength === 1 ? 'entry' : 'entries'}`;
    els.derivedCount.textContent = `${dLength} ${dLength === 1 ? 'item' : 'items'}`;
    els.drawerEntries.textContent = `${tLength} transcript · ${dLength} logged`;
    els.finalTranscriptCount.textContent = tLength;
    els.finalDerivedCount.textContent = dLength;
    updateSelectionUI('transcript');
    updateSelectionUI('derived');
  }

  function updateSelectionUI(kind) {
    const selected = state[kind].filter((item) => item.selected).length;
    const button = document.querySelector(`.batch-copy-button[data-kind="${kind}"]`);
    const selectAll = document.querySelector(`.select-all-button[data-kind="${kind}"]`);
    button.disabled = selected === 0;
    button.querySelector('.selected-count').textContent = selected;
    selectAll.textContent = selected === state[kind].length && selected > 0 ? 'Clear all' : 'Select all';
  }

  function updateSessionUI() {
    const recording = state.status === 'recording';
    const closed = state.status === 'closed';
    els.recordButton.classList.toggle('active', recording);
    els.recordButton.disabled = recording || closed;
    els.stopButton.disabled = !recording || closed;
    els.closeSessionButton.disabled = closed;
    els.recordButton.querySelector('span:last-child').textContent = recording ? 'Recording' : closed ? 'Closed' : 'Record';
    els.captureStatus.className = `capture-status ${recording ? 'recording' : closed ? 'closed' : ''}`;
    els.captureStatusText.textContent = recording ? 'Listening · Processing live audio' : closed ? 'Session finalized' : 'Session stopped · Ready to resume';
    els.sessionStateDot.className = `session-state-dot ${recording ? 'recording' : closed ? 'closed' : ''}`;
    els.drawerState.textContent = recording ? 'Recording · Live' : closed ? 'Finalized · Complete' : 'Stopped · Ready to resume';
    els.elapsedTime.textContent = formatElapsed(state.elapsedSeconds);
    els.drawerDuration.textContent = formatDuration(state.elapsedSeconds);
  }

  function beginRecording() {
    if (state.status === 'closed' || state.status === 'recording') return;
    state.status = 'recording';
    persist();
    updateSessionUI();
    startTimers();
    showToast('Capture started');
  }

  function stopRecording() {
    if (state.status !== 'recording') return;
    state.status = 'stopped';
    stopTimers();
    persist();
    updateSessionUI();
    showToast('Capture stopped · Session remains resumable');
  }

  function startTimers() {
    stopTimers();
    elapsedTimer = setInterval(() => {
      state.elapsedSeconds += 1;
      updateSessionUI();
      if (state.elapsedSeconds % 10 === 0) persist(false);
    }, 1000);
    liveTimer = setInterval(addLiveSample, 4300);
  }

  function stopTimers() {
    clearInterval(elapsedTimer);
    clearInterval(liveTimer);
    elapsedTimer = null;
    liveTimer = null;
  }

  function addLiveSample() {
    if (state.status !== 'recording') return;
    const sample = liveSamples[sampleIndex % liveSamples.length];
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const previousTranscript = state.transcript[state.transcript.length - 1];
    const transcriptItem = { id: createId('t'), time, text: sample.transcript, selected: false };
    state.transcript.push(transcriptItem);
    appendRow('transcript', transcriptItem);
    const contextStart = previousTranscript && clockDistance(previousTranscript.time, time) <= 120 ? previousTranscript.time : time;

    setTimeout(() => {
      if (state.status !== 'recording') return;
      const derivedItem = { id: createId('d'), time, sourceStart: contextStart, sourceEnd: time, text: sample.derived, selected: false };
      state.derived.push(derivedItem);
      appendRow('derived', derivedItem);
      updateCounts();
      persist();
    }, 850);

    sampleIndex += 1;
    updateCounts();
    persist();
  }

  function appendRow(kind, item) {
    els[`${kind}List`].append(createRow(kind, item, true));
    if (paneState[kind].atBottom) {
      scrollToLive(kind, false);
    } else {
      paneState[kind].unseen += 1;
      updateJumpButton(kind);
    }
  }

  function handlePaneScroll(kind) {
    const scroll = els[`${kind}Scroll`];
    const distanceFromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    const isBottom = distanceFromBottom < 24;
    if (isBottom) {
      paneState[kind].atBottom = true;
      paneState[kind].unseen = 0;
    } else if (paneState[kind].atBottom) {
      paneState[kind].atBottom = false;
    }
    updateJumpButton(kind);
  }

  function updateJumpButton(kind) {
    const button = els[`${kind}Jump`];
    const newCount = els[`${kind}NewCount`];
    button.hidden = paneState[kind].atBottom;
    newCount.textContent = paneState[kind].unseen;
    newCount.hidden = paneState[kind].unseen === 0;
  }

  function scrollToLive(kind, smooth = true) {
    const scroll = els[`${kind}Scroll`];
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    paneState[kind].atBottom = true;
    paneState[kind].unseen = 0;
    updateJumpButton(kind);
  }

  function showSourceContext(item) {
    clearTimeout(sourceHighlightTimer);
    const transcriptRows = [...els.transcriptList.querySelectorAll('.data-row')];
    transcriptRows.forEach((row) => row.classList.remove('source-highlight'));

    const sourceIds = new Set(
      state.transcript
        .filter((entry) => entry.time >= item.sourceStart && entry.time <= item.sourceEnd)
        .map((entry) => entry.id)
    );
    const sourceRows = transcriptRows.filter((row) => sourceIds.has(row.dataset.id));

    if (!sourceRows.length) {
      showToast('Source transcript is outside the active window');
      return;
    }

    sourceRows.forEach((row) => row.classList.add('source-highlight'));
    sourceRows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    paneState.transcript.atBottom = false;
    updateJumpButton('transcript');
    showToast(`Showing ${sourceRows.length} source transcript ${sourceRows.length === 1 ? 'entry' : 'entries'}`);

    sourceHighlightTimer = setTimeout(() => {
      sourceRows.forEach((row) => row.classList.remove('source-highlight'));
    }, 2900);
  }

  function formatItem(item) {
    return state.includeTimestamps ? `[${item.time}] ${item.text}` : item.text;
  }

  async function batchCopy(kind) {
    const selected = state[kind].filter((item) => item.selected);
    if (!selected.length) return;
    await copyText(selected.map(formatItem).join('\n'));
    showToast(`${selected.length} ${selected.length === 1 ? 'entry' : 'entries'} copied in order`);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg><span></span>`;
    toast.querySelector('span').textContent = message;
    els.toastRegion.append(toast);
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 220);
    }, 2200);
  }

  function openDrawer() {
    els.sessionDrawer.classList.add('open');
    els.sessionDrawer.setAttribute('aria-hidden', 'false');
    document.querySelector('.drawer-panel .icon-button').focus();
  }

  function closeDrawer() {
    els.sessionDrawer.classList.remove('open');
    els.sessionDrawer.setAttribute('aria-hidden', 'true');
  }

  function openCloseModal() {
    if (state.status === 'closed') return;
    els.closeModal.classList.add('open');
    els.closeModal.setAttribute('aria-hidden', 'false');
    document.querySelector('[data-close-modal]').focus();
  }

  function closeCloseModal() {
    els.closeModal.classList.remove('open');
    els.closeModal.setAttribute('aria-hidden', 'true');
  }

  function finalizeSession() {
    stopTimers();
    state.status = 'closed';
    persist();
    updateSessionUI();
    closeCloseModal();
    showToast('Session finalized and saved');
  }

  function openFolderDemo() {
    showToast('Desktop build will open the session folder');
  }

  function formatElapsed(total) {
    const hours = Math.floor(total / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
    const seconds = (total % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  function clockDistance(start, end) {
    const toSeconds = (value) => value.split(':').map(Number).reduce((total, part, index) => total + part * [3600, 60, 1][index], 0);
    const difference = toSeconds(end) - toSeconds(start);
    return difference < 0 ? difference + 86400 : difference;
  }

  function formatDuration(total) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${hours ? `${hours}h ` : ''}${minutes}m ${seconds}s`;
  }

  document.querySelectorAll('.select-all-button').forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.dataset.kind;
      const allSelected = state[kind].every((item) => item.selected);
      state[kind].forEach((item) => { item.selected = !allSelected; });
      renderRows(kind);
      updateSelectionUI(kind);
      persist(false);
    });
  });

  document.querySelectorAll('.batch-copy-button').forEach((button) => button.addEventListener('click', () => batchCopy(button.dataset.kind)));
  document.querySelectorAll('.jump-live').forEach((button) => button.addEventListener('click', () => scrollToLive(button.dataset.kind)));
  document.querySelectorAll('[data-close-drawer]').forEach((button) => button.addEventListener('click', closeDrawer));
  document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeCloseModal));

  els.recordButton.addEventListener('click', beginRecording);
  els.stopButton.addEventListener('click', stopRecording);
  els.closeSessionButton.addEventListener('click', openCloseModal);
  els.transcriptScroll.addEventListener('scroll', () => handlePaneScroll('transcript'), { passive: true });
  els.derivedScroll.addEventListener('scroll', () => handlePaneScroll('derived'), { passive: true });
  els.includeTimestamps.addEventListener('change', () => {
    state.includeTimestamps = els.includeTimestamps.checked;
    persist(false);
    showToast(state.includeTimestamps ? 'Copied text will include timestamps' : 'Copied text will omit timestamps');
  });
  document.querySelector('#sessionDetailsButton').addEventListener('click', openDrawer);
  document.querySelector('#openFolderButton').addEventListener('click', openFolderDemo);
  document.querySelector('#drawerFolderButton').addEventListener('click', openFolderDemo);
  document.querySelector('#copyPathButton').addEventListener('click', async () => {
    await copyText(sessionPath);
    showToast('Session path copied');
  });
  document.querySelector('#confirmCloseButton').addEventListener('click', finalizeSession);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDrawer();
      closeCloseModal();
    }
  });

  window.addEventListener('beforeunload', () => {
    stopTimers();
    if (state.status === 'recording') state.status = 'stopped';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  renderAll();
})();
