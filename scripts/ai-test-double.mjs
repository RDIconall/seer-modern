/**
 * Stand-in for the `ai` package used only by the closure-overlap tests.
 * It records the prompt the product built and returns the object the
 * product already knows how to read. It does not decide whether a title
 * matches a closure.
 */

export const Output = {
  object(options) {
    return options;
  },
};

export async function generateText(args) {
  const system = args?.system ?? "";
  const prompt = String(args?.prompt ?? "");
  const state = globalThis.__seerClosureAi ?? {};
  state.calls = state.calls ?? [];
  state.calls.push({ system, prompt });
  globalThis.__seerClosureAi = state;

  if (system.startsWith("You read a CEO's email")) {
    const payload = JSON.parse(prompt);
    const email = payload.emails?.[0];
    if (!email?.body?.includes("pricing contract")) {
      throw new Error("deep read prompt did not include the message body");
    }
    return {
      output: {
        records: [
          {
            id: email.id,
            kind: "pricing request",
            oneLine: "The sender is waiting on the pricing contract",
            ask: "Send the pricing contract",
            owner: "you",
            entities: ["Roche"],
            awaitsSignature: false,
            orgUnit: "sales — contracting",
            orgConfidence: 0.9,
            importance: 2,
            disposition: "matter",
            matterTitle: "pricing contract",
            matterWhy: "The sender is waiting on the pricing contract.",
          },
        ],
      },
    };
  }

  if (system.startsWith("You sort the disposable")) {
    return { output: { summary: "", themes: [] } };
  }

  return { output: { summary: "", matters: state.clusteredMatters ?? [] } };
}
