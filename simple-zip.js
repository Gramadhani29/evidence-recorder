// simple-zip.js - Pure JavaScript zero-dependency ZIP archive generator (Store method)
class SimpleZip {
  constructor() {
    this.files = [];
  }

  addFile(path, uint8Array) {
    this.files.push({
      path: path.replace(/\\/g, '/'),
      data: uint8Array instanceof Uint8Array ? uint8Array : new Uint8Array(uint8Array),
      date: new Date()
    });
  }

  static crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  static crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = SimpleZip.crcTable;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0);
  }

  static dosDateTime(d) {
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    return { time, date };
  }

  generate() {
    const encoder = new TextEncoder();
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const f of this.files) {
      const nameBytes = encoder.encode(f.path);
      const crc = SimpleZip.crc32(f.data);
      const size = f.data.length;
      const { time, date } = SimpleZip.dosDateTime(f.date);

      // Local file header (30 bytes + name)
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); // signature PK\x03\x04
      lv.setUint16(4, 20, true);         // version needed: 2.0
      lv.setUint16(6, 0x0800, true);     // flags: UTF-8 filename
      lv.setUint16(8, 0, true);          // compression: 0 (Store)
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);      // compressed size
      lv.setUint32(22, size, true);      // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);         // extra len
      local.set(nameBytes, 30);

      localHeaders.push({ local, data: f.data, offset });

      // Central directory header (46 bytes + name)
      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); // signature PK\x01\x02
      cv.setUint16(4, 20, true);         // version made by
      cv.setUint16(6, 20, true);         // version needed
      cv.setUint16(8, 0x0800, true);     // flags (UTF-8)
      cv.setUint16(10, 0, true);         // compression: 0 (Store)
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);         // extra len
      cv.setUint16(32, 0, true);         // comment len
      cv.setUint16(34, 0, true);         // disk start
      cv.setUint16(36, 0, true);         // int attr
      cv.setUint32(38, 0, true);         // ext attr
      cv.setUint32(42, offset, true);    // local header offset
      central.set(nameBytes, 46);

      centralHeaders.push(central);

      offset += local.length + f.data.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of centralHeaders) centralSize += c.length;

    // End of central directory record (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // signature PK\x05\x06
    ev.setUint16(4, 0, true);          // disk number
    ev.setUint16(6, 0, true);          // start disk
    ev.setUint16(8, this.files.length, true);  // entries on disk
    ev.setUint16(10, this.files.length, true); // total entries
    ev.setUint32(12, centralSize, true);       // size of central directory
    ev.setUint32(16, centralStart, true);      // offset of central directory
    ev.setUint16(20, 0, true);                 // comment length

    const totalSize = offset + centralSize + 22;
    const result = new Uint8Array(totalSize);
    let p = 0;
    for (const item of localHeaders) {
      result.set(item.local, p);
      p += item.local.length;
      result.set(item.data, p);
      p += item.data.length;
    }
    for (const c of centralHeaders) {
      result.set(c, p);
      p += c.length;
    }
    result.set(eocd, p);

    return result;
  }
}

if (typeof window !== 'undefined') {
  window.SimpleZip = SimpleZip;
}
if (typeof self !== 'undefined') {
  self.SimpleZip = SimpleZip;
}
