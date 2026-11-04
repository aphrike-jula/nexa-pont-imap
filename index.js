/* =====================================================================
 * NEXA — Pont IMAP → Supabase  (v2 : diagnostic détaillé + repli)
 *
 * Relève une boîte Namecheap Private Email en IMAP et range les messages
 * dans la table messages_mail. Tourne en continu sur Railway.
 *
 * LECTURE SEULE : le worker ne marque rien comme lu, ne déplace rien,
 * ne supprime rien. Thunderbird et le webmail ne voient aucune différence.
 * ===================================================================== */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createClient } from '@supabase/supabase-js';

const env = (k, d) => (process.env[k] ?? d);
const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`[config] variable manquante : ${k}`); process.exit(1); }
  return v;
};

const SUPABASE_URL  = need('SUPABASE_URL');
const SERVICE_KEY   = need('SUPABASE_SERVICE_KEY');
const IMAP_HOST     = env('IMAP_HOST', 'mail.privateemail.com');
const IMAP_PORT     = Number(env('IMAP_PORT', '993'));
const IMAP_USER     = need('IMAP_USER');
const IMAP_PASS     = need('IMAP_PASS');
const ENTREPRISE_ID = need('ENTREPRISE_ID');
const DOSSIER       = env('IMAP_DOSSIER', 'INBOX');
const JOURS         = Number(env('JOURS', '30'));
const INTERVALLE_MN = Number(env('INTERVALLE_MIN', '5'));
const LIBELLE       = env('BOITE_LIBELLE', IMAP_USER);
const PLAFOND       = Number(env('PLAFOND', '400'));

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Tout ce que le serveur IMAP a bien voulu dire sur l'échec. */
function detail(e) {
  const p = [];
  if (e?.name) p.push('name=' + e.name);
  if (e?.code) p.push('code=' + e.code);
  if (e?.authenticationFailed) p.push('AUTHENTIFICATION_REFUSEE');
  if (e?.responseStatus) p.push('statut=' + e.responseStatus);
  if (e?.responseText) p.push('reponse="' + e.responseText + '"');
  if (e?.serverResponseCode) p.push('srv=' + e.serverResponseCode);
  p.push('msg="' + (e?.message || String(e)) + '"');
  return p.join(' | ');
}

async function boite() {
  const { data, error } = await sb
    .from('boites_mail').select('id')
    .eq('entreprise_id', ENTREPRISE_ID).eq('adresse', IMAP_USER).maybeSingle();
  if (error) throw error;
  if (data) return data.id;
  const ins = await sb.from('boites_mail')
    .insert({ entreprise_id: ENTREPRISE_ID, adresse: IMAP_USER, libelle: LIBELLE })
    .select('id').single();
  if (ins.error) throw ins.error;
  log('[boite] créée :', IMAP_USER);
  return ins.data.id;
}

async function etat(boiteId, texte) {
  await sb.from('boites_mail')
    .update({ derniere_releve: new Date().toISOString(), dernier_etat: texte })
    .eq('id', boiteId);
}

const adresses = (c) => !c ? '' : (Array.isArray(c) ? c.map(x => x.text || '').join(', ') : (c.text || ''));

async function releve() {
  const boiteId = await boite();

  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  // --- Connexion ---
  try {
    await client.connect();
    log('[imap] connecté à', IMAP_HOST + ':' + IMAP_PORT, 'en tant que', IMAP_USER);
  } catch (e) {
    throw new Error('CONNEXION/AUTHENTIFICATION — ' + detail(e));
  }

  let vus = 0, nouveaux = 0, verrou = null;
  try {
    // --- Ouverture du dossier ---
    try {
      verrou = await client.getMailboxLock(DOSSIER);
      log('[imap] dossier', DOSSIER, 'ouvert —', client.mailbox?.exists ?? '?', 'message(s) au total');
    } catch (e) {
      // Le dossier n'a peut-être pas ce nom sur ce serveur : on liste.
      try {
        const liste = await client.list();
        log('[imap] dossiers disponibles :', liste.map(b => b.path).join(' | '));
      } catch {}
      throw new Error('OUVERTURE DU DOSSIER "' + DOSSIER + '" — ' + detail(e));
    }

    const depuis = new Date(Date.now() - JOURS * 86400000);

    // --- Sélection des messages : recherche, sinon repli sur les derniers ---
    let cible = null, parUid = true;
    try {
      const uids = await client.search({ since: depuis }, { uid: true });
      cible = (uids || []).slice(-PLAFOND).reverse();
      log('[imap] recherche par date :', cible.length, 'message(s) sur', JOURS, 'jours');
    } catch (e) {
      log('[imap] SEARCH refusé (' + detail(e) + ') — repli sur les derniers messages');
      const total = client.mailbox?.exists || 0;
      if (!total) { cible = []; }
      else {
        const debut = Math.max(1, total - PLAFOND + 1);
        cible = `${debut}:${total}`;
        parUid = false;
        log('[imap] repli : lecture des messages', cible);
      }
    }

    const vide = Array.isArray(cible) ? cible.length === 0 : !cible;
    if (vide) {
      log('[relève] aucun message à lire');
    } else {
      for await (const msg of client.fetch(cible, { uid: true, envelope: true, source: true },
                                           parUid ? { uid: true } : {})) {
        let parsed;
        try { parsed = await simpleParser(msg.source); } catch { continue; }
        if (parsed.date && parsed.date < depuis) continue;   // utile pour le repli
        vus++;

        const from = parsed.from?.value?.[0] || {};
        const ligne = {
          entreprise_id: ENTREPRISE_ID,
          boite_id: boiteId,
          message_id: (parsed.messageId || `uid:${msg.uid}`).trim(),
          dossier: DOSSIER,
          expediteur_nom: from.name || '',
          expediteur_email: (from.address || '').toLowerCase(),
          destinataires: adresses(parsed.to),
          sujet: parsed.subject || '(sans objet)',
          extrait: (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 280),
          corps: (parsed.text || '').slice(0, 60000),
          date_mail: (parsed.date || new Date()).toISOString(),
        };

        const { error } = await sb.from('messages_mail')
          .upsert(ligne, { onConflict: 'boite_id,message_id', ignoreDuplicates: true });
        if (error) { log('[erreur upsert]', error.message); continue; }
        nouveaux++;
      }
    }
  } finally {
    try { verrou?.release(); } catch {}
    try { await client.logout(); } catch {}
  }

  const resume = `${vus} message(s) lus, ${nouveaux} enregistré(s)`;
  log('[relève]', resume);
  await etat(boiteId, resume);
}

async function boucle() {
  log(`[démarrage] ${IMAP_USER} sur ${IMAP_HOST}:${IMAP_PORT}, ${DOSSIER}, ${JOURS} j, toutes les ${INTERVALLE_MN} min`);
  for (;;) {
    try {
      await releve();
    } catch (e) {
      log('[erreur relève]', e?.message || e);
      try { await etat(await boite(), 'erreur : ' + String(e?.message || e).slice(0, 300)); } catch {}
    }
    await new Promise((r) => setTimeout(r, INTERVALLE_MN * 60000));
  }
}

boucle();
