/**
 * Writers for the world surface files, the exact inverse of `loader.ts`:
 *   saveVmp -> uncompressed `.vmp`
 *   saveVmc -> compressed `.vmc`
 *
 * The VMC Huffman encoder is ported from:
 *   src/terra/huff1.cpp   (DHuff: build_initial_heap / build_code_tree /
 *                          generate_code_table / build_decomp_tree /
 *                          compress_line)
 *   src/terra/compress.cpp(CompressMap)
 * but encodes the *delta* stream the decoder expects:
 *   heights: d[i] = h[i] - h[i-1]      (splay.cpp decompress_line1)
 *   flags:   d[i] = m[i] ^ m[i-1]      (splay.cpp decompress_line2)
 */
import { H_SIZE } from './constants';
import type { VrtMap } from './vmap';

const TREE_ENTRIES = 512;

/** Port of DHuff (the compression half). One instance = one code tree. */
class HuffEncoder {
  private readonly father = new Int32Array(512);
  private readonly heap = new Int32Array(257);
  private readonly frequency = new Int32Array(512);
  private readonly code = new Uint32Array(256);
  private readonly codeLength = new Uint8Array(256);
  readonly decompTree = new Int32Array(TREE_ENTRIES);
  private heapLength = 0;

  /** Builds a valid prefix code from a 256-entry frequency table. */
  build(freq: Int32Array): void {
    for (let i = 0; i < 256; i++) this.frequency[i] = freq[i];

    let distinct = 0;
    let last = -1;
    for (let i = 0; i < 256; i++) {
      if (this.frequency[i]) {
        distinct++;
        last = i;
      }
    }
    // A one-symbol alphabet has no code; keep it valid with a phantom symbol.
    if (distinct === 0) {
      this.frequency[0] = 1;
      this.frequency[1] = 1;
    } else if (distinct === 1) {
      this.frequency[last === 0 ? 1 : 0] = 1;
    }

    this.buildInitialHeap();
    this.buildCodeTree();
    if (!this.generateCodeTable()) {
      throw new Error('Huffman code value out of range (cannot compress)');
    }
    this.buildDecompTree();
  }

  private reheap(heapEntry: number): void {
    let flag = 1;
    const heapValue = this.heap[heapEntry];
    while (heapEntry <= this.heapLength >> 1 && flag) {
      let index = heapEntry << 1;
      if (index < this.heapLength) {
        if (this.frequency[this.heap[index]] >= this.frequency[this.heap[index + 1]]) index++;
      }
      if (this.frequency[heapValue] < this.frequency[this.heap[index]]) flag--;
      else {
        this.heap[heapEntry] = this.heap[index];
        heapEntry = index;
      }
    }
    this.heap[heapEntry] = heapValue;
  }

  private buildInitialHeap(): void {
    this.heapLength = 0;
    for (let loop = 0; loop < 256; loop++) {
      if (this.frequency[loop]) this.heap[++this.heapLength] = loop;
    }
    for (let loop = this.heapLength; loop > 0; loop--) this.reheap(loop);
  }

  private buildCodeTree(): void {
    while (this.heapLength !== 1) {
      const heapValue = this.heap[1];
      this.heap[1] = this.heap[this.heapLength--];
      this.reheap(1);
      const findex = this.heapLength + 255;
      this.frequency[findex] = this.frequency[this.heap[1]] + this.frequency[heapValue];
      this.father[heapValue] = findex;
      this.father[this.heap[1]] = -findex;
      this.heap[1] = findex;
      this.reheap(1);
    }
    this.father[256] = 0;
  }

  private generateCodeTable(): boolean {
    for (let loop = 0; loop < 256; loop++) {
      if (this.frequency[loop]) {
        let currentLength = 0;
        let bitcode = 0;
        let currentBit = 1;
        let parent = this.father[loop];
        while (parent) {
          if (parent < 0) {
            bitcode = (bitcode + currentBit) >>> 0;
            parent = -parent;
          }
          parent = this.father[parent];
          currentBit = (currentBit * 2) >>> 0;
          currentLength++;
        }
        this.code[loop] = bitcode;
        if (currentLength > 32) return false;
        this.codeLength[loop] = currentLength;
      } else {
        this.code[loop] = 0;
        this.codeLength[loop] = 0;
      }
    }
    return true;
  }

  private buildDecompTree(): void {
    this.decompTree.fill(0);
    this.decompTree[1] = 1;
    let currentNode = 1;
    for (let loop = 0; loop < 256; loop++) {
      const len = this.codeLength[loop];
      if (!len) continue;
      let currentIndex = 1;
      for (let loop1 = len - 1; loop1 > 0; loop1--) {
        currentIndex = (this.decompTree[currentIndex] << 1) + ((this.code[loop] >>> loop1) & 1);
        if (!this.decompTree[currentIndex]) this.decompTree[currentIndex] = ++currentNode;
      }
      this.decompTree[(this.decompTree[currentIndex] << 1) + (this.code[loop] & 1)] = -loop;
    }
  }

  /** Huffman-encodes `H_SIZE` bytes from `in[inBase..]` into `out[outBase..]`. */
  encode(input: Uint8Array, inBase: number, out: Uint8Array, outBase: number): number {
    let thebyte = 0;
    let curbit = 7;
    let written = 0;
    for (let loop = 0; loop < H_SIZE; loop++) {
      const dvalue = input[inBase + loop];
      const currentCode = this.code[dvalue];
      const currentLength = this.codeLength[dvalue];
      for (let loop1 = currentLength - 1; loop1 >= 0; --loop1) {
        if ((currentCode >>> loop1) & 1) thebyte |= 1 << curbit;
        if (--curbit < 0) {
          out[outBase + written++] = thebyte;
          thebyte = 0;
          curbit = 7;
        }
      }
    }
    if (curbit !== 7) out[outBase + written++] = thebyte;
    return written;
  }

  writeTree(out: Uint8Array, offset: number): void {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < TREE_ENTRIES; i++) view.setInt32(offset + i * 4, this.decompTree[i], true);
  }
}

/** Uncompressed `.vmp`: per row, H_SIZE heights then H_SIZE flag bytes. */
export function saveVmp(map: VrtMap): Uint8Array {
  const sizeX = map.sizeX;
  const sizeY = map.sizeY;
  const out = new Uint8Array(sizeX * sizeY * 2);
  let p = 0;
  for (let y = 0; y < sizeY; y++) {
    const base = y * sizeX;
    out.set(map.height.subarray(base, base + sizeX), p);
    p += sizeX;
    out.set(map.meta.subarray(base, base + sizeX), p);
    p += sizeX;
  }
  return out;
}

/** Compressed `.vmc`: offset/size table, two decomp trees, per-line data. */
export function saveVmc(map: VrtMap): Uint8Array {
  const sizeX = map.sizeX;
  const sizeY = map.sizeY;

  // First pass: frequency of the delta streams (one tree for all heights, one
  // for all flags, exactly like CompressMap).
  const statH = new Int32Array(256);
  const statF = new Int32Array(256);
  for (let y = 0; y < sizeY; y++) {
    const base = y * sizeX;
    let prev = 0;
    for (let x = 0; x < sizeX; x++) {
      const v = map.height[base + x];
      statH[(v - prev) & 0xff]++;
      prev = v;
    }
    prev = 0;
    for (let x = 0; x < sizeX; x++) {
      const v = map.meta[base + x];
      statF[v ^ prev]++;
      prev = v;
    }
  }

  const encH = new HuffEncoder();
  const encF = new HuffEncoder();
  encH.build(statH);
  encF.build(statF);

  const tableBytes = sizeY * 6;
  const treeBytes = TREE_ENTRIES * 4 * 2;
  const dataStart = tableBytes + treeBytes;

  const offsets = new Int32Array(sizeY);
  const sizes = new Int16Array(sizeY);
  const chunks: Uint8Array[] = [];
  const din = new Uint8Array(2 * H_SIZE); // [0..H_SIZE) height deltas, [H_SIZE..] flag deltas
  const outTmp = new Uint8Array(H_SIZE * 4 + 8);
  let offset = dataStart;

  for (let y = 0; y < sizeY; y++) {
    const base = y * sizeX;

    let prev = 0;
    for (let x = 0; x < sizeX; x++) {
      const v = map.height[base + x];
      din[x] = (v - prev) & 0xff;
      prev = v;
    }
    prev = 0;
    for (let x = 0; x < sizeX; x++) {
      const v = map.meta[base + x];
      din[H_SIZE + x] = v ^ prev;
      prev = v;
    }

    const n1 = encH.encode(din, 0, outTmp, 0);
    const n3 = encF.encode(din, H_SIZE, outTmp, n1);
    offsets[y] = offset;
    sizes[y] = n1 + n3;
    chunks.push(outTmp.slice(0, n1 + n3));
    offset += n1 + n3;
  }

  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  for (let y = 0; y < sizeY; y++) {
    view.setInt32(y * 6, offsets[y], true);
    view.setInt16(y * 6 + 4, sizes[y], true);
  }
  encH.writeTree(out, tableBytes);
  encF.writeTree(out, tableBytes + TREE_ENTRIES * 4);
  let p = dataStart;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
