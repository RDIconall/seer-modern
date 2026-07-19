import { requireMailSession } from "@/lib/mail/session";
import { clearDecisions } from "@/lib/store/decision-cache";
import {
  clearUserProfile,
  loadUserProfile,
  PROFILE_MAX_CHARS,
  saveUserProfile,
} from "@/lib/store/user-profile";
import { NextResponse } from "next/server";

export const maxDuration = 30;

/**
 * The user's "about me" memory. GET returns it, POST saves it —
 * either pasted text or imported straight from a Google Doc URL.
 */

function docIdFromUrl(url: string): string | null {
  const m = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function textFromDoc(doc: Record<string, unknown>): string {
  // Walk the Docs API structure: body.content[].paragraph.elements[].textRun.content
  const body = doc.body as
    | { content?: Array<Record<string, unknown>> }
    | undefined;
  const out: string[] = [];
  const walk = (blocks?: Array<Record<string, unknown>>) => {
    for (const block of blocks ?? []) {
      const para = block.paragraph as
        | { elements?: Array<{ textRun?: { content?: string } }> }
        | undefined;
      if (para) {
        for (const el of para.elements ?? []) {
          if (el.textRun?.content) out.push(el.textRun.content);
        }
      }
      const table = block.table as
        | { tableRows?: Array<{ tableCells?: Array<{ content?: Array<Record<string, unknown>> }> }> }
        | undefined;
      if (table) {
        for (const row of table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) walk(cell.content);
        }
      }
    }
  };
  walk(body?.content);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

async function importGoogleDoc(
  docUrl: string,
  accessToken: string,
): Promise<{ text: string } | { error: string }> {
  const id = docIdFromUrl(docUrl);
  if (!id) {
    return { error: "That doesn't look like a Google Docs URL" };
  }

  // 1. Docs API with the user's own OAuth token (needs the Docs read
  //    scope — granted on next sign-in after this update).
  try {
    const res = await fetch(
      `https://docs.googleapis.com/v1/documents/${id}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
    );
    if (res.ok) {
      const text = textFromDoc(
        (await res.json()) as Record<string, unknown>,
      );
      if (text) return { text };
    }
  } catch {
    /* try public export next */
  }

  // 2. Public export — works when the doc is shared "anyone with link".
  try {
    const res = await fetch(
      `https://docs.google.com/document/d/${id}/export?format=txt`,
      { cache: "no-store", redirect: "follow" },
    );
    if (res.ok) {
      const text = (await res.text()).trim();
      // A sign-in interstitial means it wasn't actually public
      if (text && !/Google Docs: Sign-in/i.test(text.slice(0, 400))) {
        return { text };
      }
    }
  } catch {
    /* fall through */
  }

  return {
    error:
      "Couldn't read that doc. Either sign in again (Settings → Connect Gmail) to grant the Docs read permission, share the doc as 'Anyone with the link can view', or paste the text directly.",
  };
}

export async function GET() {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const profile = await loadUserProfile(session.email);
    return NextResponse.json({ profile, maxChars: PROFILE_MAX_CHARS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to load profile";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as {
      text?: string;
      docUrl?: string;
      clear?: boolean;
    };

    if (body.clear) {
      await clearUserProfile(session.email);
      await clearDecisions(session.email).catch(() => {});
      return NextResponse.json({ profile: null });
    }

    if (body.docUrl?.trim()) {
      const imported = await importGoogleDoc(
        body.docUrl.trim(),
        session.accessToken,
      );
      if ("error" in imported) {
        return NextResponse.json({ error: imported.error }, { status: 422 });
      }
      const profile = await saveUserProfile(session.email, {
        text: imported.text,
        source: "google-doc",
        sourceUrl: body.docUrl.trim(),
      });
      // New self-knowledge changes triage calls — re-decide everything
      await clearDecisions(session.email).catch(() => {});
      return NextResponse.json({ profile });
    }

    if (typeof body.text === "string" && body.text.trim()) {
      const profile = await saveUserProfile(session.email, {
        text: body.text,
        source: "paste",
      });
      await clearDecisions(session.email).catch(() => {});
      return NextResponse.json({ profile });
    }

    return NextResponse.json(
      { error: "Provide { text }, { docUrl } or { clear: true }" },
      { status: 400 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save profile";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
