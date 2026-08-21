"use client";

import * as React from "react";
import { MessageHtml } from "@/components/v2/MessageHtml";

/**
 * One safe renderer for every mail surface. The implementation sanitizes,
 * blocks remote images, and isolates HTML in a sandboxed iframe.
 */
export function MailReader({
  html,
  text,
  className,
}: {
  html: string | null | undefined;
  text: string | null | undefined;
  className?: string;
}) {
  return (
    <div className={className}>
      <MessageHtml html={html ?? null} text={text ?? null} />
    </div>
  );
}
