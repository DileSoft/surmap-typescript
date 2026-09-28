/**
 * VMC Huffman decoder, ported 1:1 from:
 *   src/terra/splay.cpp  (InitSplay, decompress_line1, decompress_line2, ExpandBuffer)
 *
 * A VMC line is compressed in two passes:
 *   line1 (heights) : out[i] = (out[i-1] + delta) & 0xFF
 *   line2 (flags)   : out[i] = (out[i-1] ^ delta) & 0xFF
 * Each pass expands exactly H_SIZE (=2048) bytes.
 */
import { H_SIZE } from './constants';

const TREE_ENTRIES = 512;

export class VmcDecoder {
  /** decomp_tree1/tree3 read from the file (512 int32 each). */
  readonly tree1: Int32Array;
  readonly tree3: Int32Array;
  /** delta chars stored right after each tree (computed as -tree[i], 8 bit). */
  private readonly delta1: Uint8Array;
  private readonly delta3: Uint8Array;

  constructor(source: Uint8Array, offset: number) {
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    this.tree1 = readTree(view, offset);
    this.tree3 = readTree(view, offset + TREE_ENTRIES * 4);

    // splay.cpp: decomp_tree_charN[i] = -decomp_treeN[i]  (stored as uchar)
    this.delta1 = new Uint8Array(TREE_ENTRIES);
    this.delta3 = new Uint8Array(TREE_ENTRIES);
    for (let i = 0; i < TREE_ENTRIES; i++) {
      this.delta1[i] = -this.tree1[i] & 0xff;
      this.delta3[i] = -this.tree3[i] & 0xff;
    }
  }

  /** Byte size of the two decompression trees on disk. */
  static get byteSize(): number {
    return TREE_ENTRIES * 4 * 2;
  }

  /**
   * `ExpandBuffer`: decompress one VMC line into `height` and `meta`.
   * `src`/`srcOffset` is the compressed line data; `outBase` is the destination
   * offset inside `height`/`meta` (row start).
   *
   * Returns the offset just past the consumed bytes. For a valid VMC line this
   * equals `srcOffset + sz_table[i]` (the compressor writes whole bytes for both
   * passes), so callers can use it as a self-check.
   */
  expand(
    src: Uint8Array,
    srcOffset: number,
    height: Uint8Array,
    meta: Uint8Array,
    outBase: number,
  ): number {
    const after1 = this.run(this.tree1, this.delta1, src, srcOffset, height, outBase, true);
    return this.run(this.tree3, this.delta3, src, after1, meta, outBase, false);
  }

  private run(
    tree: Int32Array,
    delta: Uint8Array,
    src: Uint8Array,
    startOffset: number,
    dst: Uint8Array,
    dstBase: number,
    add: boolean,
  ): number {
    let inOffset = startOffset;
    let cindex = 1;
    let last = 0;
    let out = dstBase;
    let count = 0;

    while (count < H_SIZE) {
      const cur = src[inOffset++];
      for (let bitshift = 7; bitshift >= 0; --bitshift) {
        cindex = (cindex << 1) + ((cur >> bitshift) & 1);
        if (tree[cindex] <= 0) {
          if (add) last = (last + delta[cindex]) & 0xff;
          else last = (last ^ delta[cindex]) & 0xff;
          dst[out++] = last;
          count++;
          if (count === H_SIZE) break;
          cindex = 1;
        } else {
          cindex = tree[cindex];
        }
      }
    }
    return inOffset;
  }
}

function readTree(view: DataView, offset: number): Int32Array {
  const tree = new Int32Array(TREE_ENTRIES);
  for (let i = 0; i < TREE_ENTRIES; i++) {
    tree[i] = view.getInt32(offset + i * 4, true);
  }
  return tree;
}
