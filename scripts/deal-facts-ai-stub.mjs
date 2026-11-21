/**
 * Test stand-in for the `ai` package. buildBrief calls generateText to
 * cluster mail; the deal-fact attachment under test happens after that
 * call returns. This stub never contacts a model. The mode is read on
 * every call so one process can exercise filing and clustering.
 */

export const Output = {
  object(spec) {
    return spec;
  },
};

export async function generateText() {
  const mode = process.env.SEER_TEST_CLUSTER_MODE ?? "empty";
  if (mode === "throw") {
    throw new Error("model unavailable");
  }
  if (mode === "include") {
    const raw = process.env.SEER_TEST_MATTER_JSON;
    const matter = raw ? JSON.parse(raw) : null;
    return {
      output: {
        summary: "Grouped.",
        matters: matter ? [matter] : [],
      },
    };
  }
  return { output: { summary: "", matters: [] } };
}
