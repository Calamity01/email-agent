/** Une référence extraite d'un courriel. */
export type TriageRef = {
  kind: string;   // vso, scom, emd, emq, item_interne, po_interne, rma_interne, zoho_quote_id, zoho_deal_id,
  // appel_offres, dossier_client, projet_client, commande_client, autre_reference
  value: string;  // telle qu'écrite dans le courriel (normalisée pour les formats internes : VSO22-00143)
  where: 'objet' | 'message' | 'piece_jointe' | 'historique' | 'lien';
  source: 'regle' | 'modele';
};

/** Fiche envoyée au backend : une par courriel classifié. Clé : messageId (upsert). */
export type EmailTriage = {
  messageId: string;            // id immuable Outlook
  receivedAt: string;           // ISO 8601
  from: string;
  subject: string;
  webLink: string | null;       // ouvre le courriel dans Outlook
  category:
  | 'soumission' | 'nouvelle_commande' | 'suivi_commande'
  | 'support' | 'facturation' | 'fournisseur' | 'interne' | 'info'
  | 'autre';                  // catégorie finale (après règles) ; seules les catégories actives sortent réellement
  modelCategory: string | null; // choix du modèle avant les règles (null si raccourci local)
  rule: string | null;          // règle qui a modifié la catégorie, ex. « en copie (Cc) seulement »
  urgency: 'basse' | 'normale' | 'haute';
  requiresReply: boolean;
  confidence: 'faible' | 'moyenne' | 'elevee';
  language: 'fr' | 'en' | 'autre';
  summary: string;
  refs: TriageRef[];            // vide pour « autre » (les références ne sont extraites que pour les demandes)
};