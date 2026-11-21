"use client";

/**
 * A link-only unsubscribe hands back an address chosen by the sender.
 * Nothing opens until the user has read where it goes and taps Open.
 */
export function UnsubscribePrompt({
  url,
  onConfirm,
  onDismiss,
  mobile,
}: {
  url: string;
  onConfirm: (url: string) => void;
  onDismiss: () => void;
  mobile?: boolean;
}) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* show the raw address */
  }
  return (
    <div
      role="dialog"
      aria-label="Open unsubscribe page"
      className={`fixed left-1/2 z-50 w-[min(28rem,92%)] -translate-x-1/2 rounded-md bg-[#1e242b] px-4 py-3 text-[12px] text-white shadow-lg ${
        mobile ? "bottom-[calc(8.5rem+var(--safe-bottom))]" : "bottom-20"
      }`}
    >
      <p className="font-semibold">This list only unsubscribes on its own page:</p>
      <p className="mt-1 text-[14px] font-bold">{host}</p>
      <p className="mt-0.5 break-all text-white/70">{url}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-3 py-1.5 text-white/80 hover:bg-white/10"
        >
          Don&apos;t open
        </button>
        <button
          type="button"
          onClick={() => onConfirm(url)}
          className="rounded bg-white px-3 py-1.5 font-semibold text-[#1e242b]"
        >
          Open page
        </button>
      </div>
    </div>
  );
}
