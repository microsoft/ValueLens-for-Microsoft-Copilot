// Dependency-free so `npm test` can run it directly under Node.

export type FileKind = 'interactions' | 'users' | 'agents' | 'feedback'
export const FILE_LABEL: Record<FileKind, string> = {
  interactions: 'Copilot interactions',
  users: 'Organisation and licences',
  agents: 'Agent 365 registry',
  feedback: 'Product feedback',
}
export const FILE_KINDS = Object.keys(FILE_LABEL) as FileKind[]

/** Data rows per recognised file. A kind is absent when no file of that kind was chosen. */
export type RowCounts = Partial<Record<FileKind, number>>

export const NO_INTERACTIONS = 'No Copilot interactions file found. It needs ThreadId and Audit_UserId (or Message_isPrompt) columns.'
export const EMPTY_INTERACTIONS = 'The Copilot interactions file has headers but no rows. Your current data is unchanged.'

/** Throws when the upload must not replace the current data. */
export function checkCounts(counts: RowCounts): void {
  if (counts.interactions === undefined) throw new Error(NO_INTERACTIONS)
  if (counts.interactions === 0) throw new Error(EMPTY_INTERACTIONS)
}

const names = (kinds: FileKind[]) => kinds.map((k) => FILE_LABEL[k]).join(', ')

/** The status line shown after a successful upload. */
export function loadMessage(counts: RowCounts): string {
  const loaded = FILE_KINDS.filter((k) => (counts[k] ?? 0) > 0)
  const empty = FILE_KINDS.filter((k) => counts[k] === 0)
  const missing = FILE_KINDS.filter((k) => counts[k] === undefined)
  let text = `Loaded ${names(loaded)}.`
  if (empty.length) text += ` ${names(empty)} ${empty.length === 1 ? 'has' : 'have'} 0 rows.`
  if (missing.length) text += ` Not found: ${names(missing)}.`
  if (empty.length || missing.length) text += ' Related measures will be blank.'
  return text
}
