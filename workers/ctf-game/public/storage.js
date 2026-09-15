let database;
export function openStorage() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open('arisaka-desktop', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspaces', { keyPath: 'id' });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('存储升级被其他标签页占用')); };
  });
  return database;
}
export async function loadWorkspace(id) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspaces', 'readonly');
    const request = transaction.objectStore('workspaces').get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
export async function saveWorkspace(id, value, expectedRevision) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspaces', 'readwrite');
    const store = transaction.objectStore('workspaces');
    const request = store.get(id);
    let failure;
    request.onsuccess = () => {
      if ((request.result?.revision || 0) !== expectedRevision) {
        failure = new Error('ESTALE: 文件已在其他标签页中更改，请重新载入');
        transaction.abort(); return;
      }
      store.put({ ...value, id, revision: expectedRevision + 1 });
    };
    transaction.oncomplete = () => resolve(expectedRevision + 1);
    transaction.onerror = () => reject(failure || transaction.error || new Error('存储失败'));
    transaction.onabort = () => reject(failure || transaction.error || new Error('存储已取消'));
  });
}
