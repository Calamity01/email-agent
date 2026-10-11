import type { Ref } from './refs.js';

// Lien Zoho CRM : .../crm/org<id>/tab/Quotes|Deals/<identifiant d'enregistrement>
const ZOHO_LINK = /https?:\/\/crm\.zoho\.[a-z.]+\/crm\/org\d+\/tab\/(Quotes|Deals|Potentials)\/(\d{10,25})/gi;

/** Extrait les identifiants Zoho (Quote ou Deal) des liens d'une notification. */
export function extractZohoIds(content: string): Ref[] {
  // Les liens peuvent être encodés (par exemple dans les liens protégés d'Outlook)
  const variants = [content, content.replace(/%3A/gi, ':').replace(/%2F/gi, '/')];
  const found = new Map<string, Ref>();
  for (const text of variants) {
    for (const m of text.matchAll(ZOHO_LINK)) {
      const kind = /^quotes$/i.test(m[1]) ? 'zoho_quote_id' : 'zoho_deal_id';
      found.set(`${kind}:${m[2]}`, { kind, value: m[2], where: 'lien', source: 'regle' });
    }
  }
  return [...found.values()];
}