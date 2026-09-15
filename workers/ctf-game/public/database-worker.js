import initSqlJs from '/vendor/sqlite.js';

let database, engine;
const limit = 32 * 1024 * 1024;
const value = (item) => item instanceof Uint8Array
  ? { type: 'blob', length: item.length, hex: [...item.subarray(0, 512)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
  : typeof item === 'string' ? item.slice(0, 64000) : item;
const tables = (db) => db.exec("SELECT name,type,sql FROM sqlite_schema WHERE type IN ('table','view') ORDER BY name")[0]?.values || [];
const equal = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
function configure(db) {
  const pageSize = db.exec('PRAGMA page_size')[0].values[0][0];
  db.run('PRAGMA trusted_schema=OFF; PRAGMA max_page_count=' + Math.floor(limit / pageSize));
}

self.onmessage = async (event) => {
  const { id, type, bytes, sql, readonly } = event.data || {};
  let candidate;
  try {
    if (type === 'open') {
      if (!(bytes instanceof Uint8Array) || bytes.length > limit) throw new Error('文件超过 32 MiB');
      engine ??= await initSqlJs({ locateFile: () => '/vendor/sql-wasm.wasm' });
      candidate = new engine.Database(bytes.length ? bytes : undefined);
      configure(candidate);
      const schema = tables(candidate);
      database?.close(); database = candidate; candidate = null;
      postMessage({ id, tables: schema }); return;
    }
    if (!database) throw new Error('未打开数据库');
    if (type === 'export') {
      const bytes = database.export();
      postMessage({ id, bytes }, [bytes.buffer]); return;
    }
    if (type !== 'query') throw new Error('无效操作');
    if (typeof sql !== 'string' || sql.length > 100000) throw new Error('SQL 长度无效');

    // A disposable copy protects the last completed state from canceled queries
    // and from SQL that disables query_only while the UI is in read-only mode.
    const before = database.export();
    candidate = new engine.Database(before.length ? before : undefined);
    configure(candidate);
    candidate.run('PRAGMA query_only=' + (readonly ? 'ON' : 'OFF'));
    const results = [];
    let statements = 0, output = 0;
    for (const statement of candidate.iterateStatements(sql)) {
      if (++statements > 20) throw new Error('语句数量超过限制');
      const columns = statement.getColumnNames(), rows = [];
      let truncated = false;
      while (statement.step()) {
        if (rows.length >= 2000) { truncated = true; break; }
        const row = statement.get().map(value);
        output += JSON.stringify(row).length;
        if (output > 4_000_000) { truncated = true; break; }
        rows.push(row);
      }
      results.push({ columns, rows, truncated, changes: candidate.getRowsModified() });
    }
    const after = candidate.export();
    if (after.length > limit) throw new Error('数据库超过 32 MiB');
    const changed = !equal(before, after);
    if (readonly && changed) throw new Error('只读模式不允许修改数据库');
    const schema = tables(candidate);
    if (!readonly) {
      database.close(); database = candidate; candidate = null;
      postMessage({ id, results, tables: schema, changed, bytes: after }, [after.buffer]);
    } else postMessage({ id, results, tables: schema, changed: false });
  } catch (error) {
    postMessage({ id, error: error.message || '数据库操作失败' });
  } finally { candidate?.close(); }
};
