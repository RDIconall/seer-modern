import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";
import {
  findProviderAttachmentId,
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
    let providerAttachmentId = attachmentId;

    // The corpus historically stored attachment names only, so the reader
    // emits a stable synthetic id (`messageId-index`). Resolve that id against
    // a fresh provider thread before asking for bytes; passing the synthetic
    // value to Graph/Gmail can never work.
    if (attachmentId.startsWith(`${providerMessageId}-`)) {
      const conversation = await provider.getConversation(
        owned.providerConversationId,
      );
      const resolvedId = findProviderAttachmentId(
        conversation,
        providerMessageId,
        meta,
      );
      if (!resolvedId) {
        return NextResponse.json(
          { error: "attachment not found" },
          { status: 404 },
        );
      }
      providerAttachmentId = resolvedId;
    }

    const content = await provider.getAttachment(
      providerMessageId,
      providerAttachmentId,
    );
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
