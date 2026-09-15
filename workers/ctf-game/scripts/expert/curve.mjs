import parameters from './curve-fixtures.json' with { type: 'json' };

export function curveEvidence(stage, random) {
  const peers = Buffer.alloc(8 + parameters.points.length * 32);
  peers.write('ECP2'); peers.writeUInt32BE(parameters.points.length, 4);
  const shuffled = [...parameters.points];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = random(2).readUInt16BE() % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  shuffled.forEach((point, i) => {
    for (const [offset, value] of [[0, point.x], [16, point.y]]) {
      Buffer.from(BigInt(value).toString(16).padStart(32, '0'), 'hex').copy(peers, 8 + i * 32 + offset);
    }
  });
  const curve = { p: parameters.p, a: parameters.a, b: parameters.b, order: parameters.order, g: parameters.g };
  return {
    curve,
    files: {
      'parameters.json': JSON.stringify({ version: 2, curve, encoding: 'unsigned big-endian, 16 bytes per coordinate; 00*32 = infinity' }, null, 2),
      'peers.bin': peers,
      'service.json': JSON.stringify({ endpoint: '/api/labs/' + stage, inspect: 'GET', exchange: { method: 'POST', body: { action: 'exchange', x: 'hex(16 bytes)', y: 'hex(16 bytes)' }, confirmation: 'SHA-256(encode(shared) || binding)' }, redeem: { method: 'POST', body: { action: 'redeem', proof: 'hex(HMAC-SHA-256(encode(scalar), UTF-8("archive/release/") || binding))' } } }, null, 2),
      'board.c': [
        '#include "field.h"',
        'point exchange(scalar secret, field x, field y) {',
        '    point base = {x, y, false}, result = infinity();',
        '    if (x >= P || y >= P) abort();',
        '    while (secret) {',
        '        if (secret & 1) result = point_add(result, base, A, P);',
        '        base = point_add(base, base, A, P);',
        '        secret >>= 1;',
        '    }',
        '    return result;',
        '}', '',
      ].join('\n'),
    },
  };
}
