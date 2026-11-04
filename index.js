/* =====================================================================
 * NEXA — Pont IMAP → Supabase
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
const IMAP_USER     = need('IMAP_USER');          // ex. contact@nexaglobalsservices.services
const IMAP_PASS     = need('IMAP_PASS');          // mot de passe d'application
const ENTREPRISE_ID = need('ENTREPRISE_ID');      // uuid de l'entreprise proprietaire
const DOSSIER       = env('IMAP_DOSSIER', 'INBOX');
const JOURS         = Number(env('JOURS', '30'));
const INTERVALLE_MN = Number(env('INTERVALLE_MIN', '5'));
const LIBELLE       = env('BOITE_LIBELLE', IMAP_USER);

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Récupère (ou crée) la ligne boites_mail de cette adresse. */
async function boite() {
  const { data, error } = await sb
    .from('boites_mail')
    .select('id')
    .eq('entreprise_id', ENTREPRISE_ID)
    .eq('adresse', IMAP_USER)
    .maybeSingle();
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

function extraitDe(parsed) {
  const t = (parsed.text || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 280);
}

function adresses(champ) {
  if (!champ) return '';
  if (Array.isArray(champ)) return champ.map((c) => c.text || '').join(', ');
  return champ.text || '';
}

async function releve() {
  const boiteId = await boite();

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  let vus = 0, nouveaux = 0;
  await client.connect();
  const verrou = await client.getMailboxLock(DOSSIER);
  try {
    const depuis = new Date(Date.now() - JOURS * 86400000);
    const uids = await client.search({ since: depuis }, { uid: true });

    if (!uids || uids.length === 0) {
      log('[relève] aucun message sur les', JOURS, 'derniers jours');
    } else {
      // Du plus récent au plus ancien, par paquets pour ne pas saturer.
      const liste = uids.slice(-500).reverse();
      for await (const msg of client.fetch(
        liste, { uid: true, envelope: true, source: true }, { uid: true }
      )) {
        vus++;
        let parsed;
        try { parsed = await simpleParser(msg.source); } catch { continue; }

        const messageId = (parsed.messageId || `uid:${msg.uid}`).trim();
        const from = parsed.from?.value?.[0] || {};

        const ligne = {
          entreprise_id: ENTREPRISE_ID,
          boite_id: boiteId,
          message_id: messageId,
          dossier: DOSSIER,
          expediteur_nom: from.name || '',
          expediteur_email: (from.address || '').toLowerCase(),
          destinataires: adresses(parsed.to),
          sujet: parsed.subject || '(sans objet)',
          extrait: extraitDe(parsed),
          corps: (parsed.text || '').slice(0, 60000),
          date_mail: (parsed.date || new Date()).toISOString(),
        };

        const { error } = await sb
          .from('messages_mail')
          .upsert(ligne, { onConflict: 'boite_id,message_id', ignoreDuplicates: true });
        if (error) { log('[erreur upsert]', error.message); continue; }
        nouveaux++;
      }
    }
  } finally {
    verrou.release();
    await client.logout().catch(() => {});
  }

  const resume = `${vus} message(s) vus, ${nouveaux} enregistré(s)`;
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
      // On ne meurt pas : une coupure IMAP ou un mot de passe refusé
      // ne doit pas arrêter le service, Railway le redémarrerait en boucle.
      try {
        const id = await boite();
        await etat(id, 'erreur : ' + String(e?.message || e).slice(0, 200));
      } catch {}
    }
    await new Promise((r) => setTimeout(r, INTERVALLE_MN * 60000));
  }
}

boucle();
