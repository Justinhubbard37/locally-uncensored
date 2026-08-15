import { describe, it, expect } from 'vitest'
import { getImageBundles, getVideoBundles } from '../discover'

/**
 * Waechter fuer die Groessenangaben der Buendel.
 *
 * Die Zahl neben einer Datei ist kein Schmuck. Nach ihr entscheidet der Nutzer,
 * ob er den Download startet, und danach raeumt er vorher auf oder eben nicht.
 * Am 15.08.2026 stand beim FramePack-Modell 13 GB, die Datei hat 16,3 GB. Auf
 * der Testmaschine lief die Platte auf 0 Byte, der Rechner war danach nicht
 * mehr benutzbar, und die halbe Datei blieb liegen.
 *
 * Der Lauf holt nur die Kopfzeilen, ein HEAD pro Datei, keine Nutzdaten. Er
 * haengt am Netz und an HuggingFace, deshalb laeuft er nur mit `LIVE_SIZES=1`
 * und nicht im normalen Gate, genau wie der Preis-Waechter der Cloud.
 *
 *   LIVE_SIZES=1 npx vitest run src/api/__tests__/bundle-size-drift.live.test.ts
 */
const LIVE = process.env.LIVE_SIZES === '1'

type Datei = { name: string; downloadUrl?: string; sizeGB?: number }

const dateien = (): Datei[] => {
  const alle: Datei[] = []
  for (const b of [...getImageBundles(), ...getVideoBundles()]) {
    for (const f of b.files ?? []) alle.push(f as Datei)
  }
  return alle
}

async function echteGroesse(url: string): Promise<number | null> {
  const r = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  if (!r.ok) return null
  const len = r.headers.get('content-length')
  return len ? Number(len) : null
}

/**
 * Der Katalog zaehlt in Gibibyte, also so, wie Windows und der Finder den
 * freien Platz anzeigen. Genau damit vergleicht der Nutzer, und nur dann hilft
 * ihm die Zahl. Ein Vergleich gegen die Dezimal-GB der Kopfzeile wuerde jeden
 * Eintrag anmeckern und dabei die echten Faelle verstecken.
 */
const GIB = 1024 ** 3

// Rundung auf eine Nachkommastelle plus etwas Luft. Was darunter liegt, ist
// Anzeigegenauigkeit, kein Planungsfehler.
const TOLERANZ_GIB = 0.15

describe.runIf(LIVE)('Buendel-Groessen gegen die echten Dateien', () => {
  it('keine Datei ist groesser als angekuendigt', { timeout: 180_000 }, async () => {
    const zuKlein: string[] = []
    for (const f of dateien()) {
      if (!f.downloadUrl || f.sizeGB === undefined) continue
      const echt = await echteGroesse(f.downloadUrl)
      if (echt === null) continue
      const echtGiB = echt / GIB
      if (echtGiB > f.sizeGB + TOLERANZ_GIB) {
        zuKlein.push(`${f.name}: angekuendigt ${f.sizeGB}, echt ${echtGiB.toFixed(2)}`)
      }
    }
    expect(zuKlein, `Zu niedrig angegeben (GiB):\n${zuKlein.join('\n')}`).toEqual([])
  })
})
