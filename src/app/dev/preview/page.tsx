import { notFound } from "next/navigation";
import { PreviewClient } from "./PreviewClient";

/**
 * A development-only harness for looking at the v2 surfaces with representative
 * data. The real app sits behind sign-in and a live mailbox, which makes the
 * layout impossible to inspect while building it. This never exists in
 * production.
 */
export default function DevPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PreviewClient />;
}
