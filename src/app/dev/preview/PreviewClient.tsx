"use client";

import { MailClient } from "@/components/v3/MailClient";
import { v3Preview } from "./v3-sample";

/** Dev harness: V3 folder, reader, compose, and Atlas states. */
export function PreviewClient() {
  return (
    <MailClient preview={v3Preview} />
  );
}
