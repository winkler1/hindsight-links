import { decode } from '../codec.mjs';

const content = document.querySelector('#content');
const preference = 'always-open-hindsight';
let generation = 0;

function alwaysOpen() {
  try { return localStorage.getItem(preference) === 'true'; } catch { return false; }
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

async function render() {
  const current = ++generation;
  content.replaceChildren();
  if (window.top !== window.self) return;

  const payload = location.hash.slice(1);
  let recording;
  try { recording = await decode(payload); } catch {
    if (current === generation) content.append(element('p', 'This link is not valid'));
    return;
  }
  if (current !== generation) return;

  const title = element('h1', recording.title || 'Hindsight');
  if (recording.t > 0) {
    const seconds = Math.floor(recording.t);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const position = (hours ? hours + ':' + String(minutes).padStart(2, '0') : String(minutes))
      + ':' + String(seconds % 60).padStart(2, '0');
    const time = element('p', 'Playback at ' + position);
    time.className = 'time';
    content.append(title, time);
  } else {
    content.append(title);
  }

  const app = element('a', 'Open in Hindsight');
  app.href = 'hindsight://open#' + payload;
  app.className = 'primary';
  const drive = element('a', 'Open in Google Drive');
  drive.href = recording.d
    ? 'https://drive.google.com/file/d/' + recording.d + '/view'
    : 'https://drive.google.com/drive/u/0/search?q=' + recording.id;
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(app, drive);

  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = alwaysOpen();
  checkbox.addEventListener('change', () => {
    try { localStorage.setItem(preference, String(checkbox.checked)); } catch {}
  });
  label.append(checkbox, document.createTextNode('Always open in Hindsight on this computer'));
  content.append(actions, label);
  if (checkbox.checked) app.click();
}

addEventListener('hashchange', render);
render();
