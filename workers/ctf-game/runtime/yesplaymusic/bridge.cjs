/* Loaded synchronously before the upstream application and its dependencies. */
(function () {
  'use strict';

  function namespace(profile) {
    if (typeof profile !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(profile)) throw new Error('Invalid YesPlayMusic profile');
    return 'arisaka/yesplaymusic/' + profile + '/';
  }

  function parseProfilePath(pathname) {
    const match = /^\/yesplaymusic\/profiles\/([a-z0-9_-]{1,64})(?:\/|$)/.exec(pathname);
    const profile = match ? match[1] : (pathname === '/yesplaymusic/' || pathname === '/yesplaymusic') ? 'default' : null;
    namespace(profile);
    return { profile: profile, basePath: '/yesplaymusic/profiles/' + profile + '/' };
  }

  function createProfileStorage(storage, profile) {
    const prefix = namespace(profile);
    const get = storage.getItem.bind(storage);
    const set = storage.setItem.bind(storage);
    const remove = storage.removeItem.bind(storage);
    const key = storage.key.bind(storage);
    function keys() {
      const result = [];
      for (let index = 0; index < storage.length; index++) {
        const name = key(index);
        if (name && name.startsWith(prefix)) result.push(name.slice(prefix.length));
      }
      return result;
    }
    const methods = {
      getItem: name => get(prefix + String(name)),
      setItem: (name, value) => set(prefix + String(name), String(value)),
      removeItem: name => remove(prefix + String(name)),
      key: index => keys()[Number(index) >>> 0] ?? null,
      clear: () => keys().forEach(name => remove(prefix + name)),
    };
    return new Proxy(Object.create(Object.getPrototypeOf(storage)), {
      get: function (target, name) {
        if (name === 'length') return keys().length;
        if (Object.prototype.hasOwnProperty.call(methods, name)) return methods[name];
        if (name === Symbol.toStringTag) return 'Storage';
        if (typeof name === 'symbol') return Reflect.get(target, name);
        const value = methods.getItem(name);
        return value === null ? Reflect.get(target, name) : value;
      },
      set: function (target, name, value) {
        if (typeof name === 'symbol') return Reflect.set(target, name, value);
        methods.setItem(name, value);
        return true;
      },
      deleteProperty: function (_target, name) { methods.removeItem(name); return true; },
      ownKeys: keys,
      has: function (target, name) { return name === 'length' || name in methods || methods.getItem(name) !== null || name in target; },
      getOwnPropertyDescriptor: function (_target, name) {
        const value = methods.getItem(name);
        return value === null ? undefined : { configurable: true, enumerable: true, writable: true, value: value };
      },
      defineProperty: function (_target, name, descriptor) {
        if (!('value' in descriptor)) throw new TypeError('Storage values must be strings');
        methods.setItem(name, descriptor.value);
        return true;
      },
    });
  }

  function createProfileIndexedDB(factory, profile) {
    const prefix = namespace(profile);
    return new Proxy(factory, {
      get: function (target, name) {
        if (name === 'open' || name === 'deleteDatabase') {
          return function (database, ...args) { return target[name](prefix + String(database), ...args); };
        }
        if (name === 'databases' && typeof target.databases === 'function') {
          return async function () {
            return (await target.databases()).filter(item => item.name && item.name.startsWith(prefix))
              .map(item => ({ ...item, name: item.name.slice(prefix.length) }));
          };
        }
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function isTrustedParent(candidate, configured, runtimeOrigin) {
    try {
      const parentURL = new URL(candidate);
      const appURL = new URL(runtimeOrigin);
      if (parentURL.origin !== candidate || parentURL.username || parentURL.password) return false;
      if (parentURL.protocol === 'https:' && candidate === configured) return true;
      return parentURL.protocol === 'http:' && parentURL.hostname === '127.0.0.1'
        && appURL.protocol === 'http:' && appURL.hostname === '127.0.0.1';
    } catch (_) { return false; }
  }

  function installBridge(target) {
    const profile = parseProfilePath(target.location.pathname);
    // Keep the real handles private: a reset from the upstream app can only
    // enumerate or clear the selected profile, including legacy DB migration.
    Object.defineProperty(target, 'localStorage', { configurable: false, value: createProfileStorage(target.localStorage, profile.profile) });
    Object.defineProperty(target, 'sessionStorage', { configurable: false, value: createProfileStorage(target.sessionStorage, profile.profile) });
    Object.defineProperty(target, 'indexedDB', { configurable: false, value: createProfileIndexedDB(target.indexedDB, profile.profile) });

    const params = new URLSearchParams(target.location.hash.slice(1));
    const requestedParent = params.get('parent');
    const channel = params.get('channel') || '';
    let parentOrigin = null;
    let latestReport = null;
    let running = false;
    const report = function (phase, message) {
      if (!['loading', 'running', 'error'].includes(phase)) return;
      if (phase === 'running') running = true;
      latestReport = { type: 'arisaka:runtime', app: 'yesplaymusic', channel: channel, phase: phase, message: String(message || '').slice(0, 250) };
      if (parentOrigin) target.parent.postMessage(latestReport, parentOrigin);
    };
    const result = Object.freeze({ ...profile, report: report });
    Object.defineProperty(target, '__ARISAKA_MUSIC__', { configurable: false, value: result });

    if (params.has('parent') || params.has('channel')) {
      target.history.replaceState(target.history.state, '', target.location.pathname + target.location.search);
    }
    if (target.location.pathname === '/yesplaymusic/' || target.location.pathname === '/yesplaymusic') {
      target.history.replaceState(target.history.state, '', profile.basePath + target.location.search);
    }
    target.addEventListener('error', function () {
      if (!running) report('error', 'YesPlayMusic 启动失败，请重新打开。');
    });
    report('loading', '正在启动 YesPlayMusic…');
    if (target.parent !== target && /^[a-zA-Z0-9_-]{16,100}$/.test(channel) && requestedParent) {
      target.fetch('/runtime-policy.json', { credentials: 'omit', cache: 'no-store', redirect: 'error' })
        .then(response => response.ok ? response.json() : null)
        .then(policy => {
          if (!policy || !isTrustedParent(requestedParent, policy.desktopOrigin, target.location.origin)) return;
          parentOrigin = requestedParent;
          if (latestReport) target.parent.postMessage(latestReport, parentOrigin);
        }).catch(function () { /* Running standalone remains possible if policy is unavailable. */ });
    }
    return result;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseProfilePath, createProfileStorage, createProfileIndexedDB, isTrustedParent, installBridge };
  } else {
    installBridge(window);
  }
}());
