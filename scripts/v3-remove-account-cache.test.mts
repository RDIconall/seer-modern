/**
 * Removing the signed-in mailbox must drop the inbox cache before sign-out.
 *
 * The mailbox hook writes subjects, snippets, senders, matter titles, and
 * decision summaries into localStorage. Sign out from Settings clears those
 * keys first. Removing the active account calls logout and returns before
 * that clear, and logout is a server action: it never sees the browser's
 * localStorage. The rows stay readable on that browser until some later
 * login form is submitted.
 *
 * Run:
 *   TSX_TSCONFIG_PATH="$PWD/scripts/tsconfig.react-jsx.json" \
 *     node --experimental-test-module-mocks --import tsx \
 *     scripts/v3-remove-account-cache.test.mts
 *
 * The tsconfig makes tsx compile the automatic JSX runtime these screens use.
 * Without it, Settings fails to render and this file does not reach the bug.
 */
import assert from "node:assert/strict";
import { mock } from "node:test";

const jar = new Map<string, string>();

function cookieHeader(): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

mock.module("next/headers", {
  namedExports: {
    async cookies() {
      return {
        get(name: string) {
          const value = jar.get(name);
          return value === undefined ? undefined : { name, value };
        },
        getAll() {
          return [...jar.entries()].map(([name, value]) => ({ name, value }));
        },
        set(name: string, value: string) {
          jar.set(name, value);
        },
        delete(name: string) {
          jar.delete(name);
        },
      };
    },
    async headers() {
      return new Headers({
        host: "localhost:3000",
        "x-forwarded-host": "localhost:3000",
        "x-forwarded-proto": "http",
        cookie: cookieHeader(),
      });
    },
  },
});

// Placeholder so Auth.js can seal a session for this process. Not a real secret.
process.env.AUTH_SECRET = "placeholder-auth-secret";
process.env.AUTH_URL = "http://localhost:3000";
process.env.AUTH_TRUST_HOST = "1";

const ACTIVE_MAIL = {
  subject: "Harbor settlement draft",
  snippet: "The settlement figure is in the attachment.",
  senderDisplayName: "Jordan Hale",
  decisionSummary: "Reply needed on the settlement.",
  matterTitle: "Harbor settlement",
};
const OTHER_MAIL = {
  subject: "Warehouse lease renewal",
  snippet: "The landlord wants a five-year extension.",
  senderDisplayName: "Priya Shah",
  decisionSummary: "Decide whether to renew the lease.",
  matterTitle: "Warehouse lease",
};

const OWNER_EMAIL = "cache-reader@rditrials.com";
const ACTIVE_EMAIL = "active-box@rditrials.com";
const OTHER_EMAIL = "other-box@rditrials.com";

await run();

async function linkEmbeddedPostgres(): Promise<void> {
  // npm ci --ignore-scripts skips this package's postinstall, which creates
  // libpq.so.5 and the other soname links initdb loads. The list is the
  // package's own native/pg-symlinks.json; the postinstall script applies it.
  const { access, readFile, symlink } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.join(process.cwd(), "node_modules/@embedded-postgres/linux-x64");
  const ready = path.join(root, "native/lib/libpq.so.5");
  try {
    await access(ready);
    return;
  } catch {
    // The links are absent.
  }
  const listed = JSON.parse(
    await readFile(path.join(root, "native/pg-symlinks.json"), "utf8"),
  ) as Array<{ source: string; target: string }>;
  for (const { source, target } of listed) {
    const directory = path.dirname(path.join(root, source));
    const from = path.relative(directory, path.join(root, source));
    const to = path.join(root, target);
    await symlink(from, to).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}

async function run(): Promise<void> {
  await linkEmbeddedPostgres();
  const { JSDOM } = await import("jsdom");
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { encode } = await import("@auth/core/jwt");
  const { isRedirectError } = await import(
    "next/dist/client/components/redirect-error.js"
  );
  const { startTestDb } = await import("./v2-testdb.mts");
  const accountsDb = await import("../src/lib/v2/db/accounts.ts");
  const { MAILBOX_CACHE_KEY_PREFIX } = await import(
    "../src/lib/v3/mailbox/cache.ts"
  );
  const { ACTIVE_ACCOUNT_COOKIE } = await import("../src/lib/store/accounts.ts");
  const { POST, GET } = await import("../src/app/api/v3/accounts/route.ts");
  const { logout } = await import("../src/app/actions.ts");

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost:3000/",
    pretendToBeVisual: true,
  });
  const browser = dom.window;
  // logout() is a server action. Next posts it to the server and runs it
  // there (next/dist/client/components/router-reducer/reducers/server-action-reducer.js),
  // so the browser window does not exist on that stack. A clear inside the
  // server action cannot see localStorage; the client has to clear first.
  const serverAction = () =>
    (new Error().stack ?? "").includes("/src/app/actions.ts");
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  Object.defineProperty(globals, "window", {
    configurable: true,
    get() {
      return serverAction() ? undefined : browser;
    },
  });
  Object.defineProperty(globals, "document", {
    configurable: true,
    get() {
      return serverAction() ? undefined : browser.document;
    },
  });
  globals.HTMLElement = browser.HTMLElement;
  globals.HTMLFormElement = browser.HTMLFormElement;
  globals.Element = browser.Element;
  globals.Node = browser.Node;
  globals.MouseEvent = browser.MouseEvent;
  globals.Event = browser.Event;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  browser.confirm = () => true;
  // Node's FormData rejects a jsdom form. The sign-out action reads no fields.
  const NativeFormData = globalThis.FormData;
  class CompatFormData extends NativeFormData {
    constructor(_form?: unknown) {
      super();
    }
  }
  globals.FormData = CompatFormData;
  browser.FormData = CompatFormData;

  const seen: unknown[] = [];
  const note = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", note);
  process.on("uncaughtException", note);

  const db = await startTestDb();
  try {
    const userId = await accountsDb.upsertUser(OWNER_EMAIL);
    const active = await accountsDb.upsertAccountWithCredentials({
      userId,
      provider: "microsoft",
      email: ACTIVE_EMAIL,
      displayName: "Active mailbox",
      accessToken: "placeholder-access-token",
      refreshToken: "placeholder-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    });
    const other = await accountsDb.upsertAccountWithCredentials({
      userId,
      provider: "microsoft",
      email: OTHER_EMAIL,
      displayName: "Other mailbox",
      accessToken: "placeholder-access-token",
      refreshToken: "placeholder-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    });

    const sessionToken = await encode({
      salt: "authjs.session-token",
      secret: process.env.AUTH_SECRET,
      token: {
        email: OWNER_EMAIL,
        sub: OWNER_EMAIL,
        name: "Cache Reader",
        activeAccountId: active.id,
      },
    });
    const savedSession = () => {
      jar.set("authjs.session-token", sessionToken);
      jar.set(ACTIVE_ACCOUNT_COOKIE, active.id);
    };
    savedSession();

    const listed = await GET();
    const listedBody = (await listed.json()) as {
      active?: { id?: string; email?: string };
      error?: string;
    };
    assert.equal(
      listed.status,
      200,
      `signed-in account list failed: ${listedBody.error ?? listed.status}`,
    );
    assert.equal(listedBody.active?.id, active.id);

    type MailCopy = typeof ACTIVE_MAIL;
    const copyFor = new Map<string, MailCopy>([
      [active.id, ACTIVE_MAIL],
      [other.id, OTHER_MAIL],
    ]);
    let shownActiveId = active.id;
    const removals: Array<{ status: number; body: { requiresSignOut?: boolean; error?: string } }> = [];

    globals.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (
        init?.method ??
        (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")
      ).toUpperCase();
      if (url.includes("/api/v3/accounts") && method === "POST") {
        const request = new Request("http://localhost:3000/api/v3/accounts", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: init?.body ?? null,
        });
        const response = await POST(request);
        const body = (await response.clone().json()) as {
          requiresSignOut?: boolean;
          error?: string;
        };
        removals.push({ status: response.status, body });
        return response;
      }
      if (url.includes("/api/v3/accounts")) {
        const accounts = [active, other].map((account) => ({
          id: account.id,
          provider: "microsoft" as const,
          email: account.email,
          name: account.displayName ?? account.email,
          label: "Outlook",
          active: account.id === shownActiveId,
          status: "active" as const,
        }));
        return Response.json({
          active: accounts.find((account) => account.active) ?? null,
          accounts,
          available: { google: false, microsoft: false },
          sessionError: null,
        });
      }
      if (url.includes("/api/v3/mailbox")) {
        const copy = copyFor.get(shownActiveId) ?? ACTIVE_MAIL;
        return Response.json({
          catchingUp: false,
          view: {
            accountId: shownActiveId,
            folder: "inbox",
            sort: "date",
            total: 1,
            needsYou: 1,
            nextCursor: null,
            rows: [
              {
                conversationId: "11111111-1111-4111-8111-111111111111",
                providerConversationId: "provider-thread",
                senderDisplayName: copy.senderDisplayName,
                subject: copy.subject,
                timestamp: "2026-11-01T15:00:00.000Z",
                isUnread: true,
                snippet: copy.snippet,
                attachments: [],
                decisionSummary: copy.decisionSummary,
                priority: 2,
                dueDate: null,
                matterTitle: copy.matterTitle,
                disposition: "matter",
                owner: "you",
                deleteRank: 3,
                deleteToken: null,
                category: "legal",
                vetoReasons: [],
              },
            ],
          },
        });
      }
      if (url.includes("/api/v2/operating-model")) {
        return Response.json({
          functions: [],
          topics: [],
          guidance: "",
          proposal: null,
          proposedAt: null,
          acceptedAt: null,
        });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    };

    const { useMailbox } = await import("../src/components/v3/useMailbox.ts");
    const { Settings } = await import("../src/components/v3/Settings.tsx");

    function Probe() {
      const state = useMailbox("inbox");
      return createElement(
        "p",
        { id: "mailbox-probe" },
        state.error ?? (state.loading ? "loading" : "ready"),
      );
    }

    function mailboxKeys(): string[] {
      const keys: string[] = [];
      for (let i = 0; i < browser.localStorage.length; i += 1) {
        const key = browser.localStorage.key(i);
        if (key?.startsWith(MAILBOX_CACHE_KEY_PREFIX)) keys.push(key);
      }
      return keys;
    }

    function storedRows(): Array<{
      subject?: string;
      snippet?: string;
      senderDisplayName?: string;
      decisionSummary?: string | null;
      matterTitle?: string | null;
    }> {
      const rows = [];
      for (const key of mailboxKeys()) {
        const raw = browser.localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { view?: { rows?: typeof rows } };
        for (const row of parsed.view?.rows ?? []) rows.push(row);
      }
      return rows;
    }

    function assertCacheHolds(copy: MailCopy): void {
      const rows = storedRows();
      assert.ok(
        rows.some(
          (row) =>
            row.subject === copy.subject &&
            row.snippet === copy.snippet &&
            row.senderDisplayName === copy.senderDisplayName &&
            row.decisionSummary === copy.decisionSummary &&
            row.matterTitle === copy.matterTitle,
        ),
        `expected localStorage to hold ${copy.subject}, saw ${JSON.stringify(rows)}`,
      );
    }

    function assertCacheEmpty(): void {
      const rows = storedRows();
      assert.deepEqual(
        rows,
        [],
        `mailbox rows still readable in localStorage: ${rows
          .map((row) => row.subject)
          .filter(Boolean)
          .join(", ")}`,
      );
      assert.deepEqual(mailboxKeys(), []);
    }

    async function settle(): Promise<void> {
      try {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      } catch (error) {
        // A redirect from logout rejects again inside the act() that flushes
        // the tick after it. The caller records that outcome itself.
        if (!isRedirectError(error)) throw error;
        seen.push(error);
      }
    }

    async function waitFor(label: string, ready: () => boolean): Promise<void> {
      const started = Date.now();
      while (!ready()) {
        if (Date.now() - started > 5000) {
          throw new Error(
            `timed out waiting for ${label}; probe=${browser.document.getElementById("mailbox-probe")?.textContent ?? ""}`,
          );
        }
        await settle();
      }
    }

    async function seed(accountId: string, copy: MailCopy): Promise<void> {
      shownActiveId = accountId;
      const container = browser.document.createElement("div");
      browser.document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(Probe));
      });
      try {
        await waitFor(copy.subject, () =>
          storedRows().some((row) => row.subject === copy.subject),
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
      assertCacheHolds(copy);
    }

    async function click(
      button: HTMLButtonElement,
      done: (fresh: unknown[]) => boolean,
    ): Promise<unknown> {
      const mark = seen.length;
      try {
        await act(async () => {
          button.click();
        });
      } catch (error) {
        seen.push(error);
        if (!isRedirectError(error)) throw error;
      }
      const started = Date.now();
      const fresh = () => seen.slice(mark);
      while (!done(fresh()) && Date.now() - started < 5000) await settle();
      return fresh().find((item) => isRedirectError(item));
    }

    function buttonNamed(email: string, label: string): HTMLButtonElement {
      const item = [...browser.document.querySelectorAll("li.mail-settings-account")].find(
        (node) => node.textContent?.includes(email),
      );
      const button = [...(item?.querySelectorAll("button") ?? [])].find((node) =>
        (node.textContent ?? "").includes(label),
      );
      if (!button) {
      throw new Error(
        `no ${label} button for ${email}; page says: ${browser.document.body.textContent?.replace(/\s+/g, " ").slice(0, 500)}`,
      );
    }
      return button as HTMLButtonElement;
    }

    await seed(active.id, ACTIVE_MAIL);
    await seed(other.id, OTHER_MAIL);
    assertCacheHolds(ACTIVE_MAIL);
    assertCacheHolds(OTHER_MAIL);

    let serverOutcome: unknown;
    try {
      await logout();
    } catch (error) {
      serverOutcome = error;
    }
    assert.equal(
      isRedirectError(serverOutcome),
      true,
      "sign-out ends the session by redirecting",
    );
    assertCacheHolds(ACTIVE_MAIL);
    assertCacheHolds(OTHER_MAIL);
    savedSession();

    shownActiveId = active.id;
    const settingsHost = browser.document.createElement("div");
    browser.document.body.appendChild(settingsHost);
    const settingsRoot = createRoot(settingsHost);
    await act(async () => {
      settingsRoot.render(createElement(Settings));
    });
    await waitFor("settings", () =>
      Boolean(browser.document.body.textContent?.includes(ACTIVE_EMAIL)),
    );

    const signOut = browser.document.querySelector(
      "form.mail-settings-signout button",
    );
    if (!(signOut instanceof browser.HTMLButtonElement)) {
      throw new Error("settings sign-out button was not rendered");
    }
    const signedOut = await click(signOut, (fresh) =>
      fresh.some((item) => isRedirectError(item)),
    );
    assert.equal(isRedirectError(signedOut), true, "the sign-out button redirects");
    assertCacheEmpty();
    savedSession();

    await seed(active.id, ACTIVE_MAIL);
    await seed(other.id, OTHER_MAIL);
    await act(async () => {
      settingsRoot.render(createElement(Settings));
    });
    await waitFor("settings after sign-out", () =>
      Boolean(browser.document.body.textContent?.includes(OTHER_EMAIL)),
    );
    const removalsBeforeOther = removals.length;
    const removedOther = await click(
      buttonNamed(OTHER_EMAIL, "Remove"),
      () => removals.length > removalsBeforeOther,
    );
    assert.equal(removedOther, undefined, "removing another mailbox must not sign out");
    const otherRemoval = removals.at(-1);
    assert.equal(otherRemoval?.status, 200, otherRemoval?.body.error ?? "remove failed");
    assert.equal(otherRemoval?.body.requiresSignOut, false);
    assert.equal(
      await accountsDb.getOwnedAccount(userId, other.id),
      null,
      "the other mailbox is removed on the server",
    );
    assert.ok(await accountsDb.getOwnedAccount(userId, active.id));
    assertCacheEmpty();

    await seed(active.id, ACTIVE_MAIL);
    await seed(other.id, OTHER_MAIL);
    const removalsBeforeActive = removals.length;
    const removedActive = await click(
      buttonNamed(ACTIVE_EMAIL, "Remove"),
      (fresh) =>
        removals.length > removalsBeforeActive &&
        fresh.some((item) => isRedirectError(item)),
    );
    assert.equal(
      isRedirectError(removedActive),
      true,
      "removing the active mailbox signs the browser out",
    );
    const activeRemoval = removals.at(-1);
    assert.equal(activeRemoval?.status, 200, activeRemoval?.body.error ?? "remove failed");
    assert.equal(
      activeRemoval?.body.requiresSignOut,
      true,
      "the accounts API tells the client this removal ends the session",
    );
    assert.equal(await accountsDb.getOwnedAccount(userId, active.id), null);
    assertCacheEmpty();

    console.log("v3-remove-account-cache: OK");
  } catch (error) {
    console.error(error);
    await db.stop();
    process.exit(1);
  }
  await db.stop();
}
