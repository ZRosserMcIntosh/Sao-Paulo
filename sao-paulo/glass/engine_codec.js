// Glass Lab · the engine's calls and answers as bytes in a shared buffer, so
// the page can talk to the engine in its worker synchronously (engine_rpc.js,
// engine_worker.js). Values: undefined, null, booleans, numbers, strings,
// arrays, plain objects and Float32/Float64/Int32 arrays.
const T = { UNDEF: 0, NULL: 1, FALSE: 2, TRUE: 3, NUM: 4, STR: 5, ARR: 6, OBJ: 7, F32: 8, F64: 9, I32: 10 };
const enc = new TextEncoder(), dec = new TextDecoder();

export class Writer {
  constructor(sab) { this.sab = sab; this.dv = new DataView(sab); this.u8 = new Uint8Array(sab); this.o = 0; }
  reset() { this.o = 0; return this; }
  need(n) { if (this.o + n > this.sab.byteLength) throw new RangeError('engine answer larger than its buffer'); }
  tag(t) { this.need(1); this.dv.setUint8(this.o++, t); }
  u32(v) { this.need(4); this.dv.setUint32(this.o, v, true); this.o += 4; }
  align(a) { this.o = (this.o + a - 1) & ~(a - 1); }
  str(s) {
    // (TextEncoder cannot write into shared memory: encode, then copy.)
    const b = enc.encode(s);
    this.need(4 + b.length);
    this.dv.setUint32(this.o, b.length, true);
    this.u8.set(b, this.o + 4);
    this.o += 4 + b.length;
  }
  typed(t, a) {
    this.tag(t); this.u32(a.length); this.align(8);
    this.need(a.byteLength);
    this.u8.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), this.o);
    this.o += a.byteLength;
  }
  value(v) {
    if (v === undefined) return this.tag(T.UNDEF);
    if (v === null) return this.tag(T.NULL);
    if (v === true || v === false) return this.tag(v ? T.TRUE : T.FALSE);
    if (typeof v === 'number') { this.tag(T.NUM); this.align(8); this.need(8); this.dv.setFloat64(this.o, v, true); this.o += 8; return; }
    if (typeof v === 'string') { this.tag(T.STR); this.str(v); return; }
    if (v instanceof Float32Array) return this.typed(T.F32, v);
    if (v instanceof Float64Array) return this.typed(T.F64, v);
    if (v instanceof Int32Array) return this.typed(T.I32, v);
    if (Array.isArray(v)) { this.tag(T.ARR); this.u32(v.length); for (const x of v) this.value(x); return; }
    const keys = Object.keys(v);
    this.tag(T.OBJ); this.u32(keys.length);
    for (const k of keys) { this.str(k); this.value(v[k]); }
  }
}

export class Reader {
  constructor(sab) { this.dv = new DataView(sab); this.u8 = new Uint8Array(sab); this.o = 0; }
  reset() { this.o = 0; return this; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  align(a) { this.o = (this.o + a - 1) & ~(a - 1); }
  str() { const n = this.u32(); const s = dec.decode(this.u8.slice(this.o, this.o + n)); this.o += n; return s; }
  typed(C) {
    const n = this.u32(); this.align(8);
    const a = new C(n);
    new Uint8Array(a.buffer).set(this.u8.subarray(this.o, this.o + a.byteLength));
    this.o += a.byteLength;
    return a;
  }
  value() {
    const t = this.dv.getUint8(this.o++);
    switch (t) {
      case T.UNDEF: return undefined;
      case T.NULL: return null;
      case T.FALSE: return false;
      case T.TRUE: return true;
      case T.NUM: { this.align(8); const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
      case T.STR: return this.str();
      case T.F32: return this.typed(Float32Array);
      case T.F64: return this.typed(Float64Array);
      case T.I32: return this.typed(Int32Array);
      case T.ARR: { const n = this.u32(), a = new Array(n); for (let i = 0; i < n; ++i) a[i] = this.value(); return a; }
      case T.OBJ: { const n = this.u32(), o = {}; for (let i = 0; i < n; ++i) { const k = this.str(); o[k] = this.value(); } return o; }
      default: throw new Error('bad engine message');
    }
  }
}

// Control words (Int32 over a shared buffer).
export const C = {
  REQ: 0,     // page: bumps for each call
  RES: 1,     // worker: the call it last answered
  WANT: 2,    // page: 1 = stop between steps and wait for calls
  BUSY: 3,    // worker: 1 while it steps the engine on its own
  OK: 4,      // worker: 1 = the answer is a value, 0 = an error message
  SIZE: 8,
};
// Status read without a call (Float64 over its own shared buffer).
export const S = { TIME: 0, TARGET: 1, MS_PER_STEP: 2, SIZE: 4 };
