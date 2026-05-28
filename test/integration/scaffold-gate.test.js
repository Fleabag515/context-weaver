const test = require('node:test');
const assert = require('node:assert/strict');

// We're not booting the real proxy here — we're testing the routing
// decision in isolation. The actual wiring assertions live in scaffold
// unit tests + a manual smoke at task 9.

const { isTrivial, planBlock, toolReflectionBlock } = require('../../src/scaffold.js');

test('integration: trivial path skips memory injection planning entirely', () => {
  const messages = [{ role: 'user', content: 'ok thanks' }];
  const cfg = {
    trivialEnabled: true,
    trivialMaxChars: 80,
    plan: { enabled: true, skipOnIntent: ['broad'] },
    toolReflection: { enabled: true },
  };
  // Trivial → caller short-circuits before the selector. Verify the
  // helpers individually behave correctly so the proxy can compose
  // them without surprises.
  assert.equal(isTrivial(messages, cfg), true);
});

test('integration: non-trivial → plan block + tool reflection both apply when applicable', () => {
  const messages = [
    { role: 'user', content: 'why does my deploy fail with exit 137?' },
    { role: 'assistant', content: 'let me check' },
    { role: 'tool', tool_use_id: 'a', content: '{"oom":true}' },
  ];
  const cfg = {
    trivialEnabled: true,
    trivialMaxChars: 80,
    plan: { enabled: true, skipOnIntent: ['broad'] },
    toolReflection: { enabled: true },
  };
  assert.equal(isTrivial(messages, cfg), false);
  const pb = planBlock('narrow', cfg);
  const tr = toolReflectionBlock(messages, cfg);
  assert.match(pb, /<reasoning_policy>/);
  assert.match(tr, /<tool_reflection>/);
  // The full system addition should contain both:
  const sys = `you are an assistant.${pb}${tr}`;
  assert.match(
    sys,
    /<reasoning_policy>[\s\S]*<\/reasoning_policy>[\s\S]*<tool_reflection>[\s\S]*<\/tool_reflection>/
  );
});
