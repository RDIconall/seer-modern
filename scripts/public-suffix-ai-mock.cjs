/**
 * CJS stand-in for the `ai` package. tsx loads the brief builder through
 * require(), so this is the instance buildBrief and the test share.
 *
 * generateText stands in for the clustering model only. The default
 * result is an empty matter list, which is the leftover path the
 * automated collapse runs on. A test can replace the handler.
 */

let handler = async () => ({
  output: { summary: "", matters: [], themes: [] },
});

function setGenerateText(next) {
  handler = next;
}

async function generateText(args) {
  return handler(args);
}

const Output = {
  object() {
    return { schema: "test-output" };
  },
};

module.exports = { setGenerateText, generateText, Output };
