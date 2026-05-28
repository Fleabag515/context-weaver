const test = require('node:test');
const assert = require('node:assert/strict');

const { isTrivial } = require('../src/scaffold.js');

const DEFAULTS = {
  trivialEnabled: true,
  trivialMaxChars: 80,
  trivialMarkers: [
    'ok',
    'okay',
    'k',
    'thanks',
    'thank you',
    'cool',
    'nice',
    'lol',
    'haha',
    'yes',
    'no',
    'sure',
    'got it',
  ],
};

const cases = [
  // [description, messages, expected]
  ['empty messages → not trivial', [], false],
  [
    'system-only → not trivial',
    [{ role: 'system', content: 'you are a helpful assistant.' }],
    false,
  ],
  [
    'last role is assistant → not trivial',
    [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
    ],
    false,
  ],
  ['last role is tool → not trivial', [{ role: 'tool', tool_use_id: 't', content: '{}' }], false],

  ['"ok thanks" → trivial', [{ role: 'user', content: 'ok thanks' }], true],
  ['"ok" → trivial (short marker)', [{ role: 'user', content: 'ok' }], true],
  ['"thanks!" with punctuation → trivial', [{ role: 'user', content: 'thanks!' }], true],
  ['emoji-only → trivial (length<=20, no question)', [{ role: 'user', content: '👍' }], true],
  ['"lol" → trivial', [{ role: 'user', content: 'lol' }], true],
  [
    '"sure, sounds good." → trivial (under 80, no question)',
    [{ role: 'user', content: 'sure, sounds good.' }],
    true,
  ],

  [
    '"can you do X?" → NOT trivial (has question mark)',
    [{ role: 'user', content: 'can you do X?' }],
    false,
  ],
  ['"why?" → NOT trivial (has question mark)', [{ role: 'user', content: 'why?' }], false],
  [
    '81-char non-question → NOT trivial (length cap)',
    [{ role: 'user', content: 'a'.repeat(81) }],
    false,
  ],
  [
    'long marker-prefix substantive → NOT trivial (length>80)',
    [{ role: 'user', content: 'ok ' + 'a'.repeat(100) }],
    false,
  ],

  [
    'multipart content with text part "ok thanks" → trivial',
    [{ role: 'user', content: [{ type: 'text', text: 'ok thanks' }] }],
    true,
  ],
  [
    'multipart content with tool_result + short text → trivial if extracted text matches',
    [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
    true,
  ],
];

for (const [desc, messages, expected] of cases) {
  test(`isTrivial: ${desc}`, () => {
    assert.equal(isTrivial(messages, DEFAULTS), expected);
  });
}

test('isTrivial: respects trivialEnabled=false', () => {
  assert.equal(
    isTrivial([{ role: 'user', content: 'ok' }], { ...DEFAULTS, trivialEnabled: false }),
    false
  );
});

test('isTrivial: custom marker list', () => {
  const cfg = { ...DEFAULTS, trivialMarkers: ['custom-marker'] };
  assert.equal(isTrivial([{ role: 'user', content: 'custom-marker' }], cfg), true);
  assert.equal(isTrivial([{ role: 'user', content: 'thanks' }], cfg), false);
});

const { planBlock } = require('../src/scaffold.js');

const PLAN_CFG = {
  plan: { enabled: true, skipOnIntent: ['broad'] },
};

test('planBlock: returns verbatim block on narrow intent', () => {
  const b = planBlock('narrow', PLAN_CFG);
  assert.match(b, /<reasoning_policy>/);
  assert.match(b, /Before producing the final answer, in <think>:/);
  assert.match(b, /<\/reasoning_policy>/);
});

test('planBlock: returns verbatim block on reflective intent', () => {
  const b = planBlock('reflective', PLAN_CFG);
  assert.match(b, /<reasoning_policy>/);
});

test('planBlock: empty string on broad intent', () => {
  assert.equal(planBlock('broad', PLAN_CFG), '');
});

test('planBlock: empty string when disabled', () => {
  assert.equal(planBlock('narrow', { plan: { enabled: false, skipOnIntent: [] } }), '');
});

test('planBlock: empty string when intent in skipOnIntent', () => {
  assert.equal(planBlock('narrow', { plan: { enabled: true, skipOnIntent: ['narrow'] } }), '');
});

test('planBlock: never contains thinking-mode override tokens', () => {
  // Belt-and-braces guard from §14 — plan injection rides on behavioural
  // prompting only; must NEVER contain enable_thinking or <|think_on|>.
  for (const intent of ['narrow', 'reflective']) {
    const b = planBlock(intent, PLAN_CFG);
    assert.ok(!b.includes('enable_thinking'), 'must not contain enable_thinking');
    assert.ok(!b.includes('think_on'), 'must not contain <|think_on|>');
  }
});
