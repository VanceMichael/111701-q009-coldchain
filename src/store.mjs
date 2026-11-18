import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class RecordStore {
  #records = new Map();
  #path;

  constructor({ path = null } = {}) {
    this.#path = path;
  }

  static async load({ path } = {}) {
    const store = new RecordStore({ path });
    if (!path) return store;
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return store;
      throw error;
    }
    const snapshot = JSON.parse(text);
    if (!Array.isArray(snapshot.records)) {
      throw new Error('存储快照缺少 records');
    }
    for (const record of snapshot.records) {
      store.#records.set(`${record.source}:${record.id}`, structuredClone(record));
    }
    return store;
  }

  save(record) {
    const key = `${record.source}:${record.id}`;
    const previous = this.#records.get(key);
    if (!previous || record.revision >= previous.revision) {
      this.#records.set(key, structuredClone(record));
    }
    return structuredClone(this.#records.get(key));
  }

  get(source, id) {
    const record = this.#records.get(`${source}:${id}`);
    return record ? structuredClone(record) : null;
  }

  list() {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  async persist() {
    if (!this.#path) return;
    await mkdir(dirname(this.#path), { recursive: true });
    const snapshot = JSON.stringify({ records: this.list() }, null, 2);
    const temp = `${this.#path}.tmp`;
    await writeFile(temp, `${snapshot}\n`, 'utf8');
    await rename(temp, this.#path);
  }
}
