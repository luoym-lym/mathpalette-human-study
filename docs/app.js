'use strict';

const app = document.querySelector('#app');
const dialog = document.querySelector('#image-dialog');
let catalog, state, storageKey, active = null, noticeTimeout;
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const groupNumber = group => group.id.slice(1);
let busy = false, groupLocks = {};
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function getProgress(group) {
  let progress = state.groups[group.id];
  if (!progress) progress = state.groups[group.id] = {answers:[], complete:false};
  if (progress.format !== 2) {
    const oldAnswers = progress.answers || [];
    const next = oldAnswers.length;
    progress.answers = group.samples.map((sample, i) => oldAnswers[i] || {
      sample_id:sample.id, answer:i === next ? progress.draft || '' : '',
      time_seconds:i === next ? (progress.elapsed || 0) / 1000 : 0
    });
    progress.cursor = Math.min(next, group.samples.length - 1);
    progress.view = next === group.samples.length ? 'name' : 'question';
    progress.format = 2;
    delete progress.elapsed;
    delete progress.draft;
  }
  return progress;
}
function getLockToken(progress) {
  if (!progress.lockToken) {
    progress.lockToken = (progress.receipt && progress.receipt.token) || newToken();
  }
  return progress.lockToken;
}
const answeredCount = progress => progress.answers.filter(item => item.answer.trim()).length;
const isLocked = progress => progress.complete || progress.pending || progress.withdrawing;
function newReceipt(name) {
  return {name, token:newToken()};
}
function submissionPayload(group) {
  const progress = getProgress(group);
  return {version:catalog.version, group_id:group.id, english_name:progress.receipt.name,
    receipt_token:progress.receipt.token, lock_token:getLockToken(progress),
    answers:progress.answers.map(item => ({
      sample_id:item.sample_id, answer:item.answer,
      time_seconds:Math.round(item.time_seconds * 1000) / 1000
    }))};
}
async function rpc(endpoint, payload) {
  const config = window.MATHPALETTE_CONFIG || {};
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl || '') ||
      !(config.supabasePublishableKey || '').startsWith('sb_publishable_')) {
    throw new Error('Submissions are not open yet. Please contact the study organizer.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(config.supabaseUrl + '/rest/v1/rpc/' + endpoint, {
      method:'POST', headers:{'Content-Type':'application/json', apikey:config.supabasePublishableKey},
      body:JSON.stringify({payload}), signal:controller.signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.code === 'PGRST202'
      ? 'The study organizer needs to enable the updated submission service. Your work is saved.'
      : result.message || 'The request could not be completed.');
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The connection took too long. Please retry.');
    throw error;
  } finally { clearTimeout(timeout); }
}
async function syncGroupLocks() {
  if (!catalog) return false;
  const tokens = {};
  for (const group of catalog.groups) {
    const progress = state.groups[group.id];
    const token = progress && (progress.lockToken || (progress.receipt && progress.receipt.token));
    if (token) tokens[group.id] = token;
  }
  const result = await rpc('list_human_group_locks', {version:catalog.version, tokens});
  if (!result || typeof result.groups !== 'object' || result.groups === null) return false;
  groupLocks = result.groups;
  for (const group of catalog.groups) {
    const progress = state.groups[group.id];
    const remote = groupLocks[group.id];
    if (!progress) continue;
    if (remote && remote.mine) {
      progress.claimed = true;
      continue;
    }
    if (remote && !remote.mine) {
      progress.claimed = false;
      continue;
    }
    const count = answeredCount(progress);
    const hasLocalWork = Boolean(progress.claimed || count > 0 || (progress.answers || []).some(item => item.time_seconds > 0));
    if (hasLocalWork && !isLocked(progress)) {
      try {
        const token = getLockToken(progress);
        save();
        const claimed = await rpc('claim_human_group', {version:catalog.version, group_id:group.id, lock_token:token});
        if (claimed && claimed.claimed) {
          progress.claimed = true;
          groupLocks[group.id] = {status:claimed.status || 'in_progress', mine:true};
        }
      } catch { /* Another participant may have claimed it concurrently. */ }
    }
  }
  save();
  return true;
}
async function resetGroup(group) {
  const progress = getProgress(group);
  if (busy || isLocked(progress)) return;
  const wasActive = Boolean(active);
  stopTimer();
  if (!window.confirm('Clear all answers and recorded time for Group ' + groupNumber(group) + '? Other groups will be kept.')) {
    if (wasActive) renderQuestion(group);
    return;
  }
  busy = true;
  try {
    const token = progress.lockToken || (progress.receipt && progress.receipt.token);
    if (token && (progress.claimed || (groupLocks[group.id] && groupLocks[group.id].mine))) {
      const result = await rpc('release_human_group', {
        version:catalog.version, group_id:group.id, lock_token:token
      });
      if (!result || result.released !== true) {
        throw new Error('The server did not confirm unlocking this group. Please retry.');
      }
    }
    delete groupLocks[group.id];
    delete state.groups[group.id];
    if (!save()) {
      state.groups[group.id] = progress;
      if (wasActive) renderQuestion(group);
      return;
    }
    location.hash = '#';
    home(true);
    notify('Group ' + groupNumber(group) + ' cleared. It is open again.');
  } catch (error) {
    if (wasActive && location.hash === `#group/${group.id}`) renderQuestion(group);
    else if (!location.hash || location.hash === '#') renderCards();
    notify(error.message || 'Could not clear this group. Please retry.');
  } finally { busy = false; }
}


function notify(message) {
  const node = document.querySelector('#notice');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => node.classList.remove('visible'), 4500);
}

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(state)); return true; }
  catch { notify('Your browser could not save progress. Please enable browser storage before continuing.'); return false; }
}

function checkpoint() {
  if (!active) return;
  if (active.started !== null) {
    active.record.time_seconds += (performance.now() - active.started) / 1000;
    active.started = null;
  }
  save();
}

function resumeTimer() {
  if (active && active.ready && !document.hidden && active.started === null) active.started = performance.now();
}

function stopTimer() { checkpoint(); active = null; }
document.addEventListener('visibilitychange', () => {
  checkpoint();
  resumeTimer();
  if (!document.hidden && catalog && (!location.hash || location.hash === '#')) {
    syncGroupLocks().then(() => {
      if (!location.hash || location.hash === '#') renderCards();
    }).catch(() => {});
  }
});
window.addEventListener('pagehide', checkpoint);
window.addEventListener('pageshow', resumeTimer);
setInterval(() => { if (active) { checkpoint(); resumeTimer(); } }, 1000);


function home(skipSync = false) {
  app.innerHTML = `<section class="survey-home">
<h2 class="study-notes-title">Instruction</h2>
<ol class="study-notes" aria-label="Participation notes">
<li><strong>Any readable answer format is accepted</strong>, such as <code>sqrt(x)</code>, <code>√x</code>, or <code>4pi</code>. Fractions and irrational numbers may be left in exact form or rounded to any number of decimal places. Answers will be evaluated manually.</li>
<li>If a question is too difficult, select <strong>“I don’t know”</strong> to skip it (but please try your best to answer).</li>
<li>You may use tools, including calculators, but <strong>AI assistance is not allowed</strong>.</li>
<li>We will collect your answers and the time spent on each question.</li>
<li>All collected data will be used <strong>solely for academic research</strong>.</li>
<li>We do not ask for your contact information, so we will not send you your results. Individual results are not the focus of this study; your responses will mainly be used for statistical analysis.</li>
<li>The English name you enter will be used only to distinguish participants and potentially acknowledge your contribution. <strong>You do not need to use your real name.</strong></li>
</ol>
<p>Choose a group and answer independently. You can pause and continue in the same browser.</p><div class="groups" id="groups" aria-label="Question groups"></div></section>`;
  renderCards();
  if (!skipSync) {
    syncGroupLocks().then(() => {
      if (!location.hash || location.hash === '#') renderCards();
    }).catch(() => {});
  }
}

function renderCards() {
  const container = document.querySelector('#groups');
  if (!container) return;
  container.innerHTML = catalog.groups.map(group => {
    const progress = getProgress(group);
    const remote = groupLocks[group.id];
    const lockedByOther = Boolean(remote && !remote.mine);
    if (lockedByOther) {
      const remoteTag = remote.status === 'completed' ? 'Completed · Locked' : 'In progress · Locked';
      return `<article class="group-card"><div class="group-card-link is-locked" aria-disabled="true"><strong class="group-name">Group ${groupNumber(group)}</strong><span class="group-count">${group.samples.length} questions</span><span class="tag">${remoteTag}</span><span class="group-open">Locked</span></div></article>`;
    }
    const count = answeredCount(progress);
    const started = Boolean(progress.claimed || count > 0 || progress.answers.some(item => item.time_seconds > 0));
    const tag = progress.withdrawing ? 'Withdrawing' : progress.complete ? 'Completed' : progress.pending ? 'Pending' : started ? 'In progress' : 'Open';
    const action = progress.complete ? 'View' : progress.pending || progress.withdrawing || started ? 'Continue' : 'Start';
    return `<article class="group-card"><a class="group-card-link" href="#group/${group.id}"><strong class="group-name">Group ${groupNumber(group)}</strong><span class="group-count">${group.samples.length} questions</span><span class="tag">${tag}${started && !isLocked(progress) ? ` · ${count}/${group.samples.length}` : ''}</span><span class="group-open">${action}</span></a>${started && !isLocked(progress) ? `<button class="clear-group-button danger-text" type="button" data-clear-group="${group.id}" aria-label="Clear group ${groupNumber(group)}">Clear group</button>` : ''}</article>`;
  }).join('');
  document.querySelectorAll('[data-clear-group]').forEach(button => {
    button.onclick = () => resetGroup(catalog.groups.find(group => group.id === button.dataset.clearGroup));
  });
}

async function enterGroup(group) {
  const progress = getProgress(group);
  const remote = groupLocks[group.id];
  if (remote && !remote.mine) {
    location.hash = '#';
    home(true);
    notify('Group ' + groupNumber(group) + ' is locked by another participant. Please choose another group.');
    return;
  }
  if (isLocked(progress) || (progress.claimed && remote && remote.mine)) {
    renderQuestion(group);
    return;
  }
  app.innerHTML = `<div class="loading">Locking Group ${groupNumber(group)}…</div>`;
  try {
    const token = getLockToken(progress);
    if (!save()) return;
    const result = await rpc('claim_human_group', {
      version:catalog.version, group_id:group.id, lock_token:token
    });
    if (!result || result.claimed !== true) {
      throw new Error('Could not lock this group. Please retry.');
    }
    progress.claimed = true;
    groupLocks[group.id] = {status:result.status || 'in_progress', mine:true};
    save();
    if (location.hash === `#group/${group.id}`) renderQuestion(group);
  } catch (error) {
    await syncGroupLocks().catch(() => {});
    location.hash = '#';
    home(true);
    notify(error.message || 'This group could not be opened.');
  }
}

function renderQuestion(group) {
  const progress = getProgress(group);
  if (progress.withdrawing || progress.pending) return renderPending(group);
  if (progress.complete) return renderThanks(group);
  if (progress.view === 'review') return renderReview(group);
  if (progress.view === 'name') return renderName(group);
  const index = progress.cursor;
  const sample = group.samples[index];
  const record = progress.answers[index];
  const count = answeredCount(progress);
  app.innerHTML = `<div class="workspace-top"><a class="text-button" href="#">← Pause & all groups</a><span class="workspace-meta">Group ${groupNumber(group)} · Question ${index + 1} of ${group.samples.length}</span></div><div class="progress-track" role="progressbar" aria-label="Questions answered" aria-valuenow="${count}" aria-valuemin="0" aria-valuemax="${group.samples.length}"><div class="progress-bar" style="width:${count / group.samples.length * 100}%"></div></div>
  <section class="question-layout"><div class="diagram-card"><button class="diagram-button" aria-label="Enlarge question diagram"><img id="question-image" src="./${escapeHTML(sample.image)}" alt="Diagram for question ${index + 1}"></button><div class="diagram-caption"><span>Take a closer look</span><span aria-hidden="true">⤢</span></div><p class="error" id="image-error" role="alert"></p></div><div class="question-panel"><p class="question-label">${escapeHTML(({Analytics:'Functions & graphs',PlaneGeometry:'Plane geometry',SolidGeometry:'Solid geometry'})[sample.branch])}</p><div class="question-text" id="question-text"></div>
  <form id="answer-form"><label class="answer-label" for="answer">Your answer</label><textarea class="answer-input" id="answer" maxlength="5000" placeholder="Type your answer here…" aria-describedby="answer-help">${escapeHTML(record.answer)}</textarea><p class="input-help" id="answer-help">Plain text is perfect: x^2, 1/3, sqrt(2), or an option letter.<br>No special formatting or explanation needed.</p><div class="answer-actions"><button type="button" class="understated" id="skip-answer" disabled>I don't know</button><button type="submit" class="primary-button" id="next-answer" disabled>${index + 1 === group.samples.length ? 'Finish this group' : 'Next question'} →</button></div><p class="error" id="answer-error" role="alert"></p></form>
  <div class="question-navigation"><button class="secondary-button" id="previous-question" ${index === 0 ? 'disabled' : ''}>← Previous question</button><button class="secondary-button" id="review-answers">All questions</button><button class="understated" id="clear-answer">Clear this answer</button></div><p class="save-note">Your progress is saved on this browser. You can return to any question and edit your answer before submitting.</p><button class="understated danger-text" id="reset-group">Clear group</button></div></section>`;
  document.querySelector('#question-text').textContent = sample.question;
  if (window.renderMathInElement) renderMathInElement(document.querySelector('#question-text'), {delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'$',right:'$',display:false},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false});
  const image = document.querySelector('#question-image');
  active = {record, started:null, ready:false};
  const current = active;
  const ready = async () => {
    await document.fonts.ready;
    if (active !== current || !image.naturalWidth) return;
    current.ready = true;
    document.querySelector('#skip-answer').disabled = false;
    document.querySelector('#next-answer').disabled = false;
    resumeTimer();
  };
  image.onload = ready;
  image.onerror = () => { if (active === current) document.querySelector('#image-error').textContent = 'The diagram could not load. Please reload this page to try again.'; };
  if (image.complete && image.naturalWidth) ready();
  document.querySelector('.diagram-button').onclick = () => { dialog.querySelector('img').src = image.src; dialog.showModal(); };
  document.querySelector('#answer').oninput = event => { record.answer = event.target.value; save(); };
  const next = answer => {
    if (!active || !active.ready) return;
    if (!answer.trim()) { document.querySelector('#answer-error').textContent = 'Enter an answer, or choose “I don’t know” to continue.'; return; }
    record.answer = answer;
    if (!save()) return;
    if (index + 1 < group.samples.length) openQuestion(group, index + 1);
    else showGroupView(group, answeredCount(progress) === group.samples.length ? 'name' : 'review');
  };
  document.querySelector('#answer-form').onsubmit = event => { event.preventDefault(); next(document.querySelector('#answer').value); };
  document.querySelector('#skip-answer').onclick = () => next("I don't know");
  document.querySelector('#previous-question').onclick = () => openQuestion(group, index - 1);
  document.querySelector('#review-answers').onclick = () => showGroupView(group, 'review');
  document.querySelector('#clear-answer').onclick = () => {
    record.answer = ''; document.querySelector('#answer').value = ''; save(); document.querySelector('#answer').focus();
  };
  document.querySelector('#reset-group').onclick = () => resetGroup(group);
}
function openQuestion(group, index) {
  const progress = getProgress(group);
  if (isLocked(progress) || index < 0 || index >= group.samples.length) return;
  stopTimer();
  progress.cursor = index;
  progress.view = 'question';
  save();
  renderQuestion(group);
  window.scrollTo(0,0);
}
function showGroupView(group, view) {
  stopTimer();
  getProgress(group).view = view;
  save();
  renderQuestion(group);
  window.scrollTo(0,0);
}
function renderReview(group) {
  const progress = getProgress(group);
  const count = answeredCount(progress);
  app.innerHTML = `<div class="workspace-top"><a class="text-button" href="#">← Pause & all groups</a><span class="workspace-meta">Group ${groupNumber(group)}</span></div><section class="review-card"><h1>Your answers.</h1><p>${count} of ${group.samples.length} questions answered. Select a question to review, change, or clear its answer.</p><p class="save-note">Filled circles are answered. Outlined circles still need an answer.</p><div class="question-grid">${progress.answers.map((item,i) => `<button class="question-number ${item.answer.trim() ? 'answered' : ''}" data-question="${i}" aria-label="Question ${i + 1}, ${item.answer.trim() ? 'answered' : 'unanswered'}">${i + 1}</button>`).join('')}</div><button class="primary-button" id="continue-review">${count === group.samples.length ? 'Continue to your name →' : 'Continue answering →'}</button><p><button class="understated danger-text" id="reset-group">Clear group</button></p></section>`;
  document.querySelectorAll('[data-question]').forEach(button => { button.onclick = () => openQuestion(group, Number(button.dataset.question)); });
  document.querySelector('#continue-review').onclick = () => count === group.samples.length
    ? showGroupView(group, 'name') : openQuestion(group, progress.answers.findIndex(item => !item.answer.trim()));
  document.querySelector('#reset-group').onclick = () => resetGroup(group);
}
function renderName(group) {
  const progress = getProgress(group);
  if (answeredCount(progress) !== group.samples.length) { progress.view = 'review'; return renderReview(group); }
  app.innerHTML = `<div class="workspace-top"><a class="text-button" href="#">← Pause & all groups</a><span class="workspace-meta">Group ${groupNumber(group)} · All questions answered</span></div><section class="finish-card"><div class="finish-icon" aria-hidden="true">✓</div><div class="eyebrow" style="justify-content:center">One last thing</div><h1>Who can we thank?</h1><p>You've answered all ${group.samples.length} questions.<br>Add your English name to submit your responses.</p><button class="secondary-button" id="review-answers">← Review or edit answers</button><form id="name-form"><label for="english-name" class="answer-label">Your English name</label><input id="english-name" class="name-input" autocomplete="name" maxlength="80" required placeholder="e.g. Alex Chen" value="${escapeHTML(state.name || '')}"><p class="input-help">Your name identifies your answers and may be used to thank volunteers in a future paper.</p><p class="error" id="submit-error" role="alert"></p><button class="primary-button full-width" type="submit">Submit my responses →</button></form><button class="understated danger-text" id="reset-group">Clear group</button></section>`;
  document.querySelector('#review-answers').onclick = () => showGroupView(group, 'review');
  document.querySelector('#reset-group').onclick = () => resetGroup(group);
  document.querySelector('#name-form').onsubmit = event => {
    event.preventDefault();
    const name = document.querySelector('#english-name').value.trim();
    if (!name || busy) return;
    state.name = name;
    getLockToken(progress);
    progress.receipt = newReceipt(name);
    progress.pending = true;
    if (!save()) { progress.pending = false; progress.receipt = null; return; }
    submitGroup(group);
  };
}
function renderPending(group, message = '') {
  const progress = getProgress(group);
  const withdrawing = progress.withdrawing;
  app.innerHTML = `<section class="finish-card"><h1>${withdrawing ? 'Withdrawing responses.' : 'Sending your answers.'}</h1><p>${withdrawing ? 'Your answers will become an editable draft once withdrawal is confirmed.' : 'Your answers are saved on this browser. Keep them unchanged until the server confirms submission, or cancel the submission to edit them.'}</p><p class="error" role="alert">${escapeHTML(message)}</p><button class="primary-button full-width" id="retry-request" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : withdrawing ? 'Retry withdrawal' : 'Retry submission'}</button>${!withdrawing ? `<button class="understated danger-text" id="cancel-submission" ${busy ? 'disabled' : ''}>Cancel submission & edit answers</button>` : ''}<p><a class="text-button" href="#">← All groups</a></p></section>`;
  document.querySelector('#retry-request').onclick = () => withdrawing ? withdrawGroup(group) : submitGroup(group);
  if (!withdrawing) document.querySelector('#cancel-submission').onclick = () => withdrawGroup(group);
}
async function submitGroup(group) {
  const progress = getProgress(group);
  if (busy || !progress.pending || progress.withdrawing) return;
  busy = true;
  renderPending(group);
  let error = '';
  try {
    const result = await rpc('submit_human_group_v2', submissionPayload(group));
    if (result.saved !== true) throw new Error('The server did not confirm receipt. Please retry.');
    progress.complete = true;
    progress.pending = false;
    progress.claimed = true;
    progress.name = progress.receipt.name;
    groupLocks[group.id] = {status:'completed', mine:true};
    save();
  } catch (failure) { error = failure.message; }
  finally { busy = false; }
  if (location.hash === `#group/${group.id}`) {
    if (progress.complete) renderThanks(group); else renderPending(group, error);
  }
}
async function withdrawGroup(group) {
  const progress = getProgress(group);
  if (busy || (!isLocked(progress) && !progress.receipt)) return;
  if (!progress.withdrawing && !window.confirm('Withdraw this group from the study? Your answers will stay on this browser so you can edit them or clear the group.')) return;
  if (!progress.receipt) {
    progress.receipt = {...newReceipt(progress.name || state.name), legacy:true};
  }
  getLockToken(progress);
  progress.withdrawing = true;
  if (!save()) return;
  busy = true;
  renderPending(group);
  let error = '';
  try {
    // Legacy responses require an exact answer-and-time match before issuing a receipt.
    if (progress.receipt.legacy) {
      const claimed = await rpc('submit_human_group_v2', submissionPayload(group));
      if (claimed.saved !== true) throw new Error('Could not verify your original submission.');
      progress.receipt.legacy = false;
      save();
    }
    const payload = submissionPayload(group);
    delete payload.answers;
    const result = await rpc('withdraw_human_group', payload);
    if (result.withdrawn !== true) throw new Error('The server did not confirm withdrawal. Please retry.');
    progress.complete = false;
    progress.pending = false;
    progress.withdrawing = false;
    progress.claimed = true;
    progress.receipt = null;
    progress.view = 'review';
    groupLocks[group.id] = {status:'in_progress', mine:true};
    save();
  } catch (failure) { error = failure.message; }
  finally { busy = false; }
  if (location.hash === `#group/${group.id}`) {
    if (progress.withdrawing) renderPending(group, error);
    else { renderReview(group); notify('Submission withdrawn. You can edit your answers or clear this group.'); }
  }
}
function renderThanks(group) {
  const progress = getProgress(group);
  app.innerHTML = `<section class="finish-card"><div class="finish-icon" aria-hidden="true">✧</div><h1>Thank you, ${escapeHTML(progress.name || state.name)}.</h1><p>Your answers have been received.<br>Thank you for sharing your time and perspective with MathPalette.</p><p class="completion-detail">Group ${groupNumber(group)} · ${group.samples.length} responses submitted</p><a href="#" class="primary-button full-width">Explore another group →</a><button class="understated danger-text" id="withdraw-group">Withdraw submission</button><p class="save-note">You can withdraw using this browser to edit your answers or start again. Keep this browser's saved data until you are finished.</p></section>`;
  document.querySelector('#withdraw-group').onclick = () => withdrawGroup(group);
}

function route() {
  stopTimer();
  const hash = location.hash;
  if (hash.startsWith('#group/')) {
    const group = catalog.groups.find(g => g.id === hash.slice(7));
    if (group) enterGroup(group); else { home(); notify('That group could not be found. Please select a group below.'); }
  } else home();
  window.scrollTo(0,0);
}

dialog.querySelector('button').onclick = () => dialog.close();
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
window.addEventListener('hashchange', () => { if (catalog) route(); });

(async function init() {
  try {
    const response = await fetch('./groups.json');
    if (!response.ok) throw new Error('The question groups could not be loaded.');
    catalog = await response.json();
    storageKey = `mathpalette:${catalog.version}`;
    try { state = JSON.parse(localStorage.getItem(storageKey)) || {name:'',groups:{}}; }
    catch { throw new Error('Browser storage is unavailable. Enable it and reload to save your progress.'); }
    if (!save()) throw new Error('Browser storage is unavailable. Enable it and reload to save your progress.');
    await syncGroupLocks().catch(() => {});
    route();
  } catch (error) { app.innerHTML = `<div class="loading"><h2>Let's try that again.</h2><p>${escapeHTML(error.message)}</p><button class="secondary-button" id="reload">Reload page</button></div>`; document.querySelector('#reload').onclick = () => location.reload(); }
})();
