// LOWER TOWER — bot Telegram d'administration (v1.1)
// Principe : le bot n'a AUCUNE règle métier. Chaque administrateur autorisé est relié à SON compte du site.
// Le bot s'y connecte avec la clé publique (jamais de clé secrète) et appelle les mêmes fonctions serveur que le site :
// permissions, confirmations, journaux d'audit et règles financières restent ceux du site.
//
// v1.1 : FEATURES_JSON — le bot s'adapte à l'avancement du site (phase 1 → 5).
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

// ---------- calage sur l'avancement du site ----------
// Phase 1 : "stats","joueur" | 2 : "audit" | 3 : "prets" | 4 : "events","boutique" | 5 : "owner"
let FEATURES = ['stats', 'joueur'];
try { FEATURES = JSON.parse(process.env.FEATURES_JSON || '["stats","joueur"]'); } catch { console.warn('FEATURES_JSON invalide, valeur par défaut.'); }
const has = (f) => FEATURES.includes(f);

const ALERT_TYPES = (process.env.ALERT_TYPES || 'bank_loan_request,chat_report,shop_sale').split(',').map((s) => s.trim()).filter(Boolean);
const POLL_MS = 20000;
const DATA_DIR = path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const bot = new Bot(TELEGRAM_BOT_TOKEN);
const sessions = new Map(); // telegram_id -> { sb, userId, role, permissions }
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
const S = (ctx) => sessions.get(ctx.from.id);

async function rpc(sb, name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

// RPC protégé : message propre si la fonction n'existe pas encore côté site
async function safeRpc(ctx, name, args = {}, feature = null) {
  if (feature && !has(feature)) {
    await ctx.reply("⚠️ Fonctionnalité pas encore active : le site n'a pas atteint cette phase.");
    return null;
  }
  try {
    return await rpc(S(ctx).sb, name, args);
  } catch (e) {
    if (/could not find the function|404|PGRST202/i.test(e.message)) {
      console.warn(`[fonction absente] ${name}`);
      await ctx.reply("⚠️ La fonction serveur n'existe pas encore sur le site (phase en construction).");
      return null;
    }
    throw e;
  }
}

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
  console.log(`[ok] ${entry.telegram_id} connecté (${p.role})`);
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
const mainMenu = () => {
  const kb = new InlineKeyboard();
  if (has('stats')) kb.text('📊 Statistiques', 'm:stats');
  if (has('joueur')) kb.text('🔎 Joueur', 'm:player');
  kb.row();
  if (has('prets')) kb.text('🏦 Prêts', 'm:loans');
  if (has('events')) kb.text('📅 Évents', 'm:events');
  if (has('boutique')) kb.text('🛒 Boutique', 'm:shop');
  kb.row();
  if (has('audit')) kb.text('📜 Audit', 'm:audit');
  if (has('owner')) kb.text('👑 OWNER', 'm:owner');
  return kb;
};
const confirmKb = () => new InlineKeyboard().text('✅ Confirmer', 'cf').text('✖️ Annuler', 'no');
const backKb = () => new InlineKeyboard().text('◀️ Menu', 'menu');

bot.command(['start', 'aide', 'help', 'menu'], (ctx) => ctx.reply('LOWER TOWER — administration. Que veux-tu faire ?', { ...html, reply_markup: mainMenu() }));
bot.command('annuler', (ctx) => { flows.delete(ctx.from.id); return ctx.reply('Opération annulée.'); });
bot.callbackQuery('menu', async (ctx) => { flows.delete(ctx.from.id); await ctx.answerCallbackQuery(); await ctx.editMessageText('LOWER TOWER — administration. Que veux-tu faire ?', { ...html, reply_markup: mainMenu() }); });
bot.callbackQuery('no', async (ctx) => { flows.delete(ctx.from.id); await ctx.answerCallbackQuery(); await ctx.editMessageText('Opération annulée.'); });

// ---------- confirmation générique ----------
function askConfirm(ctx, label, rpcName, args, feature = null) {
  setFlow(ctx.from.id, { type: 'exec', data: { label, rpcName, args, feature } });
  ctx.reply(`⚠️ <b>Confirmer ?</b>\n\n${label}\n\nCette action sera inscrite au journal d'audit.`, { ...html, reply_markup: confirmKb() });
}
bot.callbackQuery('cf', async (ctx) => {
  const f = getFlow(ctx.from.id);
  if (!f || f.type !== 'exec') return ctx.answerCallbackQuery({ text: 'Rien à confirmer (expiré ?).' });
  await ctx.answerCallbackQuery('En cours…');
  const { label, rpcName, args, feature } = f.data;
  try {
    const res = await safeRpc(ctx, rpcName, args, feature);
    flows.delete(ctx.from.id);
    const extra = res ? `\n<code>${esc(typeof res === 'object' ? JSON.stringify(res) : String(res)).slice(0, 300)}</code>` : '';
    await ctx.editMessageText(`✅ Fait : ${label}${extra}`, html);
  } catch (e) {
    await ctx.editMessageText(`❌ Erreur : ${esc(e.message)}`, html);
  }
});

// ---------- statistiques (phase 1) ----------
async function showStats(ctx) {
  const j = await safeRpc(ctx, 'admin_stats', {}, 'stats');
  if (!j) return;
  const s = Array.isArray(j) ? j[0] : j;
  await ctx.reply(
    `<b>Statistiques</b>\nJoueurs : ${s.players_active} actifs / ${s.players_total} (en ligne : ${s.online_now})\n` +
    `Comptes : ${s.individual_accounts} individuels, ${s.union_accounts} unions\n` +
    `Abyss Coins en circulation : ${fmt(s.ac_total)}\nGems en circulation : ${fmt(s.gem_total)}\n` +
    `Prêts en cours : ${s.loans_active} (en retard : ${s.loans_overdue})\nDemandes Ask Loan en attente : ${s.bank_loan_requests_pending}\n` +
    `Boutique : ${s.shop_available} disponibles, ${s.shop_sold} vendus\nÉvents à venir : ${s.events_upcoming}\nSignalements ouverts : ${s.chat_reports_open}`, html);
}
bot.command('stats', showStats);
bot.callbackQuery('m:stats', async (ctx) => { await ctx.answerCallbackQuery(); await showStats(ctx); });

// ---------- joueurs (phase 1) ----------
async function searchPlayers(ctx, text) {
  const rows = await safeRpc(ctx, 'admin_list_players', { _search: text, _status: null, _limit: 8, _offset: 0 }, 'joueur');
  if (!rows) return;
  if (!rows.length) return ctx.reply('Aucun joueur trouvé.');
  const kb = new InlineKeyboard();
  rows.forEach((p) => kb.text(`${p.pseudo} (${p.display_name})${p.status !== 'active' ? ' ⛔' : ''}`, `p:${p.id}`).row());
  kb.text('◀️ Menu', 'menu');
  await ctx.reply(`${rows.length} joueur(s) trouvé(s) :`, { ...html, reply_markup: kb });
}
bot.command('joueur', (ctx) => {
  const t = ctx.message.text.replace(/^\/joueur\s*/i, '').trim();
  if (!t) { setFlow(ctx.from.id, { type: 'search', data: {} }); return ctx.reply('Envoie le nom, le pseudo ou le numéro du joueur.'); }
  return searchPlayers(ctx, t);
});
bot.callbackQuery('m:player', async (ctx) => { await ctx.answerCallbackQuery(); setFlow(ctx.from.id, { type: 'search', data: {} }); await ctx.reply('Envoie le nom, le pseudo ou le numéro du joueur.'); });

async function showPlayer(ctx, id) {
  const res = await safeRpc(ctx, 'admin_player_details', { _id: id }, 'joueur');
  if (!res) return;
  const p = Array.isArray(res) ? res[0] : res;
  setFlow(ctx.from.id, { type: 'player', data: { id } });
  const kb = new InlineKeyboard()
    .text('💰 Créditer', `pc:${id}`).text('💸 Débiter', `pd:${id}`).row()
    .text('✏️ Modifier', `pm:${id}`).text('📜 Historique', `ph:${id}`).row()
    .text(p.status === 'active' ? '⛔ Suspendre' : '✅ Réactiver', `ps:${id}`)
    .text('🔑 Mot de passe', `pr:${id}`).row()
    .text('◀️ Menu', 'menu');
  await ctx.reply(
    `<b>${esc(p.pseudo)}</b> (${esc(p.display_name)})\n` +
    `Statut : ${p.status === 'active' ? 'actif' : 'suspens'} · Niveau : ${p.level ?? '?'} · Classe : ${esc(p.class_name ?? '?')}\n` +
    `Solde : ${fmt(p.ac_balance ?? 0)} AC · ${fmt(p.gem_balance ?? 0)} Gems\n` +
    `Numéro : ${esc(p.phone ?? '—')}`, { ...html, reply_markup: kb });
}
bot.callbackQuery(/^p:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showPlayer(ctx, ctx.match[1]); });

// crédit / débit : choix devise → montant → motif → confirmation
function startAdjust(ctx, id, direction) {
  setFlow(ctx.from.id, { type: 'adjust', step: 'currency', data: { id, direction } });
  ctx.reply('Quelle devise ?', { ...html, reply_markup: new InlineKeyboard().text('Abyss Coins (AC)', 'cur:AC').text('Gems', 'cur:GEM').row().text('✖️ Annuler', 'no') });
}
bot.callbackQuery('pc:(\\d+)', (ctx) => { ctx.answerCallbackQuery(); startAdjust(ctx, ctx.match[1], 'credit'); });
bot.callbackQuery('pd:(\\d+)', (ctx) => { ctx.answerCallbackQuery(); startAdjust(ctx, ctx.match[1], 'debit'); });
bot.callbackQuery(/^cur:(AC|GEM)$/, async (ctx) => {
  const f = getFlow(ctx.from.id);
  if (!f || f.type !== 'adjust') return ctx.answerCallbackQuery({ text: 'Opération expirée.' });
  f.data.currency = ctx.match[1]; f.step = 'amount'; setFlow(ctx.from.id, f);
  await ctx.answerCallbackQuery();
  await ctx.reply(`Montant à ${f.data.direction === 'credit' ? 'créditer' : 'débiter'} en ${cur(f.data.currency)} ?`);
});

// modifier un joueur
bot.callbackQuery('pm:(\\d+)', async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.match[1];
  setFlow(ctx.from.id, { type: 'modif', step: 'field', data: { id } });
  await ctx.reply('Quel champ modifier ?', { ...html, reply_markup: new InlineKeyboard()
    .text('Nom', 'mf:name').text('Pseudo', 'mf:pseudo').row()
    .text('Classe', 'mf:class_name').text('Niveau (1-9999)', 'mf:level').row()
    .text('✖️ Annuler', 'no') });
});
bot.callbackQuery(/^mf:(\w+)$/, async (ctx) => {
  const f = getFlow(ctx.from.id);
  if (!f || f.type !== 'modif') return ctx.answerCallbackQuery({ text: 'Opération expirée.' });
  f.data.field = ctx.match[1]; f.step = 'value'; setFlow(ctx.from.id, f);
  await ctx.answerCallbackQuery();
  await ctx.reply(`Nouvelle valeur pour « ${f.data.field} » ?`);
});

// suspendre / réactiver
bot.callbackQuery('ps:(\\d+)', async (ctx) => {
  await ctx.answerCallbackQuery();
  const f = getFlow(ctx.from.id);
  const id = ctx.match[1];
  const res = await safeRpc(ctx, 'admin_player_details', { _id: id }, 'joueur');
  const p = Array.isArray(res) ? res[0] : res;
  const newStatus = p?.status === 'active' ? 'suspended' : 'active';
  setFlow(ctx.from.id, { type: 'motif', data: { label: `${newStatus === 'active' ? 'Réactiver' : 'Suspendre'} le joueur #${id}`, rpcName: 'admin_set_player_status', args: { _id: id, _status: newStatus } } });
  await ctx.reply('Motif (obligatoire, inscrit au journal d\u2019audit) ?');
});

// mot de passe temporaire
bot.callbackQuery('pr:(\\d+)', async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.match[1];
  askConfirm(ctx, `🔑 Générer un mot de passe temporaire pour le joueur #${id} (ses sessions seront coupées).`, 'admin_reset_password', { _id: id }, 'joueur');
});

// historique
bot.callbackQuery('ph:(\\d+)', async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows = await safeRpc(ctx, 'admin_player_history', { _id: ctx.match[1], _limit: 15 }, 'joueur');
  if (!rows?.length) return ctx.reply('Aucun historique.');
  const txt = rows.map((r) => `• <b>${esc(r.action)}</b> — ${fmt(r.amount ?? '')} ${r.currency ? cur(r.currency) : ''} · ${dt(r.created_at)}${r.motif ? `\n  ${esc(r.motif)}` : ''}`).join('\n');
  for (const c of chunks(`<b>📜 Historique (15 dernières entrées)</b>\n\n${txt}`)) await ctx.reply(c, html);
});

// ---------- saisies texte (étapes de flux) ----------
bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const f = getFlow(ctx.from.id);
  if (!f) return;
  const t = ctx.message.text.trim();
  const d = f.data;

if (f.type === 'search') { flows.delete(ctx.from.id); return searchPlayers(ctx, t); }

if (f.type === 'adjust' && f.step === 'amount') {
    const n = Number(t.replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return ctx.reply('Montant invalide. Réessaie :');
    d.amount = n; f.step = 'motif'; f.data = d; setFlow(ctx.from.id, f);
    return ctx.reply('Motif (obligatoire, inscrit au journal d\u2019audit) ?');
  }

if (f.type === 'modif' && f.step === 'value') {
    if (d.field === 'level') {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1 || n > 9999) return ctx.reply('Niveau invalide (1 à 9999). Réessaie :');
      d.value = n;
    } else { d.value = t; }
    f.step = 'motif'; f.data = d; setFlow(ctx.from.id, f);
    return ctx.reply('Motif (obligatoire, inscrit au journal d\u2019audit) ?');
  }

if (f.type === 'motif') {
    d.args = { ...(d.args || {}), _motif: t };
    flows.delete(ctx.from.id);
    return askConfirm(ctx, `${d.label} — motif : ${esc(t)}`, d.rpcName, d.args, d.feature || null);
  }

if (f.type === 'motif:adjust') {
    flows.delete(ctx.from.id);
    const rpcName = d.direction === 'credit' ? 'admin_credit_player' : 'admin_debit_player';
    return askConfirm(ctx, `${d.direction === 'credit' ? 'Créditer' : 'Débiter'} ${fmt(d.amount)} ${cur(d.currency)} au joueur #${d.id} — motif : ${esc(t)}`,
      rpcName, { _id: d.id, _amount: d.amount, _currency: d.currency, _motif: t }, 'joueur');
  }

if (f.type === 'motif:modif') {
    flows.delete(ctx.from.id);
    return askConfirm(ctx, `Modifier « ${d.field} » du joueur #${d.id} → « ${esc(d.value)} » — motif : ${esc(t)}`,
      'admin_update_player_field', { _id: d.id, _field: d.field, _value: d.value, _motif: t }, 'joueur');
  }
});
// aiguillage des flux vers leurs étapes « motif » finales
bot.use(async (ctx, next) => {
  if (!ctx.message?.text) return next();
  const f = getFlow(ctx.from.id);
  if (!f) return next();
  if (f.type === 'adjust' && f.step === 'motif') { f.type = 'motif:adjust'; setFlow(ctx.from.id, f); return; } // géré au prochain message
  if (f.type === 'modif' && f.step === 'motif') { f.type = 'motif:modif'; setFlow(ctx.from.id, f); return; }
  return next();
});

// ---------- journal d'audit (phase 1/2) ----------
async function showAudit(ctx, offset = 0) {
  const rows = await safeRpc(ctx, 'admin_audit_log', { _limit: 20, _offset: offset }, 'audit');
  if (!rows?.length) return ctx.reply(offset ? 'Plus rien.' : 'Journal vide.');
  const txt = rows.map((r) =>
    `• <b>${esc(r.action)}</b> — ${esc(r.actor_label ?? '')} · ${dt(r.created_at)}${r.details ? `\n  ${esc(r.details)}` : ''}`
  ).join('\n');
  const kb = new InlineKeyboard().text('⬇️ Suite', `audit:${offset + 20}`).text('◀️ Menu', 'menu');
  for (const c of chunks(`<b>📜 Journal d'audit ${offset ? '(suite)' : '— 20 dernières entrées'}</b>\n\n${txt}`)) {
    await ctx.reply(c, { ...html, reply_markup: kb });
  }
}
bot.command('audit', (ctx) => showAudit(ctx, 0));
bot.callbackQuery('m:audit', async (ctx) => { await ctx.answerCallbackQuery(); await showAudit(ctx, 0); });
bot.callbackQuery(/^audit:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showAudit(ctx, Number(ctx.match[1])); });

// ---------- prêts (phase 3) ----------
async function showLoans(ctx, status) {
  const rows = await safeRpc(ctx, 'admin_list_loans', { _status: status, _limit: 10 }, 'prets');
  if (!rows?.length) return ctx.reply(status === 'pending' ? 'Aucune demande Ask Loan en attente.' : 'Aucun retard.');
  const kb = new InlineKeyboard();
  rows.forEach((l) => {
    kb.text(`${fmt(l.amount)} AC — ${esc(l.pseudo ?? l.player_id)} (${dt(l.created_at)})`, `loan:${l.id}`).row();
  });
  kb.text('◀️ Menu', 'menu');
  await ctx.reply(`<b>${status === 'pending' ? '🏦 Demandes Ask Loan' : '⏰ Dettes en retard'}</b>`, { ...html, reply_markup: kb });
}
bot.command('prets', (ctx) => showLoans(ctx, 'pending'));
bot.command('retards', (ctx) => showLoans(ctx, 'overdue'));
bot.callbackQuery('m:loans', async (ctx) => { await ctx.answerCallbackQuery(); await showLoans(ctx, 'pending'); });
bot.callbackQuery(/^loan:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const kb = new InlineKeyboard().text('✅ Approuver', `la:ok:${id}`).text('❌ Refuser', `la:no:${id}`).row().text('✖️ Annuler', 'no');
  await ctx.answerCallbackQuery();
  await ctx.reply('Que faire de cette demande ?', { ...html, reply_markup: kb });
});
bot.callbackQuery(/^la:(ok|no):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [verdict, id] = [ctx.match[1], ctx.match[2]];
  askConfirm(ctx, `${verdict === 'ok' ? 'Approuver' : 'Refuser'} la demande Ask Loan #${id}`,
    verdict === 'ok' ? 'admin_approve_bank_loan' : 'admin_refuse_bank_loan', { _id: id }, 'prets');
});

// ---------- évents (phase 4) ----------
async function showEvents(ctx) {
  const rows = await safeRpc(ctx, 'admin_list_events', { _limit: 10 }, 'events');
  if (!rows?.length) return ctx.reply('Aucun évent.');
  const kb = new InlineKeyboard();
  rows.forEach((e) => kb.text(`${e.is_published ? '🟢' : '⚪️'} ${esc(e.title)} (${dt(e.date)})`, `ev:${e.id}`).row());
  kb.text('➕ Créer un évent', 'ev:new').text('◀️ Menu', 'menu');
  await ctx.reply('<b>📅 Évents</b>', { ...html, reply_markup: kb });
}
bot.command('events', (ctx) => showEvents(ctx));
bot.callbackQuery('m:events', async (ctx) => { await ctx.answerCallbackQuery(); await showEvents(ctx); });
bot.callbackQuery(/^ev:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.match[1] === 'new') { setFlow(ctx.from.id, { type: 'event', step: 'title', data: {} }); return ctx.reply('Titre de l\u2019évent ?'); }
  const id = ctx.match[1];
  const kb = new InlineKeyboard().text('Publié → dépublier', `evt:toggle:${id}`).text('Annuler l\u2019évent', `evt:cancel:${id}`).row().text('✖️ Annuler', 'no');
  await ctx.reply('Modifier cet évent ?', { ...html, reply_markup: kb });
});
bot.callbackQuery(/^evt:(toggle|cancel):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [action, id] = [ctx.match[1], ctx.match[2]];
  askConfirm(ctx, `${action === 'toggle' ? 'Basculer la publication' : 'Annuler'} de l\u2019évent #${id}`, 'admin_set_event_status', { _id: id, _action: action }, 'events');
});

// ---------- boutique (phase 4) ----------
async function showShop(ctx) {
  const rows = await safeRpc(ctx, 'admin_list_shop', { _limit: 10 }, 'boutique');
  if (!rows?.length) return ctx.reply('Aucun article.');
  const kb = new InlineKeyboard();
  rows.forEach((a) => kb.text(`${esc(a.name)} — ${fmt(a.price)} ${cur(a.currency)}${a.sold_at ? ' (vendu)' : ''}`, `sh:${a.id}`).row());
  kb.text('➕ Créer un article', 'sh:new').text('◀️ Menu', 'menu');
  await ctx.reply('<b>🛒 Boutique</b>', { ...html, reply_markup: kb });
}
bot.command('boutique', (ctx) => showShop(ctx));
bot.callbackQuery('m:shop', async (ctx) => { await ctx.answerCallbackQuery(); await showShop(ctx); });
bot.callbackQuery('sh:new', async (ctx) => {
  await ctx.answerCallbackQuery();
  setFlow(ctx.from.id, { type: 'shop', step: 'name', data: {} });
  await ctx.reply('Nom de l\u2019article ?');
});

// ---------- OWNER (phase 5) ----------
bot.callbackQuery('m:owner', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!has('owner')) return ctx.reply("⚠️ Le dashboard OWNER n'est pas encore actif.");
  await ctx.reply('<b>👑 OWNER</b>\nFonctions OWNER — en construction (phase 5).', html);
});

// ---------- alertes automatiques ----------
const ALERT_FEATURE = { bank_loan_request: 'prets', chat_report: 'events', shop_sale: 'boutique' };
let alertState = { since: new Date().toISOString(), broken: false };
try { alertState = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'alert-state.json'), 'utf8')); } catch {}
function saveAlertState() { try { fs.writeFileSync(path.join(DATA_DIR, 'alert-state.json'), JSON.stringify(alertState)); } catch {} }

async function pollAlerts() {
  if (alertState.broken) return;
  const active = ALERT_TYPES.filter((t) => has(ALERT_FEATURE[t] || t));
  if (!active.length) return;
  for (const [tid, s] of sessions) {
    let rows;
    try { rows = await rpc(s.sb, 'admin_pending_alerts', { _types: active, _since: alertState.since }); }
    catch (e) {
      if (/could not find the function|404|PGRST202/i.test(e.message)) { alertState.broken = true; saveAlertState(); return console.warn('[alertes] fonction absente, arrêt du polling.'); }
      continue;
    }
    if (Array.isArray(rows) && rows.length) {
      const txt = rows.map((r) => `🔔 <b>${esc(r.type)}</b> — ${esc(r.summary ?? r.details ?? '')} · ${dt(r.created_at)}`).join('\n');
      await bot.api.sendMessage(tid, txt, html).catch(() => {});
    }
  }
  alertState.since = new Date().toISOString();
  saveAlertState();
}

// ---------- gestion des étapes de création (évent / article) ----------
bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const f = getFlow(ctx.from.id);
  if (!f) return;
  const t = ctx.message.text.trim();
  const d = f.data;

if (f.type === 'event') {
    if (f.step === 'title') { d.title = t; f.step = 'description'; f.data = d; setFlow(ctx.from.id, f); return ctx.reply('Description ?'); }
    if (f.step === 'description') { d.description = t; f.step = 'date'; f.data = d; setFlow(ctx.from.id, f); return ctx.reply('Date (AAAA-MM-JJ HH:MM, heure de Douala) ?'); }
    if (f.step === 'date') {
      flows.delete(ctx.from.id);
      return askConfirm(ctx, `Créer l'évent « ${esc(d.title)} » le ${esc(t)}`, 'admin_create_event', { _title: d.title, _description: d.description, _date: t }, 'events');
    }
  }

if (f.type === 'shop') {
    if (f.step === 'name') { d.name = t; f.step = 'price'; f.data = d; setFlow(ctx.from.id, f); return ctx.reply('Prix ? (nombre seul)'); }
    if (f.step === 'price') { const n = Number(t.replace(/[^\d.]/g, '')); if (!Number.isFinite(n) || n <= 0) return ctx.reply('Prix invalide. Réessaie :'); d.price = n; f.step = 'currency'; f.data = d; setFlow(ctx.from.id, f); return ctx.reply('Devise ?', { ...html, reply_markup: new InlineKeyboard().text('Abyss Coins (AC)', 'cur:AC').text('Gems', 'cur:GEM').row().text('✖️ Annuler', 'no') }); }
    if (f.step === 'done') {
      flows.delete(ctx.from.id);
      return askConfirm(ctx, `Créer l'article « ${esc(d.name)} » à ${fmt(d.price)} ${cur(d.currency)}`, 'admin_create_shop_item', { _name: d.name, _price: d.price, _currency: d.currency }, 'boutique');
    }
  }
});
bot.callbackQuery(/^cur:(AC|GEM)$/, async (ctx) => { // 2e usage : boutique
  const f = getFlow(ctx.from.id);
  if (f?.type === 'shop' && f.step === 'currency') { f.data.currency = ctx.match[1]; f.step = 'done'; setFlow(ctx.from.id, f); await ctx.answerCallbackQuery(); return ctx.reply('Envoie n\u2019importe quoi pour confirmer le récapitulatif (photo : utilise « Modifier » plus tard).'); }
});

// ---------- démarrage ----------
bot.catch((err) => console.error('[erreur bot]', err));

(async () => {
  for (const entry of ADMINS) {
    try { await login(entry); } catch (e) { console.error(e.message); }
  }
  if (!sessions.size) { console.error('Aucun administrateur connecté — vérifie ADMINS_JSON et les comptes du site.'); process.exit(1); }
  console.log(`Bot démarré. Fonctions actives : ${FEATURES.join(', ')}`);
  setInterval(pollAlerts, POLL_MS);
  await bot.start({ drop_pending_updates: true });
})();
