/**
 * DEX reader for package inventories. Reads only what the inventory needs:
 * the header, type_ids -> string descriptors of each class_def, and each
 * class's class_data (method count and code size).
 *
 * Size estimate: a class's "weight" is the bytes its methods' code items
 * occupy (16-byte header + 2 bytes per instruction unit + 8 per try block)
 * plus 32 bytes for its class_def and 8 bytes per field and method entry.
 * A package's share of a dex file is its weight over the file's total weight,
 * multiplied by the dex file's size. Strings, protos and annotations are not
 * attributed to a class, so the estimate spreads them by code size.
 */

export interface DexClass {
  /** Dotted class name, e.g. "io.sentry.Sentry". */
  name: string;
  methods: number;
  weight: number;
}

export interface DexSummary {
  version: string;
  classes: DexClass[];
  methodIds: number;
  totalWeight: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** Reads an unsigned LEB128 value; returns [value, nextOffset]. */
export function readUleb128(b: Uint8Array, o: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const byte = b[o++];
    if (byte === undefined) throw new Error("uleb128 past end of dex");
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, o];
    shift += 7;
  }
  throw new Error("uleb128 too long");
}

function readString(b: Uint8Array, stringIdsOff: number, idx: number): string {
  const dataOff = u32(b, stringIdsOff + idx * 4);
  const [, start] = readUleb128(b, dataOff); // utf16 length
  let end = start;
  while (end < b.length && b[end] !== 0) end++;
  // Type descriptors are ASCII in practice; MUTF-8 differences only affect
  // supplementary characters and NUL, which never appear in descriptors.
  return utf8.decode(b.subarray(start, end));
}

/** "Lcom/example/Foo$Bar;" -> "com.example.Foo$Bar" */
export function descriptorToClassName(descriptor: string): string {
  if (descriptor.startsWith("L") && descriptor.endsWith(";")) {
    return descriptor.slice(1, -1).replace(/\//g, ".");
  }
  return descriptor;
}

export function parseDex(b: Uint8Array): DexSummary {
  if (b.length < 0x70 || b[0] !== 0x64 || b[1] !== 0x65 || b[2] !== 0x78 || b[3] !== 0x0a) {
    throw new Error("not a dex file");
  }
  const version = utf8.decode(b.subarray(4, 7));
  if (u32(b, 40) !== 0x12345678) throw new Error("unsupported dex endianness");
  const stringIdsSize = u32(b, 56);
  const stringIdsOff = u32(b, 60);
  const typeIdsSize = u32(b, 64);
  const typeIdsOff = u32(b, 68);
  const methodIds = u32(b, 88);
  const classDefsSize = u32(b, 96);
  const classDefsOff = u32(b, 100);
  if (
    stringIdsOff + stringIdsSize * 4 > b.length ||
    typeIdsOff + typeIdsSize * 4 > b.length ||
    classDefsOff + classDefsSize * 32 > b.length
  ) {
    throw new Error("dex tables exceed the file");
  }

  const classes: DexClass[] = [];
  let totalWeight = 0;
  for (let i = 0; i < classDefsSize; i++) {
    const def = classDefsOff + i * 32;
    const classIdx = u32(b, def);
    if (classIdx >= typeIdsSize) continue;
    const descriptorIdx = u32(b, typeIdsOff + classIdx * 4);
    if (descriptorIdx >= stringIdsSize) continue;
    const name = descriptorToClassName(readString(b, stringIdsOff, descriptorIdx));
    const classDataOff = u32(b, def + 24);
    let methods = 0;
    let weight = 32;
    if (classDataOff !== 0 && classDataOff < b.length) {
      let p = classDataOff;
      let staticFields: number, instanceFields: number, directMethods: number, virtualMethods: number;
      [staticFields, p] = readUleb128(b, p);
      [instanceFields, p] = readUleb128(b, p);
      [directMethods, p] = readUleb128(b, p);
      [virtualMethods, p] = readUleb128(b, p);
      for (let f = 0; f < staticFields + instanceFields; f++) {
        [, p] = readUleb128(b, p);
        [, p] = readUleb128(b, p);
      }
      weight += 8 * (staticFields + instanceFields);
      methods = directMethods + virtualMethods;
      for (let m = 0; m < methods; m++) {
        let codeOff: number;
        [, p] = readUleb128(b, p);
        [, p] = readUleb128(b, p);
        [codeOff, p] = readUleb128(b, p);
        weight += 8;
        if (codeOff !== 0 && codeOff + 16 <= b.length) {
          const triesSize = u16(b, codeOff + 6);
          const insnsSize = u32(b, codeOff + 12);
          weight += 16 + insnsSize * 2 + triesSize * 8;
        }
      }
    }
    totalWeight += weight;
    classes.push({ name, methods, weight });
  }
  return { version, classes, methodIds, totalWeight };
}
