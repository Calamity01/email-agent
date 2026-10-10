OPENAI_MODEL=gpt-4o-mini
OPENAI_REASONING_EFFORT=
EXPECTED_MAILBOX=cbeliveau@electromega.com
INTERNAL_DOMAINS=electromega.com
SUPPLIER_DOMAINS=emxinc.com,pelcoinc.com,spectralite.ca,groupedl.ca,tacel.ca,smartmicro.com,smartmicro.de
ACTIVE_CATEGORIES=soumission,nouvelle_commande,suivi_commande,autre
HISTORY_MODE=before
INTENT_FIELD=true
FORCE_AUTRE_SENDERS=
SIGNATURE_CUT=Thierry Lamoureux[\s\S]{0,5}Vice-President|Brian Antila[\s\S]{0,5}Gestionnaire|Michel Mondor[\s\S]{0,5}CD1
FIELDS_MODE=true

soumission : nouvelle demande de prix ou information nouvelle sur une soumission (addenda, précisions de besoin, documents, changement de quantité ou de spécification).
Relance de soumission (« où en est ma soumission ? ») → autre.
Remerciement, accusé de réception, simple confirmation → autre.
nouvelle_commande : commande ferme reçue d’un client (bon de commande), même sans texte et même avec un gabarit ERP. Un PO de réparation sous garantie reste autre (service après-vente), sauf avis contraire de ta part.
suivi_commande : demande (question, relance, modification, annulation, documents manquants, facture liée) sur une commande client en cours. Un message qui ne fait qu’informer → autre.
Étiquette sans tenir compte de ta position (À ou Cc) : la catégorie dit ce qu’est le courriel. La copie servira à décider d’agir, pas à classer. C’est ce que tu as fait dans run3, mais pas dans run2.