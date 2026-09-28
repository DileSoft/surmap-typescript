import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const buf = fs.readFileSync(file);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const sizeY = 1 << 14;
const tableBytes = sizeY * 6;

console.log('file size', buf.length, 'tableBytes', tableBytes);
const offs = [];
for (let i = 0; i < 4; i++) offs.push([view.getInt32(i * 4, true), view.getInt16(sizeY * 4 + i * 2, true)]);
console.log('first offsets/sizes', offs);
console.log('last offsets/sizes', [
  [view.getInt32((sizeY - 1) * 4, true), view.getInt16(sizeY * 4 + (sizeY - 1) * 2, true)],
]);

console.log('first 16 int32 at tableBytes (tree1):');
const t1 = [];
for (let i = 0; i < 16; i++) t1.push(view.getInt32(tableBytes + i * 4, true));
console.log(t1);

console.log('bytes at tableBytes:', Array.from(buf.subarray(tableBytes, tableBytes + 32)));
console.log('bytes at 0:', Array.from(buf.subarray(0, 32)));

// distribution of tree1 values
let neg = 0, pos = 0, zero = 0, maxNode = 0;
for (let i = 0; i < 512; i++) {
  const v = view.getInt32(tableBytes + i * 4, true);
  if (v < 0) neg++;
  else if (v > 0) { pos++; if (v > maxNode) maxNode = v; }
  else zero++;
}
console.log('tree1: neg', neg, 'pos', pos, 'zero', zero, 'maxNode', maxNode);
