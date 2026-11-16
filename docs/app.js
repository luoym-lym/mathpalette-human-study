'use strict';

const app = document.querySelector('#app');
const dialog = document.querySelector('#image-dialog');
let catalog, state, storageKey, active = null, page = 0, noticeTimeout;
const pageSize = 15;
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const groupNumber = group => group.id.slice(1);
const getProgress = group => state.groups[group.id] || {answers:[], elapsed:0, draft:'', complete:false};

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
    active.progress.elapsed += performance.now() - active.started;
    active.started = null;
  }
  save();
}

function resumeTimer() {
  if (active && active.ready && !document.hidden && active.started === null) active.started = performance.now();
}

function stopTimer() { checkpoint(); active = null; }
document.addEventListener('visibilitychange', () => { checkpoint(); resumeTimer(); });
window.addEventListener('pagehide', checkpoint);
window.addEventListener('pageshow', resumeTimer);
setInterval(() => { if (active) { checkpoint(); resumeTimer(); } }, 1000);

const art = `<div class="hero-art" aria-hidden="true">
<svg viewBox="0 0 460 285" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="275" cy="132" r="82" fill="#dbe3cd" stroke="#a8b798" stroke-width="1"/>
<ellipse cx="275" cy="132" rx="82" ry="28" stroke="#93a482" stroke-dasharray="4 5"/>
<path d="M275 50V214M193 132H357" stroke="#a8b798" stroke-dasharray="4 5"/>
<path d="M94 214 174 63 254 214Z" fill="#f7f5e9" fill-opacity=".7" stroke="#245d4a" stroke-width="2"/>
<path d="M174 63V214M94 214 214 139" stroke="#7e9770" stroke-dasharray="5 5"/>
<path d="M174 200H188V214" stroke="#245d4a"/>
<circle cx="94" cy="214" r="4" fill="#245d4a"/><circle cx="174" cy="63" r="4" fill="#245d4a"/><circle cx="254" cy="214" r="4" fill="#245d4a"/>
<circle cx="339" cy="80" r="8" fill="#d6a253"/><path d="M314 216q30-23 54-13" stroke="#b78b50" stroke-width="2"/>
<g fill="#506549" font-family="Georgia,serif" font-style="italic" font-size="17"><text x="70" y="222">A</text><text x="168" y="46">B</text><text x="262" y="228">C</text><text x="185" y="162">h</text><text x="330" y="154">r</text></g>
</svg><span class="art-label">A DIFFERENT WAY OF SEEING.</span></div>`;

function home() {
  const complete = catalog.groups.filter(g => getProgress(g).complete).length;
  app.innerHTML = `<section class="hero"><div><div class="eyebrow">An invitation to explore</div><h1>A little curiosity.<br>A <em>new perspective.</em></h1><p class="hero-copy">How do you see a math problem? Share your answers to a set of visual questions and help us understand mathematical reasoning.</p><div class="hero-meta"><span>↗ &nbsp; Contribute to research</span><span>○ &nbsp; No account needed</span></div></div>${art}</section>
  <section class="steps" aria-label="How to participate"><div class="step"><span class="step-number">01</span><div><strong>Choose a group</strong><p>A fixed set. Pause whenever you like.</p></div></div><div class="step"><span class="step-number">02</span><div><strong>Share your answers</strong><p>Write naturally. Any format is fine.</p></div></div><div class="step"><span class="step-number">03</span><div><strong>Leave your name</strong><p>So we know who to thank.</p></div></div></section>
  <section id="group-list" aria-labelledby="groups-heading"><div class="section-heading"><div><h2 id="groups-heading">Find your starting point.</h2><p>Choose any group. You can always come back for another.</p></div><div class="group-summary">${catalog.groups.length} fixed groups<br>${complete ? `${complete} completed on this browser` : '97–98 questions each'}</div></div><div class="groups" id="groups"></div><div class="pagination"><span id="page-info"></span><div class="pagination-controls"><button id="previous-page" aria-label="Previous groups">← Previous</button><button id="next-page" aria-label="Next groups">Next →</button></div></div></section>`;
  renderCards();
  document.querySelector(".pagination").hidden = catalog.groups.length <= pageSize;
  document.querySelector('#previous-page').onclick = () => { page--; renderCards(); };
  document.querySelector('#next-page').onclick = () => { page++; renderCards(); };
}

function renderCards() {
  const offset = page * pageSize;
  document.querySelector('#groups').innerHTML = catalog.groups.slice(offset, offset + pageSize).map((group, i) => {
    const progress = getProgress(group);
    const started = progress.answers.length > 0 || progress.elapsed > 0;
    const tag = progress.complete ? 'Completed' : started ? 'In progress' : 'Open';
    return `<a class="group-card ${i === 0 && !progress.complete ? 'featured' : ''}" href="#group/${group.id}"><div class="card-top"><span class="group-number">${groupNumber(group)}</span><span class="tag">${tag}</span></div><h3>Group ${groupNumber(group)}</h3><p>${group.samples.length} questions · Mixed topics</p><div class="card-bottom"><span>${progress.complete ? 'View completion' : started ? `Continue · ${progress.answers.length}/${group.samples.length}` : 'Start this group'}</span><span aria-hidden="true">${progress.complete ? '✓' : '↗'}</span></div></a>`;
  }).join('');
  document.querySelector('#page-info').textContent = `Showing ${offset + 1}–${Math.min(offset + pageSize, catalog.groups.length)} of ${catalog.groups.length} groups`;
  document.querySelector('#previous-page').disabled = page === 0;
  document.querySelector('#next-page').disabled = offset + pageSize >= catalog.groups.length;
}

function renderQuestion(group) {
  const progress = getProgress(group);
  state.groups[group.id] = progress;
  if (progress.complete) return renderThanks(group);
  if (progress.answers.length === group.samples.length) return renderName(group);
  const index = progress.answers.length;
  const sample = group.samples[index];
  app.innerHTML = `<div class="workspace-top"><a class="text-button" href="#">← Pause & all groups</a><span class="workspace-meta">Group ${groupNumber(group)} <span class="footer-dot">/</span> Question ${index + 1} of ${group.samples.length}</span></div><div class="progress-track" role="progressbar" aria-label="Questions completed" aria-valuenow="${index}" aria-valuemin="0" aria-valuemax="${group.samples.length}"><div class="progress-bar" style="width:${index / group.samples.length * 100}%"></div></div>
  <section class="question-layout"><div class="diagram-card"><button class="diagram-button" aria-label="Enlarge question diagram"><img id="question-image" src="./${escapeHTML(sample.image)}" alt="Diagram for question ${index + 1}"></button><div class="diagram-caption"><span>Take a closer look</span><span class="zoom-icon" aria-hidden="true">⤢</span></div><p class="error" id="image-error" role="alert"></p></div><div class="question-panel"><p class="question-label">${escapeHTML(({Analytics:'Functions & graphs',PlaneGeometry:'Plane geometry',SolidGeometry:'Solid geometry'})[sample.branch])}</p><h1>A fresh perspective.</h1><div class="question-text" id="question-text"></div><form id="answer-form"><label class="answer-label" for="answer">Your answer</label><textarea class="answer-input" id="answer" maxlength="5000" placeholder="Type your answer here…" aria-describedby="answer-help">${escapeHTML(progress.draft)}</textarea><p class="input-help" id="answer-help">Plain text is perfect: x^2, 1/3, sqrt(2), or an option letter.<br>No special formatting or explanation needed.</p><div class="answer-actions"><button type="button" class="understated" id="skip-answer" disabled>I don't know</button><button type="submit" class="primary-button" id="next-answer" disabled>${index + 1 === group.samples.length ? 'Finish this group' : 'Next question'} <span aria-hidden="true">→</span></button></div><p class="error" id="answer-error" role="alert"></p></form><p class="save-note">Your progress is saved on this browser.<br>Submitted answers are final. Take the time you need.</p></div></section>`;
  document.querySelector('#question-text').textContent = sample.question;
  if (window.renderMathInElement) renderMathInElement(document.querySelector('#question-text'), {delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'$',right:'$',display:false},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false});
  const image = document.querySelector('#question-image');
  active = {progress, started:null, ready:false};
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
  document.querySelector('#answer').oninput = event => { progress.draft = event.target.value; save(); };
  const submitAnswer = answer => {
    if (!active || !active.ready) return;
    if (!answer.trim()) { document.querySelector('#answer-error').textContent = 'Enter an answer, or choose “I don’t know” to continue.'; return; }
    checkpoint();
    const elapsed = progress.elapsed;
    progress.answers.push({sample_id:sample.id, answer, time_seconds:Math.round(elapsed) / 1000});
    progress.elapsed = 0;
    progress.draft = '';
    if (!save()) { progress.answers.pop(); progress.elapsed = elapsed; progress.draft = answer; resumeTimer(); return; }
    active = null;
    renderQuestion(group);
    window.scrollTo(0,0);
  };
  document.querySelector('#answer-form').onsubmit = event => { event.preventDefault(); submitAnswer(document.querySelector('#answer').value); };
  document.querySelector('#skip-answer').onclick = () => submitAnswer("I don't know");
}

function renderName(group) {
  app.innerHTML = `<div class="workspace-top"><a class="text-button" href="#">← Pause & all groups</a><span class="workspace-meta">Group ${groupNumber(group)} · All questions answered</span></div><section class="finish-card"><div class="finish-icon" aria-hidden="true">✓</div><div class="eyebrow" style="justify-content:center">One last thing</div><h1>Who can we thank?</h1><p>You've answered all ${group.samples.length} questions.<br>Add your English name to submit your responses.</p><form id="name-form"><label for="english-name" class="answer-label">Your English name</label><input id="english-name" class="name-input" autocomplete="name" maxlength="80" required placeholder="e.g. Alex Chen" value="${escapeHTML(state.name || '')}"><p class="input-help">Your name identifies your answers and may be used to thank volunteers in a future paper.</p><p class="error" id="submit-error" role="alert"></p><button class="primary-button full-width" type="submit" id="submit-group">Submit my responses <span aria-hidden="true">→</span></button></form></section>`;
  document.querySelector('#name-form').onsubmit = async event => {
    event.preventDefault();
    const name = document.querySelector('#english-name').value.trim();
    if (!name) return;
    state.name = name;
    if (!save()) return;
    const button = document.querySelector('#submit-group');
    const error = document.querySelector('#submit-error');
    button.disabled = true;
    button.textContent = 'Submitting…';
    error.textContent = '';
    const config = window.MATHPALETTE_CONFIG || {};
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl || '') ||
        !(config.supabasePublishableKey || '').startsWith('sb_publishable_')) {
      error.textContent = 'Submissions are not open yet. Your answers are saved on this browser; please contact the study organizer.';
      button.disabled = false;
      button.textContent = 'Submit my responses →';
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(config.supabaseUrl + '/rest/v1/rpc/submit_human_group', {
        method:'POST',
        headers:{'Content-Type':'application/json',apikey:config.supabasePublishableKey},
        body:JSON.stringify({payload:{version:catalog.version,group_id:group.id,english_name:name,answers:getProgress(group).answers}}),
        signal:controller.signal
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'The submission could not be saved.');
      if (result.saved !== true) throw new Error('The server did not confirm receipt. Please try again.');
      state.groups[group.id].complete = true;
      state.groups[group.id].name = name;
      save();
      if (location.hash === `#group/${group.id}`) renderThanks(group);
    } catch (failure) {
      error.textContent = failure.name === 'AbortError' ? 'The connection took too long. Your answers are saved on this browser; please try submitting again.' : `${failure.message} Your answers remain saved on this browser.`;
      button.disabled = false;
      button.textContent = 'Try submitting again →';
    } finally { clearTimeout(timeout); }
  };
}

function renderThanks(group) {
  const progress = getProgress(group);
  app.innerHTML = `<section class="finish-card"><div class="finish-icon" aria-hidden="true">✧</div><div class="eyebrow" style="justify-content:center">A contribution that counts</div><h1>Thank you, ${escapeHTML(progress.name || state.name)}.</h1><p>Your answers have been received.<br>Thank you for sharing your time and your perspective with MathPalette.</p><p class="completion-detail">Group ${groupNumber(group)} · ${group.samples.length} responses submitted</p><a href="#" class="primary-button full-width">Explore another group <span aria-hidden="true">→</span></a><p class="save-note">You're also welcome to stop here. Every contribution helps.</p></section>`;
}

function about() {
  app.innerHTML = `<article class="about"><a class="text-button" href="#">← Back to the groups</a><h1>A different way<br>of seeing mathematics.</h1><p>MathPalette explores visual mathematical reasoning. Your responses help us understand how people solve problems presented with different diagrams.</p><p>Choose a group and answer its questions independently. Paper and pencil are welcome. Please do not use AI, search engines, or outside help.</p><p>Write your final answers in any ordinary text format. If you are unsure, give your best answer or select “I don't know”. You can pause and return using the same browser.</p><p>We collect your answers, the time spent on each question while this page is visible, and the English name you provide after completing a group. We do not ask for an email address or an account.</p><p>Your name identifies your responses and may be used in acknowledgments for a future paper. Answers are not graded on this website.</p><a href="#" class="primary-button">Choose a group <span aria-hidden="true">→</span></a></article>`;
}

function route() {
  stopTimer();
  const hash = location.hash;
  if (hash === '#about') about();
  else if (hash.startsWith('#group/')) {
    const group = catalog.groups.find(g => g.id === hash.slice(7));
    if (group) renderQuestion(group); else { home(); notify('That group could not be found. Please select a group below.'); }
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
    route();
  } catch (error) { app.innerHTML = `<div class="loading"><h2>Let's try that again.</h2><p>${escapeHTML(error.message)}</p><button class="secondary-button" id="reload">Reload page</button></div>`; document.querySelector('#reload').onclick = () => location.reload(); }
})();
