import { deflateRawSync } from 'node:zlib';

// Small valid ZIP writer for offline install fixtures (including CRC32).
export function zipFiles(files) {
  let offset = 0;
  const chunks = [], central = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), filename = Buffer.from(name), payload = deflateRawSync(data);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30), header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(payload.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
    chunks.push(local, filename, payload); central.push(header, filename);
    offset += local.length + filename.length + payload.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

export function moduleZip(id, kind = 'skill') {
  return zipFiles({
    [`${id}/${kind}.json`]: JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, entry: 'index.js', enabledByDefault: true }),
    [`${id}/index.js`]: `
      import { DATA_DIR } from '../../src/config.js';
      import * as yaml from 'js-yaml';
      import { value } from './helper.js';
      if (yaml.load('ok: true').ok !== true || !DATA_DIR || value !== 42) throw new Error('import compatibility');
      export const providers = { 'fixture.installed': () => value };
      export function setup(api) {
        api.registerTool({id:'probe', name:'Offline probe', execute:async()=>({content:String(value)})});
      }
    `,
    [`${id}/helper.js`]: 'export const value = 42;',
  });
}
