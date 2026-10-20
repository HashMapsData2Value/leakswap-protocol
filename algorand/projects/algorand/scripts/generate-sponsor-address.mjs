import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const directory = mkdtempSync(resolve(tmpdir(), 'leakswap-sponsor-'));
const encode = (value) => {
  const bytes = [];
  do {
    const next = Number(value & 127n);
    value >>= 7n;
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
};
function compile(appId, ali, xin) {
  const output = execFileSync('npx', ['--no-install', 'puya-ts', 'smart_contracts/leak_swap/sponsor_lsig.algo.ts',
    '--output-bytecode', '--out-dir', directory, '--cli-template-definitions',
    `APP_ID=${appId}`, `ALI_ADDR=0x${ali.toString('hex').toUpperCase()}`, `XIN_ADDR=0x${xin.toString('hex').toUpperCase()}`], { encoding: 'utf8' });
  assert.ok(!output.includes('error:'), output);
  const file = readdirSync(directory).find((name) => name.endsWith('.bin'));
  assert.ok(file, 'Compiler must emit binary bytecode');
  return readFileSync(resolve(directory, file));
}
try {
  const appId = 0x010203n;
  const ali = Buffer.alloc(32, 0xa1);
  const xin = Buffer.alloc(32, 0xb2);
  const program = compile(appId, ali, xin);
  const markers = [encode(appId), ali, xin];
  const parts = [];
  let cursor = 0;
  for (const marker of markers) {
    const offset = program.indexOf(marker);
    assert.ok(offset >= cursor && program.indexOf(marker, offset + 1) === -1, 'Template marker must appear exactly once in order');
    parts.push(program.subarray(cursor, offset));
    cursor = offset + marker.length;
  }
  parts.push(program.subarray(cursor));
  const fixtures = [];
  for (const value of [1n, 128n, 16384n, 0xffffffffffffffffn]) {
    const first = Buffer.alloc(32, Number(value & 255n));
    const second = Buffer.alloc(32, 0xc3);
    const compiled = compile(value, first, second);
    assert.deepEqual(Buffer.concat([parts[0], encode(value), parts[1], first, parts[2], second, parts[3]]), compiled);
    fixtures.push({ appId: value.toString(), ali: first.toString('hex'), xin: second.toString('hex'),
      address: createHash('sha512-256').update(Buffer.concat([Buffer.from('Program'), compiled])).digest('hex') });
  }
  const source = `import { Account, Bytes, bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import { itob, sha512_256 } from '@algorandfoundation/algorand-typescript/op'

export function sponsorAddress(appId: uint64, ali: Account, xin: Account): Account {
  let remaining = appId
  let encoded = Bytes('')
  while (remaining >= 128) {
    const next: uint64 = (remaining % 128) + 128
    encoded = encoded.concat(itob(next).slice(7, 8))
    remaining = remaining / 128
  }
  encoded = encoded.concat(itob(remaining).slice(7, 8))
  const program: bytes = Bytes.fromHex('${parts[0].toString('hex')}').concat(encoded)
    .concat(Bytes.fromHex('${parts[1].toString('hex')}')).concat(ali.bytes)
    .concat(Bytes.fromHex('${parts[2].toString('hex')}')).concat(xin.bytes)
    .concat(Bytes.fromHex('${parts[3].toString('hex')}'))
  return Account(sha512_256(Bytes('Program').concat(program)))
}
`;
  writeFileSync('smart_contracts/leak_swap/sponsor_address.algo.ts', source);
  writeFileSync('smart_contracts/leak_swap/sponsor-address-fixtures.json', JSON.stringify(fixtures, null, 2) + '\n');
  console.log('Generated sponsor address helper; four independent bytecode fixtures match.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}