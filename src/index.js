// LOWER TOWER — bot Telegram d'administration
// Principe : le bot n'a AUCUNE règle métier. Chaque administrateur autorisé est relié à SON compte du site.
// Le bot s'y connecte avec la clé publique (jamais de clé secrète) et appelle les mêmes fonctions serveur que le site :
// les permissions, confirmations, journaux d'audit et règles financières sont donc exactement les mêmes.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Bot, InlineKeyboard } from 'grammy';
import { createClient } from '@supabase/supabase-js';

const { TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error('Variables manquantes : TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (voir .env.example).');
  process.exit(1);
}
let ADMINS = [];
try { ADMINS = JSON.parse(process.env.ADMINS_JSON || '[]'); } catch { console.error('ADMINS_JSON invalide.'); process.exit(1); }
const ALERT_TYPES = (process.env.ALERT_TYPES || 'bank_loan_request,chat_report,shop_sale').split(',').map((s) => s.trim()).filter(Boolean);
const POLL_MS = 20000;
const DATA_DIR = path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const bot = new Bot(TELEGRAM_BOT_TOKEN);
const sessions = new Map(); // telegram_id -> { sb, userId, label }
const flows = new Map();    // telegram_id -> { type, step, data, ts }
const lastCmd = new Map();

// ---------- utilitaires ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n ?? 0).toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');
const cur = (c) => (c === 'GEM' ? 'Gems' : 'AC');
const dt = (iso) => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', dateStyle: 'short', timeStyle: 'short' });
const chunks = (t, n = 3500) => { const out = []; for (let i = 0; i < t.length; i += n) out.push(t.slice(i, i + n)); return out.length ? out : ['(vide)']; };
const setFlow = (id, f) => flows.set(id, { ...f, ts: Date.now() });
const getFlow = (id) => { const f = flows.get(id); if (f && Date.now() - f.ts > 600000) { flows.delete(id); return null; } return f || null; };
const html = { parse_mode: 'HTML' };

async function rpc(sb, name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
const S = (ctx) => sessions.get(ctx.from.id);

// ---------- connexion des administrateurs ----------
async function login(entry) {
  const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: true } });
  const email = `${String(entry.phone).replace(/\D/g, '')}@phone.lowertower.app`;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: entry.password });
  if (error) throw new Error(`connexion refusée pour ${entry.telegram_id} : ${error.message}`);
  const perms = await rpc(sb, 'my_permissions');
  const p = Array.isArray(perms) ? perms[0] : perms;
  if (!p || p.role === 'player') throw new Error(`le compte lié à ${entry.telegram_id} n'est ni OWNER ni ADMIN`);
  sessions.set(Number(entry.telegram_id), { sb, userId: data.user.id, role: p.role, permissions: p.permissions || [] });
}

// ---------- contrôle d'accès ----------
bot.command('id', (ctx) => ctx.reply(`Ton identifiant Telegram : ${ctx.from.id}`)); // utile pour remplir ADMINS_JSON
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private') return; // jamais dans les groupes
  if (!sessions.has(ctx.from?.id)) {
    console.warn(`[refusé] telegram_id=${ctx.from?.id}`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Accès refusé.' });
    else await ctx.reply('Accès refusé.');
    return;
  }
  const now = Date.now();
  if (now - (lastCmd.get(ctx.from.id) || 0) < 700) return; // limitation de fréquence
  lastCmd.set(ctx.from.id, now);
  await next();
});

// ---------- menus ----------
const mainMenu = () => new InlineKeyboard()
  .text('📊 Statistiques', 'm:stats').text('🔎 Joueur', 'm:player').row()
  .text('🏦 Prêts', 'm:loans').text('📅 Évents', 'm:events').row()
  .text('🛒 Boutique', 'm:shop');
const confirmKb = (key) => new InlineKeyboard().text('✅ Confirmer', `cf:${key}`).text('✖️ Annuler', 'no');

bot.command(['start', 'aide', 'help', 'menu'], (ctx) => ctx.reply('LOWER TOWER — administration. Que veux-tu faire ?', { reply_markup: mainMenu() }));
bot.command('annuler', (ctx) => { flows.delete(ctx.from.id); return ctx.reply('Opération annulée.'); });
bot.callbackQuery('no', async (ctx) => { flows.delete(ctx.from.id); await ctx.answerCallbackQuery(); await ctx.editMessageText('Opération annulée.'); });

// ---------- statistiques ----------
async function showStats(ctx) {
  const j = await rpc(S(ctx).sb, 'admin_stats');
  await ctx.reply(
    `<b>Statistiques</b>\nJoueurs : ${j.players_active} actifs / ${j.players_total} (en ligne : ${j.online_now})\n` +
    `Comptes : ${j.individual_accounts} individuels, ${j.union_accounts} unions\n` +
    `Abyss Coins en circulation : ${fmt(j.ac_total)}\nGems en circulation : ${fmt(j.gem_total)}\n` +
    `Prêts en cours : ${j.loans_active} (en retard : ${j.loans_overdue})\nDemandes Ask Loan en attente : ${j.bank_loan_requests_pending}\n` +
    `Boutique : ${j.shop_available} disponibles, ${j.shop_sold} vendus\nÉvents à venir : ${j.events_upcoming}\nSignalements ouverts : ${j.chat_reports_open}`, html);
}
bot.command('stats', showStats);

// ---------- joueurs ----------
async function searchPlayers(ctx, text) {
  const rows = await rpc(S(ctx).sb, 'admin_list_players', { _search: text, _status: null, _limit: 8, _offset: 0 });
  if (!rows.length) return ctx.reply('Aucun joueur trouvé.');
  const kb = new InlineKeyboard();
  rows.forEach((p) => kb.text(`${p.pseudo} (${p.display_name}) — ${p.status === 'active' ? p.class : '⛔'}`.slice(0, 60), `pl:${p.id}`).row());
  await ctx.reply('Résultats :', { reply_markup: kb });
}
async function showPlayer(ctx, id) {
  const rows = await rpc(S(ctx).sb, 'admin_list_players', { _search: null, _status: null, _limit: 200, _offset: 0 });
  const p = rows.find((r) => r.id === id);
  if (!p) return ctx.reply('Joueur introuvable.');
  const kb = new InlineKeyboard()
    .text('📜 Fiche', `sh:${id}`).text('🧾 Historique', `hi:${id}`).row()
    .text('➕ Créditer', `bal:credit:${id}`).text('➖ Débiter', `bal:debit:${id}`).row()
    .text(p.status === 'active' ? '⛔ Suspendre' : '✅ Réactiver', `st:${p.status === 'active' ? 'suspended' : 'active'}:${id}`);
  await ctx.reply(
    `<b>${esc(p.display_name)}</b> (${esc(p.pseudo)})\nClasse : ${esc(p.class)} — Niveau ${p.level}\nStatut : ${p.status}\n` +
    `Abyss Coins : ${fmt(p.ac)} — Gems : ${fmt(p.gem)}\nRôles : ${esc((p.roles || []).join(', '))}\nTéléphone : ${esc(p.phone)}`, { ...html, reply_markup: kb });
}
bot.command('joueur', async (ctx) => {
  const q = ctx.match?.trim();
  if (q) return searchPlayers(ctx, q);
  setFlow(ctx.from.id, { type: 'search' });
  return ctx.reply('Nom, pseudo ou numéro à rechercher ?');
});
bot.callbackQuery(/^pl:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showPlayer(ctx, ctx.match[1]); });
bot.callbackQuery(/^sh:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows = await rpc(S(ctx).sb, 'get_sheet', { _user_id: ctx.match[1] });
  const r = Array.isArray(rows) ? rows[0] : rows;
  if (!r) return ctx.reply('Aucune fiche enregistrée.');
  for (const c of chunks(r.rendered_text || '(fiche vide)')) await ctx.reply(`<pre>${esc(c)}</pre>`, html);
});
bot.callbackQuery(/^hi:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows = await rpc(S(ctx).sb, 'admin_player_ledger', { _user_id: ctx.match[1], _before: null, _limit: 12 });
  if (!rows.length) return ctx.reply('Aucune opération.');
  await ctx.reply(rows.map((r) => `${dt(r.created_at)} · ${esc(r.type)} · ${r.delta > 0 ? '+' : ''}${fmt(r.delta)} ${cur(r.currency)} → ${fmt(r.balance_after)}${r.scope === 'union' ? ' (compte commun)' : ''}`).join('\n'));
});

// ---------- ajustement de solde (confirmation obligatoire) ----------
bot.callbackQuery(/^bal:(credit|debit):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  setFlow(ctx.from.id, { type: 'bal', step: 'currency', data: { dir: ctx.match[1], uid: ctx.match[2] } });
  await ctx.reply('Quelle monnaie ?', { reply_markup: new InlineKeyboard().text('Abyss Coins', 'cur:AC').text('Gems', 'cur:GEM') });
});
bot.callbackQuery(/^cur:(AC|GEM)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const f = getFlow(ctx.from.id);
  if (!f) return ctx.reply('Session expirée, recommence.');
  f.data.currency = ctx.match[1];
  if (f.type === 'bal') { f.step = 'amount'; setFlow(ctx.from.id, f); return ctx.reply('Montant (nombre entier) ?'); }
  if (f.type === 'shop_new') { f.step = 'photo'; setFlow(ctx.from.id, f); return ctx.reply('Envoie la photo de l\'article, ou « - » pour aucune photo.'); }
});
bot.callbackQuery(/^st:(active|suspended):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  setFlow(ctx.from.id, { type: 'status', step: 'reason', data: { status: ctx.match[1], uid: ctx.match[2] } });
  await ctx.reply('Motif (obligatoire) ?');
});

// ---------- prêts (Ask Loan) ----------
async function showLoans(ctx) {
  const rows = await rpc(S(ctx).sb, 'admin_list_loans', { _status: 'pending', _kind: 'bank' });
  if (!rows.length) return ctx.reply('Aucune demande Ask Loan en attente.');
  for (const l of rows.slice(0, 10)) {
    const kb = new InlineKeyboard().text('✅ Approuver', `ln:a:${l.id}`).text('❌ Refuser', `ln:r:${l.id}`);
    await ctx.reply(`<b>${esc(l.borrower_pseudo)}</b> demande ${fmt(l.principal)} ${cur(l.currency)}\nÉchéance : ${dt(l.due_at)}\nPlafond actuel : ${fmt(l.ceiling)} ${cur(l.currency)}`, { ...html, reply_markup: kb });
  }
}
bot.command('prets', showLoans);
bot.command('retards', async (ctx) => {
  const rows = await rpc(S(ctx).sb, 'admin_list_loans', { _status: 'active', _kind: null });
  const late = rows.filter((l) => new Date(l.due_at) <= new Date());
  await ctx.reply(late.length ? late.slice(0, 20).map((l) => `${esc(l.borrower_pseudo)} doit ${fmt(l.remaining)} ${cur(l.currency)} (échu le ${dt(l.due_at)})`).join('\n') : 'Aucune dette en retard.');
});
bot.callbackQuery(/^ln:(a|r):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const approve = ctx.match[1] === 'a';
  await ctx.reply(approve ? 'Confirmer l\'approbation ? La monnaie sera créée sur le compte du joueur.' : 'Confirmer le refus ?',
    { reply_markup: new InlineKeyboard().text('✅ Oui', `lc:${ctx.match[1]}:${ctx.match[2]}`).text('✖️ Non', 'no') });
});
bot.callbackQuery(/^lc:(a|r):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await rpc(S(ctx).sb, 'approve_bank_loan', { _loan_id: ctx.match[2], _approve: ctx.match[1] === 'a' });
  await ctx.editMessageText(res === 'active' ? '✅ Prêt accordé.' : '❌ Prêt refusé.');
});

// ---------- évents ----------
async function showEvents(ctx) {
  const rows = await rpc(S(ctx).sb, 'admin_events_list');
  if (!rows.length) await ctx.reply('Aucun évent.');
  for (const e of rows.slice(0, 8)) {
    const kb = new InlineKeyboard();
    if (e.status !== 'published') kb.text('📣 Publier', `ev:published:${e.id}`);
    if (e.status === 'published') kb.text('📥 Dépublier', `ev:draft:${e.id}`);
    if (e.status !== 'cancelled') kb.text('🚫 Annuler', `ev:cancelled:${e.id}`);
    await ctx.reply(`<b>${esc(e.title)}</b> [${e.status}]\n${dt(e.starts_at)}${e.location ? ' — ' + esc(e.location) : ''}`, { ...html, reply_markup: kb });
  }
  await ctx.reply('Créer un évent ?', { reply_markup: new InlineKeyboard().text('➕ Nouvel évent', 'evnew') });
}
bot.command('events', showEvents);
bot.callbackQuery(/^ev:(published|draft|cancelled):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await rpc(S(ctx).sb, 'admin_set_event_status', { _id: ctx.match[2], _status: ctx.match[1] });
  await ctx.reply('✅ Statut mis à jour.');
});
bot.callbackQuery('evnew', async (ctx) => { await ctx.answerCallbackQuery(); setFlow(ctx.from.id, { type: 'ev_new', step: 'title', data: {} }); await ctx.reply('Titre de l\'évent ?'); });

// ---------- boutique ----------
async function showShop(ctx) {
  const rows = await rpc(S(ctx).sb, 'admin_shop_list');
  const lines = rows.slice(0, 15).map((s) => `${s.status === 'sold' ? '🔴' : s.status === 'withdrawn' ? '⚪' : '🟢'} ${esc(s.name)} — ${fmt(s.price)} ${cur(s.currency)}${s.buyer_pseudo ? ' → ' + esc(s.buyer_pseudo) : ''}`);
  await ctx.reply(lines.length ? lines.join('\n') : 'Aucun article.', { ...html, reply_markup: new InlineKeyboard().text('➕ Nouvel article', 'shopnew') });
}
bot.command('boutique', showShop);
bot.callbackQuery('shopnew', async (ctx) => { await ctx.answerCallbackQuery(); setFlow(ctx.from.id, { type: 'shop_new', step: 'name', data: {} }); await ctx.reply('Nom de l\'article ?'); });

// ---------- menu principal ----------
bot.callbackQuery(/^m:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const k = ctx.match[1];
  if (k === 'stats') return showStats(ctx);
  if (k === 'player') { setFlow(ctx.from.id, { type: 'search' }); return ctx.reply('Nom, pseudo ou numéro à rechercher ?'); }
  if (k === 'loans') return showLoans(ctx);
  if (k === 'events') return showEvents(ctx);
  if (k === 'shop') return showShop(ctx);
});

// ---------- confirmations finales ----------
bot.callbackQuery(/^cf:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const f = getFlow(ctx.from.id);
  flows.delete(ctx.from.id);
  if (!f) return ctx.reply('Session expirée, recommence.');
  const { sb } = S(ctx);
  const key = ctx.match[1];
  if (key === 'bal' && f.type === 'bal') {
    await rpc(sb, 'admin_adjust_balance', { _user_id: f.data.uid, _currency: f.data.currency, _amount: f.data.amount, _direction: f.data.dir, _reason: f.data.reason, _confirm: true });
    return ctx.editMessageText('✅ Opération effectuée et inscrite au journal d\'audit.');
  }
  if (key === 'st' && f.type === 'status') {
    await rpc(sb, 'admin_set_account_status', { _user_id: f.data.uid, _status: f.data.status, _reason: f.data.reason });
    return ctx.editMessageText('✅ Statut du compte mis à jour.');
  }
  if ((key === 'evp' || key === 'evd') && f.type === 'ev_new') {
    await rpc(sb, 'admin_create_event', { _title: f.data.title, _description: f.data.desc, _image_path: null, _starts_at: f.data.iso, _location: f.data.place, _publish: key === 'evp' });
    return ctx.editMessageText(key === 'evp' ? '✅ Évent publié (les joueurs sont notifiés).' : '✅ Évent enregistré en brouillon.');
  }
  if (key === 'shop' && f.type === 'shop_new') {
    let imagePath = null;
    if (f.data.fileId) {
      const file = await ctx.api.getFile(f.data.fileId);
      const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 3 * 1024 * 1024) throw new Error('Image trop lourde (3 Mo maximum).');
      imagePath = `${S(ctx).userId}/${Date.now()}.jpg`;
      const up = await sb.storage.from('shop').upload(imagePath, buf, { contentType: 'image/jpeg' });
      if (up.error) throw new Error(up.error.message);
    }
    await rpc(sb, 'admin_create_shop_item', { _name: f.data.name, _description: f.data.desc, _image_path: imagePath, _price: f.data.price, _currency: f.data.currency });
    return ctx.editMessageText('✅ Article créé dans la Guilde marchande.');
  }
  return ctx.reply('Confirmation inattendue.');
});

// ---------- saisies guidées (texte et photo) ----------
const parseInt0 = (t) => { const n = Number(String(t).replace(/[\s.,]/g, '')); return Number.isSafeInteger(n) && n > 0 ? n : null; };
function parseDate(t) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+01:00`; // heure du Cameroun
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}
bot.on('message:text', async (ctx) => {
  const f = getFlow(ctx.from.id);
  const t = ctx.message.text.trim();
  if (!f) return ctx.reply('Utilise /menu pour commencer.');
  if (f.type === 'search') { flows.delete(ctx.from.id); return searchPlayers(ctx, t); }
  if (f.type === 'bal') {
    if (f.step === 'amount') { const n = parseInt0(t); if (!n) return ctx.reply('Montant invalide : entre un nombre entier positif.'); f.data.amount = n; f.step = 'reason'; setFlow(ctx.from.id, f); return ctx.reply('Motif (obligatoire) ?'); }
    if (f.step === 'reason') {
      if (t.length < 3) return ctx.reply('Motif trop court.');
      f.data.reason = t; setFlow(ctx.from.id, f);
      return ctx.reply(`<b>Confirmer ?</b>\n${f.data.dir === 'credit' ? 'Créditer' : 'Débiter'} ${fmt(f.data.amount)} ${cur(f.data.currency)}\nMotif : ${esc(t)}`, { ...html, reply_markup: confirmKb('bal') });
    }
  }
  if (f.type === 'status' && f.step === 'reason') {
    if (t.length < 3) return ctx.reply('Motif trop court.');
    f.data.reason = t; setFlow(ctx.from.id, f);
    return ctx.reply(`<b>Confirmer ?</b>\n${f.data.status === 'suspended' ? 'Suspendre' : 'Réactiver'} ce compte.\nMotif : ${esc(t)}`, { ...html, reply_markup: confirmKb('st') });
  }
  if (f.type === 'ev_new') {
    if (f.step === 'title') { f.data.title = t.slice(0, 120); f.step = 'date'; setFlow(ctx.from.id, f); return ctx.reply('Date et heure (heure du Cameroun) au format JJ/MM/AAAA HH:MM ?'); }
    if (f.step === 'date') { const iso = parseDate(t); if (!iso) return ctx.reply('Format invalide. Exemple : 31/12/2026 20:00'); f.data.iso = iso; f.step = 'place'; setFlow(ctx.from.id, f); return ctx.reply('Lieu ou indication ? (« - » pour aucun)'); }
    if (f.step === 'place') { f.data.place = t === '-' ? null : t.slice(0, 200); f.step = 'desc'; setFlow(ctx.from.id, f); return ctx.reply('Description ? (« - » pour aucune)'); }
    if (f.step === 'desc') {
      f.data.desc = t === '-' ? '' : t.slice(0, 5000); setFlow(ctx.from.id, f);
      const kb = new InlineKeyboard().text('📣 Publier', 'cf:evp').text('📝 Brouillon', 'cf:evd').row().text('✖️ Annuler', 'no');
      return ctx.reply(`<b>Nouvel évent</b>\n${esc(f.data.title)}\n${dt(f.data.iso)}${f.data.place ? ' — ' + esc(f.data.place) : ''}\n${esc(f.data.desc)}`, { ...html, reply_markup: kb });
    }
  }
  if (f.type === 'shop_new') {
    if (f.step === 'name') { f.data.name = t.slice(0, 80); f.step = 'desc'; setFlow(ctx.from.id, f); return ctx.reply('Description ? (« - » pour aucune)'); }
    if (f.step === 'desc') { f.data.desc = t === '-' ? '' : t.slice(0, 2000); f.step = 'price'; setFlow(ctx.from.id, f); return ctx.reply('Prix (nombre entier) ?'); }
    if (f.step === 'price') { const n = parseInt0(t); if (!n) return ctx.reply('Prix invalide.'); f.data.price = n; f.step = 'currency'; setFlow(ctx.from.id, f); return ctx.reply('Monnaie ?', { reply_markup: new InlineKeyboard().text('Abyss Coins', 'cur:AC').text('Gems', 'cur:GEM') }); }
    if (f.step === 'photo' && t === '-') { f.step = 'confirm'; setFlow(ctx.from.id, f); return askShopConfirm(ctx, f); }
  }
  return ctx.reply('Réponse non attendue. /annuler pour quitter l\'opération en cours.');
});
bot.on('message:photo', async (ctx) => {
  const f = getFlow(ctx.from.id);
  if (!f || f.type !== 'shop_new' || f.step !== 'photo') return ctx.reply('Aucune photo attendue.');
  const sizes = ctx.message.photo;
  f.data.fileId = sizes[sizes.length - 1].file_id; f.step = 'confirm'; setFlow(ctx.from.id, f);
  return askShopConfirm(ctx, f);
});
function askShopConfirm(ctx, f) {
  return ctx.reply(`<b>Nouvel article</b>\n${esc(f.data.name)}\n${esc(f.data.desc)}\nPrix : ${fmt(f.data.price)} ${cur(f.data.currency)}\nPhoto : ${f.data.fileId ? 'oui' : 'non'}`, { ...html, reply_markup: confirmKb('shop') });
}

// ---------- alertes administratives (notifications du compte lié) ----------
async function pollAlerts() 