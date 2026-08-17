import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";
import {
  resolveAttachmentMeta,
  verifyMessageOwnership,
} from "@/lib/v3/attachments/repository";
import { attachmentResponseHeaders } from "@/lib/v3/attachments/headers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Stream one attachment through the provider adapter after verifying the
 * message belongs to the active account.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  const { id: providerMessageId, attachmentId } = await context.params;
  const owned = await verifyMessageOwnership(account.id, providerMessageId);
  if (!owned) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }

  const meta = resolveAttachmentMeta(owned, attachmentId);
  try {
    const provider = await providerFor(account);
    const content = await provider.getAttachment(providerMessageId, attachmentId);
    const headers = attachmentResponseHeaders(
      content.mimeType,
      content.filename || meta.filename,
    );
    return new NextResponse(new Uint8Array(content.body), {
      headers: {
        "Content-Type": headers.contentType,
        "Content-Disposition": headers.contentDisposition,
        "X-Content-Type-Options": headers.xContentTypeOptions,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "attachment failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
