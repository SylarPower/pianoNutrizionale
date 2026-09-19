# Editor strutture dieta — guida operativa (dietPlan schema 2)

L'editor delle strutture costruisce la dieta come un piano stampato: **giornate → pasti → opzioni**, con le dosi espresse su **blocchi famiglia di riferimento**. Contratto dati: `docs/saas-data-contracts.md` (struttura dieta, revisioni schema 4); schema JSON: `docs/schema-catalogo-strutture-v3.json`; decisioni: ADR 0008.

## Dove si trova

Console `admin.html` → vista **Strutture**: crea una struttura («Nuova struttura») o apri una esistente. Ogni salvataggio pubblica una **revisione immutabile** con checksum: le assegnazioni già fatte non cambiano mai in silenzio (non-retroattività).

## Giornata

- **Tipo giornata**: Allenamento / Riposo / Altro.
- **Etichetta** opzionale (es. «Giorno lungo»), max 80 caratteri.
- **Integrazione** e **Idratazione**: testo libero visibile al cliente.
- Fino a 14 giornate per struttura.

## Pasto

Colazione, spuntino mattina, pranzo, merenda, cena, spuntino sera: si aggiunge col chip ＋, un pasto per tipo. Ogni pasto ha **nota** (istruzioni visibili al cliente) e da 1 a 4 **opzioni**.

**Opzione unica o alternative?** Con una sola opzione il cliente la vede senza etichette; con più opzioni la console le etichetta A, B, C… solo in UI — l'etichetta non viene mai salvata.

## I tre tipi di opzione

Ogni opzione è UNO di questi tre tipi (scelta a chip, mutuamente esclusivi):

1. **Blocchi famiglia** — il modo principale di dosare: uno o più blocchi (max 8).
2. **Ingredienti** — elenco puntuale di ingredienti singoli con quantità (max 20), per casi speciali.
3. **Ricetta** — una ricetta del ricettario professionale con **moltiplicatore dose** ×0,1–10. Le dosi mostrate al cliente sono moltiplicate: la ricetta originale non viene mai modificata.

### Blocco famiglia di riferimento

Un blocco dice: «questa famiglia di alimenti, in questa quantità, riferita a questo ingrediente».

- **Famiglia di riferimento**: dal catalogo globale (es. *Cereali e derivati*). Le famiglie sono globali e stabili.
- **Ingrediente di riferimento** opzionale (es. *Riso basmati*): quello su cui è espressa la quantità.
- **Quantità di riferimento**: numero + unità (g, ml, pz, fette, cucchiai, …).
- **Template equivalenze** opzionale: collega un template dell'organizzazione. Alla pubblicazione il blocco incapsula uno **snapshot** della revisione template (non retroattivo): modifiche future al template non toccano le strutture già pubblicate.
- **Override quantità**: fissati valori diversi per famiglie specifiche SOLO in questa struttura (es. gnocchi 150 g). La famiglia di riferimento del blocco non può comparire tra gli override.

Il cliente vede il blocco con le grammature della struttura e gli equivalenti proporzionali: la scelta «dosi originali / dosi allineate» si applica ovunque (settimana, ricettario, spesa) senza mai riscrivere la ricetta originale.

### Riconoscimento degli alimenti

Nei campi «Alimento» e «Ingrediente di riferimento» si digita e si sceglie dal catalogo (autocomplete). Se un termine non è riconosciuto l'editor lo segnala («Alimento non riconosciuto: scegline uno dal catalogo») e non inventa dosi. Il cliente, dal lato suo, può proporre l'ingrediente mancante con categoria e famiglia suggerite: la proposta entra nella coda **Richieste ingredienti** gestita dal platform admin.

## Pubblicazione

«Salva» → pre-validazione in italiano (stesso vocabolario del server) → callable `updateDietStructureRevision` → nuova revisione pubblicata con checksum e `ingredientCatalogVersion` congelati. Il **changelog** documentato e il campo «ripristinata da» tengono la storia leggibile; il confronto tra strutture («Confronta») mostra le differenze giorno per giorno.

## Limiti (validati dal server)

14 giornate · 10 pasti/giornata · 4 opzioni/pasto · 8 blocchi/opzione · 20 ingredienti/opzione · 30 equivalenti per snapshot · 30 override per blocco · moltiplicatore ricetta 0,1–10 · quantità 0–5000.
