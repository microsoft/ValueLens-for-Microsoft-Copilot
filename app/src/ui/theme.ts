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
export const GRADE_COLOR = ['#09b39d', '#f6a392', '#b11f4b']

/** Model fit: well matched, over-powered, under-powered, not judged. */
export const MODEL_COLOR = { well: '#09b39d', over: '#b11f4b', under: '#f1963a', not: '#c8cdd4' }

export const LIFECYCLE_COLOR: Record<string, string> = {
  'Blocked by admin': '#b42318',
  'In use': '#0f766e',
  'Deployed, not yet used': '#b45309',
  'Tenant-built, no owner': '#6d28d9',
  'Tenant-built, not deployed': '#7b8794',
  'Catalogue listing': '#b8c1cc',
}

export const DORMANCY_COLOR = ['#0f766e', '#f1963a', '#d9682b', '#b42318', '#7b8794']

/** Sequential teal ramp for the heatmap (light → dark). */
export const HEAT_RAMP = ['#eef6f4', '#cfe6e2', '#9fd0c8', '#64b5a8', '#23897c', '#0b544c']
