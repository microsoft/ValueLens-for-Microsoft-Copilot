import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSemanticModels } from '../src/config.js';

test('legacy valueLensModel key is served as the vl alias the app queries', () => {
  const ref = { workspaceId: 'ws', itemId: 'ds' };
  assert.deepEqual(parseSemanticModels(JSON.stringify({ valueLensModel: ref })), { vl: ref });
  assert.deepEqual(parseSemanticModels(JSON.stringify({ vl: ref, cc: ref })), { vl: ref, cc: ref });
  assert.deepEqual(parseSemanticModels(''), {});
});
