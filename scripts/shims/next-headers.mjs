if (!globalThis.__seerMailboxTestCookies) {
  globalThis.__seerMailboxTestCookies = new Map();
}

export async function cookies() {
  const jar = globalThis.__seerMailboxTestCookies;
  return {
    get(name) {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name, value) {
      jar.set(name, String(value));
    },
    delete(name) {
      jar.delete(name);
    },
  };
}

export async function headers() {
  return new Headers();
}

export function draftMode() {
  return { isEnabled: false, enable() {}, disable() {} };
}
