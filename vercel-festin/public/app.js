const $ = (selector, root = document) => root.querySelector(selector);
const api = async (url, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/auth/login') showLogin();
    throw new Error(data.error || 'La requête a échoué.');
  }
  return data;
};

let activeRole = null;
let activeTab = 'checkin-panel';
let pendingCheckinValue = '';
let cameraStream = null;
let barcodeDetector = null;
let scanning = false;
let searchTimer;

function showLogin(message = '') {
  activeRole = null;
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-error').textContent = message;
  stopCamera();
}

function showApp(session) {
  activeRole = session.role;
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#role-label').textContent = session.role === 'admin' ? 'Administrateur' : 'Vérification';
  document.querySelectorAll('.admin-only').forEach(element => element.classList.toggle('hidden', session.role !== 'admin'));
  document.querySelectorAll('.tab').forEach(button => button.classList.toggle('hidden', session.role !== 'admin' && button.dataset.panel !== 'checkin-panel'));
  activateTab(session.role === 'admin' ? activeTab : 'checkin-panel');
}

function activateTab(id) {
  if (activeRole !== 'admin' && id !== 'checkin-panel') id = 'checkin-panel';
  activeTab = id;
  document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active', button.dataset.panel === id));
  document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === id));
  if (id !== 'checkin-panel') stopCamera();
  if (id === 'history-panel') loadHistory();
}

document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => activateTab(button.dataset.panel)));

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    const session = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    $('#password').value = '';
    showApp(session);
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#logout').addEventListener('click', async () => {
  stopCamera();
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); }
  finally { showLogin(); }
});

$('#ticket-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (activeRole !== 'admin') return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const message = $('#create-message');
  button.disabled = true;
  message.textContent = 'Enregistrement…';
  try {
    const result = await api('/api/tickets', { method: 'POST', body: JSON.stringify({
      buyerName: $('#buyer-name').value,
      buyerPhone: $('#buyer-phone').value,
      pass: new FormData(event.currentTarget).get('pass'),
    }) });
    renderTicketPreview(result.ticket, result.qrDataUrl);
    event.currentTarget.reset();
    message.textContent = `Billet ${result.ticket.code} enregistré dans la base centrale.`;
    toast(message.textContent);
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});

function renderTicketPreview(ticket, qrDataUrl) {
  const holder = $('#ticket-preview');
  holder.replaceChildren();
  const card = document.createElement('article');
  card.className = 'ticket-preview-card';
  const event = document.createElement('p');
  event.className = 'eyebrow';
  event.textContent = 'Le Festin du Lapin & des Générations';
  const code = document.createElement('p');
  code.className = 'ticket-code';
  code.textContent = ticket.code;
  const qr = document.createElement('img');
  qr.alt = `QR code du billet ${ticket.code}`;
  qr.src = qrDataUrl;
  const name = document.createElement('h3');
  name.textContent = ticket.buyerName;
  const pass = document.createElement('p');
  pass.textContent = `${ticket.passLabel} · ${money(ticket.price)}`;
  const date = document.createElement('p');
  date.textContent = '31 octobre 2026 · Angré, Carrefour Cabri';
  card.append(event, code, qr, name, pass, date);
  holder.append(card);
  const actions = document.createElement('div');
  actions.className = 'button-row ticket-actions';
  const print = document.createElement('button');
  print.type = 'button'; print.className = 'secondary'; print.textContent = 'Imprimer / enregistrer en PDF';
  print.addEventListener('click', printTicket);
  actions.append(print);
  holder.append(actions);
}

function printTicket() {
  document.body.classList.add('print-ticket');
  window.print();
  window.setTimeout(() => document.body.classList.remove('print-ticket'), 500);
}

function money(value) { return new Intl.NumberFormat('fr-FR').format(Number(value)) + ' FCFA'; }
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

$('#lookup-form').addEventListener('submit', event => {
  event.preventDefault();
  lookupTicket($('#ticket-code').value.trim());
});

async function lookupTicket(value) {
  const result = $('#checkin-result');
  result.replaceChildren();
  pendingCheckinValue = value;
  try {
    const ticket = await api('/api/check-in/lookup', { method: 'POST', body: JSON.stringify({ value }) });
    renderCheckinResult(ticket);
  } catch (error) {
    const box = document.createElement('div');
    box.className = 'checkin-result error';
    box.textContent = error.message;
    result.append(box);
  }
}

function renderCheckinResult(ticket, successMessage = '') {
  const result = $('#checkin-result');
  result.replaceChildren();
  const box = document.createElement('div');
  box.className = `checkin-result ${ticket.status === 'valid' ? 'valid' : ticket.status}`;
  const title = document.createElement('strong');
  title.textContent = successMessage || (ticket.status === 'valid' ? 'Billet valide — entrée à confirmer' : ticket.status === 'used' ? 'Billet déjà utilisé' : 'Billet annulé');
  const details = document.createElement('p');
  details.textContent = `${ticket.buyerName} · ${ticket.passLabel} · ${ticket.code}`;
  box.append(title, details);
  if (ticket.checkedInAt) {
    const entered = document.createElement('p');
    entered.textContent = `Entrée enregistrée le ${formatDate(ticket.checkedInAt)}`;
    box.append(entered);
  }
  if (ticket.status === 'valid') {
    const confirm = document.createElement('button');
    confirm.className = 'primary'; confirm.type = 'button'; confirm.textContent = 'Confirmer l’entrée';
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        const response = await api('/api/check-in/confirm', { method: 'POST', body: JSON.stringify({ value: pendingCheckinValue }) });
        renderCheckinResult(response.ticket, response.message);
        toast(response.message);
      } catch (error) {
        confirm.disabled = false;
        const failed = document.createElement('p'); failed.className = 'error'; failed.textContent = error.message; box.append(failed);
      }
    });
    box.append(confirm);
  }
  result.append(box);
}

async function loadHistory() {
  if (activeRole !== 'admin') return;
  $('#history-message').textContent = 'Chargement…';
  try {
    const data = await api('/api/tickets?q=' + encodeURIComponent($('#history-search').value.trim()));
    renderHistory(data);
    $('#history-message').textContent = `${data.tickets.length} billet(s) affiché(s), maximum 500.`;
  } catch (error) { $('#history-message').textContent = error.message; }
}

function renderHistory(data) {
  const stats = $('#stats');
  stats.replaceChildren();
  const statItems = [
    ['Billets actifs', data.totals.total],
    ['Entrées', data.totals.checked_in],
    ['Recettes', money(data.totals.revenue)],
  ];
  for (const [label, value] of statItems) {
    const card = document.createElement('div'); card.className = 'stat';
    const number = document.createElement('strong'); number.textContent = value;
    const caption = document.createElement('span'); caption.textContent = label;
    card.append(number, caption); stats.append(card);
  }
  const body = $('#history-body');
  body.replaceChildren();
  for (const ticket of data.tickets) {
    const row = document.createElement('tr');
    const values = [ticket.code, ticket.buyerName, ticket.buyerPhone, ticket.passLabel, money(ticket.price), formatDate(ticket.createdAt)];
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    const status = document.createElement('td');
    status.className = `status-${ticket.status}`;
    status.textContent = ticket.status === 'valid' ? 'Valide' : ticket.status === 'used' ? `Entré · ${formatDate(ticket.checkedInAt)}` : 'Annulé';
    row.append(status);
    const actions = document.createElement('td');
    const group = document.createElement('div'); group.className = 'row-actions';
    if (ticket.status === 'valid') {
      const reissue = document.createElement('button'); reissue.type = 'button'; reissue.className = 'secondary'; reissue.textContent = 'Réimprimer';
      reissue.addEventListener('click', () => reissueQr(ticket));
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'Annuler';
      cancel.addEventListener('click', () => cancelTicket(ticket));
      group.append(reissue, cancel);
    }
    actions.append(group); row.append(actions); body.append(row);
  }
}

async function reissueQr(ticket) {
  if (!window.confirm(`Réémettre le QR code de ${ticket.code} ? L’ancien QR deviendra invalide.`)) return;
  try {
    const result = await api(`/api/tickets/${encodeURIComponent(ticket.id)}/reissue-qr`, { method: 'POST', body: '{}' });
    renderTicketPreview(result.ticket, result.qrDataUrl);
    activateTab('create-panel');
    toast(`Nouveau QR émis pour ${ticket.code}.`);
    loadHistory();
  } catch (error) { toast(error.message); }
}

async function cancelTicket(ticket) {
  if (!window.confirm(`Annuler le billet ${ticket.code} de ${ticket.buyerName} ? Cette action sera enregistrée dans le journal.`)) return;
  try {
    await api(`/api/tickets/${encodeURIComponent(ticket.id)}`, { method: 'DELETE' });
    toast(`Billet ${ticket.code} annulé.`);
    loadHistory();
  } catch (error) { toast(error.message); }
}

$('#history-search').addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(loadHistory, 250);
});
$('#refresh-history').addEventListener('click', loadHistory);
$('#export-history').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/tickets/export', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Export impossible.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'festin-tickets-export.json'; link.click();
    URL.revokeObjectURL(url);
  } catch (error) { toast(error.message); }
});

$('#import-history').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 2_000_000) return toast('Le fichier dépasse la limite de 2 Mo.');
  try {
    const tickets = JSON.parse(await file.text());
    if (!Array.isArray(tickets)) throw new Error('Le fichier doit contenir une liste de billets JSON.');
    const result = await api('/api/tickets/import', { method: 'POST', body: JSON.stringify({ tickets }) });
    toast(`Import terminé : ${result.imported} importé(s), ${result.merged} entrée(s) fusionnée(s).`);
    loadHistory();
  } catch (error) { toast(error.message || 'Fichier invalide.'); }
});

$('#start-camera').addEventListener('click', startCamera);
$('#stop-camera').addEventListener('click', stopCamera);

async function startCamera() {
  const message = $('#camera-message');
  message.textContent = '';
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    message.textContent = 'La caméra nécessite HTTPS. Saisissez le code du billet manuellement.';
    return;
  }
  if (!('BarcodeDetector' in window)) {
    message.textContent = 'La lecture QR automatique n’est pas disponible dans ce navigateur. Utilisez la saisie manuelle.';
    return;
  }
  try {
    barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const video = $('#camera'); video.srcObject = cameraStream; video.classList.remove('hidden');
    $('#camera-hint').classList.add('hidden'); $('#start-camera').classList.add('hidden'); $('#stop-camera').classList.remove('hidden');
    scanning = true;
    await video.play();
    scanLoop();
  } catch {
    message.textContent = 'Impossible d’ouvrir la caméra. Vérifiez la permission ou utilisez la saisie manuelle.';
    stopCamera();
  }
}

async function scanLoop() {
  if (!scanning) return;
  try {
    const codes = await barcodeDetector.detect($('#camera'));
    if (codes.length) {
      const raw = codes[0].rawValue;
      stopCamera();
      $('#camera-message').textContent = 'QR code détecté.';
      $('#ticket-code').value = raw;
      await lookupTicket(raw);
      return;
    }
  } catch { $('#camera-message').textContent = 'Lecture interrompue. Vous pouvez saisir le code manuellement.'; stopCamera(); return; }
  if (scanning) requestAnimationFrame(scanLoop);
}

function stopCamera() {
  scanning = false;
  if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = null;
  const video = $('#camera');
  if (video) { video.pause(); video.srcObject = null; video.classList.add('hidden'); }
  $('#camera-hint')?.classList.remove('hidden');
  $('#start-camera')?.classList.remove('hidden');
  $('#stop-camera')?.classList.add('hidden');
}

let toastTimer;
function toast(message) {
  const target = $('#toast'); target.textContent = message; target.classList.add('show');
  window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => target.classList.remove('show'), 3500);
}

async function initialize() {
  try { showApp(await api('/api/auth/session')); }
  catch { showLogin(); }
}
initialize();
