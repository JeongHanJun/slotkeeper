// Key-value storage behind the desk. Durable Object storage in the Worker, a Map
// in tests. `write` is all-or-nothing, which is what lets one step of work touch
// a booking, its inquiry and the log together.

export interface Store {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(prefix?: string): Promise<Map<string, T>>;
  write(puts: Record<string, unknown>, deletes?: string[]): Promise<void>;
}

export class DurableStore implements Store {
  constructor(private storage: DurableObjectStorage) {}

  async get<T>(key: string): Promise<T | null> {
    return (await this.storage.get<T>(key)) ?? null;
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.storage.put(key, value);
  }

  async list<T>(prefix = ""): Promise<Map<string, T>> {
    return this.storage.list<T>({ prefix });
  }

  async write(puts: Record<string, unknown>, deletes: string[] = []): Promise<void> {
    await this.storage.transaction(async (txn) => {
      // put() and delete() take at most 128 keys at a time.
      const entries = Object.entries(puts);
      for (let i = 0; i < entries.length; i += 128) {
        await txn.put(Object.fromEntries(entries.slice(i, i + 128)));
      }
      for (let i = 0; i < deletes.length; i += 128) {
        await txn.delete(deletes.slice(i, i + 128));
      }
    });
  }
}

export class MemoryStore implements Store {
  private data = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.data.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }

  async list<T>(prefix = ""): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const key of [...this.data.keys()].sort()) {
      if (key.startsWith(prefix)) out.set(key, JSON.parse(this.data.get(key)!) as T);
    }
    return out;
  }

  async write(puts: Record<string, unknown>, deletes: string[] = []): Promise<void> {
    for (const [key, value] of Object.entries(puts)) this.data.set(key, JSON.stringify(value));
    for (const key of deletes) this.data.delete(key);
  }
}
