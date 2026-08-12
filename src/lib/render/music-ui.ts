// What the Music tab may claim, per backend.
//
// #108 (ElBiggus) was a page of cloud facts printed at a local user: the tab
// said the model writes its own lyrics while hiding the lyrics box, the how-to
// described a box that was not there, promised other downloadable music
// models, and said the length slider "bills per second" on a machine where
// nothing is billed. The copy lives here so those claims can be asserted
// instead of eyeballed.

export type CreateBackendKind = 'local' | 'cloud'

/**
 * Local music always runs an ACE-Step checkpoint through buildMusicWorkflow,
 * and that builder feeds `lyrics` into the encoder for every one of them, so
 * the box is always right locally. Cloud depends on the catalog flag, because
 * only ace-step-1.5 has a lyrics input on the wire.
 */
export function musicTakesLyrics(backend: CreateBackendKind, cloudModelTakesLyrics: boolean): boolean {
  return backend === 'cloud' ? cloudModelTakesLyrics : true
}

/** The how-to panel, as lines. First line is the heading. */
export function musicHowtoLines(backend: CreateBackendKind): string[] {
  const lines = [
    'Make it sing your words',
    'The prompt sets the style: comma-separated tags like slow jazz, smoky female vocals, upright bass.',
  ]
  if (backend === 'cloud') {
    lines.push('Only ACE-Step 1.5 sings your own lyrics. The other music models write theirs from the prompt.')
  }
  lines.push(
    'Structure your lines with [Verse], [Chorus] and [Bridge] markers so the model sings them. Plain lines get wrapped in a [Verse] for you.',
    'Leave the lyrics box empty for an instrumental track, and write in the language you want sung.',
    backend === 'cloud'
      ? 'The length slider bills per second, tracks can run up to 4 minutes.'
      : 'The length slider sets the track length, up to 4 minutes. Local runs cost nothing but time.',
  )
  return lines
}
