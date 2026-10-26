export const COLOR = {
  licensed: '#0f766e',
  unlicensed: '#b45309',
  agent: '#6d28d9',
  cowork: '#2563eb',
  neutral: '#3f5f5b',
  inactive: '#c8cdd4',
  up: '#0f766e',
  down: '#b42318',
}

/** Habit stages, Inactive then Beginner → Power. */
export const STAGE_COLOR = ['#c8cdd4', '#b6ded8', '#64b5a8', '#23897c', '#0b544c']

/** Work weight grades (Strong, Fair, Worth a look). */
export const GRADE_COLOR = ['#09b39d', '#f6a392', '#9e5a6e']

/** Model fit: well matched, over-powered, under-powered, not judged. */
export const MODEL_COLOR = { well: '#09b39d', over: '#b11f4b', under: '#f1963a', not: '#c8cdd4' }

export const LIFECYCLE_COLOR: Record<string, string> = {
  'Blocked by admin': '#b42318',
  'In use': '#0f766e',
  'Deployed, not yet used': '#b45309',
  'Tenant-built, no owner': '#9e5a6e',
  'Tenant-built, not deployed': '#7b8794',
  'Catalogue listing': '#b8c1cc',
}

export const DORMANCY_COLOR = ['#0f766e', '#f1963a', '#d9682b', '#b42318', '#7b8794']

/** Sequential teal ramp for the heatmap (light → dark). */
export const HEAT_RAMP = ['#eef6f4', '#cfe6e2', '#9fd0c8', '#64b5a8', '#23897c', '#0b544c']

/** Neutral shades for categories that are not populations (reactions, roles, outputs). */
export const NEUTRAL_RAMP = ['#3f5f5b', '#64b5a8', '#9fb3af', '#7b8794', '#c8cdd4']

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** Dark ink or white, whichever reads better on a filled segment. */
export const inkOn = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) && (lum(hex) + 0.05) / 0.05 > 1.05 / (lum(hex) + 0.05) ? '#10211f' : '#ffffff')
